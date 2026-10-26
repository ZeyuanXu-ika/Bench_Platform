import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const fixtures = path.join(root, '.tools', 'browser-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
execFileSync(process.env.PYTHON_EXECUTABLE || 'python', ['-c',
  'import sys,zipfile;from pathlib import Path;r=Path(sys.argv[2]).resolve();z=zipfile.ZipFile(sys.argv[1]);assert all((r/i.filename).resolve().is_relative_to(r) for i in z.infolist());z.extractall(r)',
  path.join(root, 'samples', 'demo-task.zip'), fixtures]);
const taskDir = path.join(fixtures, 'demo-task');
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const browsers = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(browsers)) for (const dir of fs.readdirSync(browsers).sort().reverse()) {
    const candidate = path.join(browsers, dir, 'chrome-win64', 'chrome.exe');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
  }
}
const origin = process.env.BASE_URL || 'http://127.0.0.1:8787/';
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
const errors = []; const traffic = []; const checks = [];
page.on('pageerror', e => errors.push(e.message));
context.on('request', req => traffic.push({ method: req.method(), url: req.url() }));
const check = (name) => { checks.push(name); console.log('PASS:', name); };
try {
  await page.goto(origin); await page.waitForSelector('#welcome:not([hidden])');
  await page.screenshot({ path: path.join(artifacts, 'welcome-full.png'), fullPage: true });
  await page.locator('#manifest-input').setInputFiles(path.join(taskDir, 'tasks.json'));
  await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  assert.equal(await page.locator('#batch-id').inputValue(), 'demo_batch');
  await page.locator('#play-toggle').click();
  await page.waitForFunction(() => document.getElementById('video').currentTime > 0);
  await page.locator('#play-toggle').click();
  assert.ok(await page.locator('#video').evaluate(v => v.currentSrc.startsWith('blob:')));
  check('manifest + local folder import + real local video playback');

  async function makeSegment(kind, start, end, observation) {
    await page.locator(`#${kind}`).evaluate((media, t) => { media.currentTime = t; }, start);
    await page.locator('#mark-start').click();
    await page.locator(`#${kind}`).evaluate((media, t) => { media.currentTime = t; }, end);
    await page.locator('#mark-end').click(); await page.locator('#add-segment').click();
    await page.locator('#subject-id').fill('unknown'); await page.locator('#observation').fill(observation);
    await page.locator('#evidence-role').selectOption('event_support');
    await page.locator('#uncertainty').fill('合成测试素材。');
  }
  await makeSegment('video', 1, 3, '浏览器验证：视频色块在 1–3 秒可见。');
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => document.getElementById('item-kind').textContent === 'AUDIO EVIDENCE' && document.getElementById('audio').readyState >= 2);
  await page.locator('#play-toggle').click(); await page.waitForFunction(() => document.getElementById('audio').currentTime > 0); await page.locator('#play-toggle').click();
  assert.ok(await page.locator('#audio').evaluate(a => a.currentSrc.startsWith('blob:')));
  await makeSegment('audio', 2, 4, '浏览器验证：2–4 秒可听到测试音。');
  await page.locator('#waveform-button').click(); await page.waitForSelector('#waveform:not([hidden])');
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => document.getElementById('progress-label').textContent.startsWith('2 / 2'));
  check('video/audio intervals, question fields, waveform and task completion');

  await page.evaluate(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }); });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-result').click()]);
  const exportPath = path.join(artifacts, 'browser-roundtrip.json'); await download.saveAs(exportPath);
  const payload = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const normalized = parseResults(payload);
  assert.equal(normalized.records.video_demo_1.status, 'complete');
  assert.equal(normalized.records.audio_demo_1.status, 'complete');
  assert.equal(normalized.records.video_demo_1.segments[0].start_time, 1);
  assert.equal(normalized.records.audio_demo_1.segments[0].end_time, 4);
  assert.equal(normalized.records.video_demo_1.segments[0].annotations.observation, '浏览器验证：视频色块在 1–3 秒可见。');
  assert.ok(!fs.readFileSync(exportPath, 'utf8').includes('base64'));
  check('actual JSON file download with complete independent audio/video records');

  await page.reload(); await page.waitForFunction(() => document.getElementById('progress-label').textContent.startsWith('2 / 2'));
  assert.equal(await page.locator('#media-empty').isVisible(), true);
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：2–4 秒可听到测试音。');
  await page.locator('.task-item').first().click(); await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：视频色块在 1–3 秒可见。');
  assert.equal(await page.locator('#evidence-role').inputValue(), 'event_support');
  check('browser draft survives reload and details survive task switching');

  await page.locator('#result-input').setInputFiles(exportPath);
  await page.waitForFunction(() => document.getElementById('item-kind').textContent === 'VIDEO EVIDENCE');
  await page.locator('#folder-input').setInputFiles(taskDir); await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：视频色块在 1–3 秒可见。');
  await page.locator('#new-segment').click(); await makeSegment('video', 5, 6, '浏览器验证：恢复后新增片段。');
  assert.equal(await page.locator('.segment-row').count(), 2);
  check('result reimport preserves details and allows adding another segment');

  await page.evaluate(() => {
    window.__nativeTest = { body: null, closed: false };
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({ name: 'native-contract.json', createWritable: async () => ({ write: async body => { window.__nativeTest.body = body; }, close: async () => { window.__nativeTest.closed = true; } }) }) });
  });
  await page.locator('#export-result').click(); await page.waitForFunction(() => window.__nativeTest.closed);
  const native = await page.evaluate(() => JSON.parse(window.__nativeTest.body));
  assert.equal(native.items[0].segments.length, 2);
  assert.equal(new Set(native.items[0].segments.map(s => s.id)).size, 2);
  check('native save API write/close contract (system dialog mocked)');

  await page.locator('#task-notes').fill('测试取消导出后仍有未导出修改');
  await page.evaluate(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => { throw new DOMException('cancelled', 'AbortError'); } }); });
  await page.locator('#export-result').click(); await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已取消导出'));
  assert.equal(await page.locator('#export-result').isEnabled(), true);
  check('cancelled file picker does not report a saved file or disable retry');
  const [explicitDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  await explicitDownload.saveAs(path.join(artifacts, 'explicit-download.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'explicit-download.json'), 'utf8')).items[0].segments.length, 2);
  check('explicit browser download works even when native file picker is unavailable');

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存'));
  await context.setOffline(true); await page.reload(); await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir); await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：视频色块在 1–3 秒可见。');
  check('cached application reload and local media restore work offline');
  await context.setOffline(false);

  const secondTab = await context.newPage(); await secondTab.goto(origin);
  await secondTab.waitForSelector('#workspace:not([hidden])');
  await secondTab.locator('#task-notes').fill('NEW_TAB_NOTE');
  await secondTab.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存浏览器'));
  await page.locator('#task-notes').fill('STALE_TAB_NOTE');
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('另一个标签页'));
  await secondTab.reload(); await secondTab.waitForSelector('#workspace:not([hidden])');
  assert.equal(await secondTab.locator('#task-notes').inputValue(), 'NEW_TAB_NOTE');
  await secondTab.close();
  check('stale browser tabs cannot overwrite another tab\'s newer draft');

  await page.screenshot({ path: path.join(artifacts, 'workspace-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'workspace-mobile.png'), fullPage: true });
  check('mobile layout has no horizontal overflow');

  const hostile = path.join(fixtures, 'untrusted.json');
  fs.writeFileSync(hostile, JSON.stringify({ schema_version: '1.0', batch_id: 'security', assignment_id: 'security_A', annotator_id: 'ann01', items: [{ id: 'safe_id', title: '<img src=https://invalid.example/x onerror=alert(1)>', media_path: 'demo.mp4' }] }));
  await page.locator('#manifest-input').setInputFiles(hostile);
  await page.waitForFunction(() => document.getElementById('item-title').textContent.startsWith('<img'));
  assert.equal(await page.locator('#item-title img').count(), 0);
  fs.writeFileSync(hostile, JSON.stringify({ items: [{ id: 'remote', media_path: 'https://invalid.example/movie.mp4' }] }));
  await page.locator('#manifest-input').setInputFiles(hostile);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('相对路径'));
  assert.ok((await page.locator('#item-title').textContent()).startsWith('<img'));
  check('HTML-like text remains text and remote media paths are rejected atomically');

  assert.deepEqual(errors, []);
  assert.ok(traffic.every(r => r.method === 'GET' && (r.url.startsWith(new URL(origin).origin + '/') || r.url.startsWith('blob:'))), JSON.stringify(traffic));
  check('no application errors, no upload requests and no third-party resource requests');
  fs.writeFileSync(path.join(artifacts, 'browser-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, request_count: traffic.length, errors, limitations: ['Native operating system save dialog is mocked; actual download fallback is verified', 'No Feishu upload automation; user submits exported JSON', 'No 50-person backend load test applies to this per-browser local app'] }, null, 2));
  console.log(`Browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Browser verification FAILED:', error);
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
