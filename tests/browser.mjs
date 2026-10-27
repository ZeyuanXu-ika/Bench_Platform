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
async function assertEmptyStartup(targetPage = page) {
  await targetPage.waitForSelector('#welcome:not([hidden])');
  assert.equal(await targetPage.locator('#workspace').isVisible(), false);
  assert.equal(await targetPage.locator('.task-item').count(), 0);
  assert.equal(await targetPage.locator('#video').getAttribute('src'), null);
  assert.equal(await targetPage.locator('#audio').getAttribute('src'), null);
  assert.equal(await targetPage.locator('#welcome a[href*="samples/"]').count(), 0);
}
async function restoreLatest(targetPage = page) {
  await assertEmptyStartup(targetPage);
  await targetPage.locator('#welcome-drafts').click();
  await targetPage.waitForSelector('#draft-dialog[open]');
  await targetPage.locator('.draft-row').first().click();
  await targetPage.waitForSelector('#workspace:not([hidden])');
}
try {
  await page.goto(origin); await page.waitForSelector('#welcome:not([hidden])');
  await assertEmptyStartup();
  await page.locator('#welcome-drafts').click();
  await page.waitForSelector('#draft-dialog[open]');
  assert.equal(await page.locator('.draft-row').count(), 0);
  await page.locator('#draft-dialog .close-dialog').click();
  check('empty startup requires explicit import or draft restoration and contains no demo tasks or media');
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
    await page.locator('#play-toggle').focus(); await page.keyboard.press('[');
    await page.locator(`#${kind}`).evaluate((media, t) => { media.currentTime = t; }, end);
    await page.keyboard.press(']'); await page.locator('#add-segment').click();
    await page.locator('#segment-category').selectOption(kind === 'video' ? 'visual_observation' : 'acoustic_observation');
    await page.locator('#subject-id').fill('unknown'); await page.locator('#observation').fill(observation);
    await page.locator('#evidence-role').selectOption('event_support');
    await page.locator('#local-fact').fill('局部事实：' + observation);
  }
  await makeSegment('video', 1, 3, '浏览器验证：视频色块在 1–3 秒可见。');
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => !document.getElementById('audio-stage').hidden && document.getElementById('audio').readyState >= 2);
  await page.locator('#play-toggle').click(); await page.waitForFunction(() => document.getElementById('audio').currentTime > 0); await page.locator('#play-toggle').click();
  assert.ok(await page.locator('#audio').evaluate(a => a.currentSrc.startsWith('blob:')));
  await makeSegment('audio', 2, 4, '浏览器验证：2–4 秒可听到测试音。');
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => document.getElementById('progress-label').textContent.startsWith('2 / 2'));
  check('video/audio intervals, annotation fields and task completion');

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

  await page.reload(); await restoreLatest(); await page.waitForFunction(() => document.getElementById('progress-label').textContent.startsWith('2 / 2'));
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
  await page.waitForFunction(() => document.querySelector('.task-item.active .task-meta').textContent.includes('video_demo_1'));
  await page.locator('#folder-input').setInputFiles(taskDir); await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：视频色块在 1–3 秒可见。');
  await makeSegment('video', 5, 6, '浏览器验证：恢复后新增片段。');
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

  await page.locator('#assignment-id').fill('测试取消导出后仍有未导出修改');
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
  await context.setOffline(true); await page.reload(); await restoreLatest(); await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir); await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '浏览器验证：视频色块在 1–3 秒可见。');
  check('cached application reload and local media restore work offline');
  await context.setOffline(false);

  const secondTab = await context.newPage(); await secondTab.goto(origin); await restoreLatest(secondTab);
  await secondTab.waitForSelector('#workspace:not([hidden])');
  await secondTab.locator('#assignment-id').fill('NEW_TAB_NOTE');
  await secondTab.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存浏览器'));
  await page.locator('#assignment-id').fill('STALE_TAB_NOTE');
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('另一个标签页'));
  await secondTab.reload(); await restoreLatest(secondTab); await secondTab.waitForSelector('#workspace:not([hidden])');
  assert.equal(await secondTab.locator('#assignment-id').inputValue(), 'NEW_TAB_NOTE');
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

  // Verify the frame-first workflow independently from the keyboard workflow.
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('#manifest-input').setInputFiles(path.join(taskDir, 'tasks.json'));
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  const draw = page.locator('#timeline-draw'); await draw.scrollIntoViewIfNeeded();
  const bounds = await draw.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + 20);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + 20, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.segment-row').length === 1);
  assert.equal(await page.locator('#segment-category').inputValue(), 'unclassified');
  await page.locator('#subject-id').fill('person_1');
  await page.locator('#observation').fill('同一区间的独立观察');
  await page.locator('#evidence-role').selectOption('event_support');
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('归属类别'));
  await page.locator('#segment-category').selectOption('visual_observation');
  const originalTime = await page.locator('#detail-time').textContent();
  await page.locator('#add-segment').click();
  assert.equal(await page.locator('.segment-row').count(), 2);
  assert.equal(await page.locator('#detail-time').textContent(), originalTime);
  assert.equal(await page.locator('#segment-category').inputValue(), 'unclassified');
  assert.equal(await page.locator('#observation').inputValue(), '');
  assert.equal(await page.locator('#local-fact').inputValue(), '');
  await page.locator('#subject-id').fill('person_2');
  await page.locator('#evidence-role').selectOption('event_support');
  await page.locator('#local-fact').fill('第二时间窗的局部事实');
  await page.locator('#segment-category').selectOption('speech_content');
  await page.locator('#observation').fill('副本的言语内容');
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#segment-category').inputValue(), 'visual_observation');
  assert.equal(await page.locator('#observation').inputValue(), '同一区间的独立观察');
  assert.equal(await page.locator('.timeline-lane').count(), 2);
  const [framesDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const framesPath = path.join(artifacts, 'timeline-frames.json'); await framesDownload.saveAs(framesPath);
  const frames = parseResults(JSON.parse(fs.readFileSync(framesPath, 'utf8'))).records.video_demo_1.segments;
  assert.notEqual(frames[0].id, frames[1].id); assert.equal(frames[0].start_time, frames[1].start_time);
  assert.equal(frames[0].end_time, frames[1].end_time);
  assert.deepEqual(frames.map(s => s.label), ['visual_observation', 'speech_content']);
  assert.equal(frames[1].annotations.local_fact, '第二时间窗的局部事实');
  check('drag/create -> vertical category-colored list -> independent empty window -> export preserves overlapping windows');

  const readTimes = async () => ({ start: Number(await page.locator('#segment-start').inputValue()), end: Number(await page.locator('#segment-end').inputValue()) });
  const beforeMove = await readTimes();
  const activeFrame = page.locator('.timeline-segment.active');
  const laneWidth = await activeFrame.evaluate(b => b.parentElement.getBoundingClientRect().width);
  const pixelSecond = laneWidth / 12;
  async function dragFrame(target, dx, cancel = false) {
    const playhead = await page.locator('#video').evaluate(video => video.currentTime);
    await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 8 });
    const edge = await target.getAttribute('data-edge');
    await page.waitForFunction(mode => {
      const video = document.getElementById('video');
      const time = Number(document.getElementById(mode === 'end' ? 'segment-end' : 'segment-start').value);
      return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < .03;
    }, edge);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (cancel) await page.waitForFunction(time => !document.getElementById('video').seeking && Math.abs(document.getElementById('video').currentTime - time) < .03, playhead);
  }
  await dragFrame(activeFrame, pixelSecond * .6);
  const afterMove = await readTimes();
  assert.ok(Math.abs(afterMove.start - beforeMove.start - .6) < .03);
  assert.ok(Math.abs(afterMove.end - afterMove.start - (beforeMove.end - beforeMove.start)) < .003);
  assert.equal(await page.locator('.segment-row').count(), 2);
  assert.equal(await page.locator('#segment-category').inputValue(), 'visual_observation');
  await page.locator('.segment-row').last().click(); assert.equal(await page.locator('#detail-time').textContent(), originalTime);
  await page.locator('.segment-row').first().click();
  await dragFrame(page.locator('.timeline-handle-start'), pixelSecond * .4);
  const afterStart = await readTimes();
  assert.ok(Math.abs(afterStart.start - afterMove.start - .4) < .03); assert.equal(afterStart.end, afterMove.end);
  await dragFrame(page.locator('.timeline-handle-end'), pixelSecond * .5);
  const afterEnd = await readTimes();
  assert.equal(afterEnd.start, afterStart.start); assert.ok(Math.abs(afterEnd.end - afterStart.end - .5) < .03);
  await dragFrame(activeFrame, pixelSecond * .3, true); assert.deepEqual(await readTimes(), afterEnd);
  await dragFrame(activeFrame, -laneWidth); const atLeft = await readTimes();
  assert.equal(atLeft.start, 0); assert.ok(Math.abs(atLeft.end - (afterEnd.end - afterEnd.start)) < .003);
  await dragFrame(activeFrame, laneWidth); const atRight = await readTimes();
  assert.equal(atRight.end, 12);
  assert.ok(Math.abs(atRight.end - atRight.start - (afterEnd.end - afterEnd.start)) < .003);
  const [editedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const editedPath = path.join(artifacts, 'timeline-edited.json'); await editedDownload.saveAs(editedPath);
  const editedFrames = parseResults(JSON.parse(fs.readFileSync(editedPath, 'utf8'))).records.video_demo_1.segments;
  assert.ok(Math.abs(editedFrames[0].start_time - atRight.start) < .001); assert.equal(editedFrames[0].end_time, 12);
  assert.equal(editedFrames[1].start_time, frames[1].start_time); assert.equal(editedFrames[1].end_time, frames[1].end_time);
  check('selected window dragging previews decoded video before release; bounds, resizing, Esc restoration and independent export');

  assert.equal(await page.locator('#mark-start,#mark-end,#duplicate-segment,#uncertainty,#fact-notes,#task-notes').count(), 0);
  assert.equal(await page.locator('#add-segment').textContent(), '新建时间窗');
  const categoryBox = await page.locator('.category-column').boundingBox();
  const contentBox = await page.locator('.content-column').boundingBox();
  assert.ok(contentBox.x >= categoryBox.x + categoryBox.width);
  const listBoxes = await page.locator('.segment-row').evaluateAll(rows => rows.map(row => ({ y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height, color: getComputedStyle(row).backgroundColor })));
  assert.ok(listBoxes[1].y >= listBoxes[0].y + listBoxes[0].height);
  assert.notEqual(listBoxes[0].color, listBoxes[1].color);
  await page.locator('#segment-start').fill('1'); await page.locator('#segment-start').press('Tab');
  await page.locator('#segment-end').fill('3'); await page.locator('#segment-end').press('Tab');
  assert.equal(await page.locator('.segment-row').count(), 2);
  assert.deepEqual(await readTimes(), { start: 1, end: 3 });
  await page.locator('#local-fact').fill('时间修改后保留的局部事实');
  await page.locator('#add-segment').click();
  assert.equal(await page.locator('.segment-row').count(), 3);
  assert.equal(await page.locator('#local-fact').inputValue(), '');
  assert.equal(await page.locator('#observation').inputValue(), '');
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#delete-segment').click();
  assert.equal(await page.locator('.segment-row').count(), 3);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#delete-segment').click();
  assert.equal(await page.locator('.segment-row').count(), 2);
  assert.equal(await page.locator('#delete-segment').isDisabled(), true);
  await page.locator('.segment-row').first().click();
  assert.deepEqual(await readTimes(), { start: 1, end: 3 });
  assert.equal(await page.locator('#local-fact').inputValue(), '时间修改后保留的局部事实');
  check('simplified controls, automatic numeric time edits, category colors, horizontal annotation columns and selected-window deletion');

  await page.locator('#settings-button').click();
  await page.locator('#setting-height').selectOption('420');
  await page.locator('#setting-fit').selectOption('contain');
  await page.locator('#setting-speed').selectOption('1.5');
  await page.locator('#setting-step').selectOption('0.5');
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存'));
  await page.reload(); await restoreLatest();
  await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.deepEqual(await readTimes(), { start: 1, end: 3 });
  assert.equal(await page.locator('#local-fact').inputValue(), '时间修改后保留的局部事实');
  assert.equal(await page.locator('.media-stage').evaluate(e => e.getBoundingClientRect().height), 420);
  assert.equal(await page.locator('#video').evaluate(v => v.playbackRate), 1.5);
  assert.equal(await page.locator('#playback-rate').inputValue(), '1.5');
  await page.locator('#video').evaluate(v => { v.currentTime = 1; });
  await page.locator('#step-forward').click();
  assert.ok(Math.abs(await page.locator('#video').evaluate(v => v.currentTime) - 1.04) < .02);
  await page.locator('#next-item').click();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('#audio').evaluate(v => { v.currentTime = 1; });
  await page.locator('#step-forward').click();
  assert.ok(Math.abs(await page.locator('#audio').evaluate(v => v.currentTime) - 1.5) < .02);
  await page.locator('#previous-item').click();
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').last().click();
  assert.equal(await page.locator('#local-fact').inputValue(), '第二时间窗的局部事实');
  await page.locator('#settings-button').click();
  await page.locator('#reset-settings').click(); await page.locator('#save-settings').click();
  await page.screenshot({ path: path.join(artifacts, 'local-frame-workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('local display/playback/step preferences persist and readable frame layout fits mobile');

  // Direct imports append missing media and keep the existing queue and annotations.
  await page.setViewportSize({ width: 1500, height: 1000 });
  const mp3Path = path.join(root, 'tests', 'fixtures', 'tone.mp3');
  const mp4Path = path.join(taskDir, 'media', 'demo.mp4');
  assert.equal(await page.locator('#waveform-button,#waveform,.local-badge,#item-kind,#item-id,#item-status,.window-list-hint').count(), 0);
  assert.equal(await page.locator('#draft-status').isVisible(), false);
  assert.equal(await page.locator('#settings-button').textContent(), '设置');
  assert.equal(await page.locator('.sidebar #attach-media,.sidebar #export-result').count(), 2);
  const previousCount = await page.locator('.task-item').count();
  const previousIdentity = await page.locator('#batch-id').inputValue();
  await page.locator('#media-input').setInputFiles(mp3Path);
  await page.waitForFunction(count => document.querySelectorAll('.task-item').length === count, previousCount + 1);
  await page.locator('.task-item').filter({ hasText: 'tone.mp3' }).click();
  await page.waitForFunction(() => !document.getElementById('audio-stage').hidden && document.getElementById('audio').readyState >= 2);
  assert.equal(await page.locator('#item-title').textContent(), 'tone.mp3');
  assert.equal(await page.locator('.task-item').count(), previousCount + 1);
  assert.equal(await page.locator('#batch-id').inputValue(), previousIdentity);
  assert.equal(await page.locator('.task-item.active').getAttribute('data-media-type'), 'audio');
  await page.locator('#play-toggle').click(); await page.waitForFunction(() => document.getElementById('audio').currentTime > 0); await page.locator('#play-toggle').click();
  await page.locator('#assignment-id').fill('direct_audio'); await page.locator('#annotator-id').fill('ann_mp3');
  await makeSegment('audio', .5, 2, 'MP3 独立导入后可标注');
  await page.locator('#complete-item').click();
  const [mp3Download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const mp3Result = path.join(artifacts, 'direct-mp3.json'); await mp3Download.saveAs(mp3Result);
  const mp3Export = JSON.parse(fs.readFileSync(mp3Result, 'utf8'));
  const audioExport = mp3Export.items.find(i => i.id === 'tone.mp3');
  assert.equal(audioExport.media_type, 'audio'); assert.equal(audioExport.status, 'complete');
  assert.equal(audioExport.segments[0].start_time, .5); assert.equal(audioExport.segments[0].end_time, 2);
  assert.equal(mp3Export.items.find(i => i.id === 'video_demo_1').segments[0].annotations.local_fact, '时间修改后保留的局部事实');
  await page.reload(); await restoreLatest(); await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#attach-input').setInputFiles(mp3Path);
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), 'MP3 独立导入后可标注');
  check('real MP3 direct import from an existing video queue, playback, annotation, export and draft reattachment');

  await page.locator('#media-input').setInputFiles([mp3Path, mp4Path]);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('跳过 2'));
  assert.equal(await page.locator('.task-item').count(), previousCount + 1);
  const mediaColors = await page.locator('.task-item').evaluateAll(rows => rows.map(r => getComputedStyle(r).backgroundColor));
  assert.notEqual(mediaColors[0], mediaColors[1]);
  await page.locator('.task-item[data-media-type=video]').click();
  await page.waitForFunction(() => !document.getElementById('video').hidden && document.getElementById('video').readyState >= 2);
  await page.locator('#play-toggle').click(); await page.waitForFunction(() => document.getElementById('video').currentTime > 0); await page.locator('#play-toggle').click();
  await page.locator('#assignment-id').fill('mixed_media'); await page.locator('#annotator-id').fill('ann_mix');
  await makeSegment('video', 1, 3, 'MP4 与 MP3 混合导入后可标注');
  await page.locator('#complete-item').click();
  await page.locator('.task-item').filter({ hasText: 'tone.mp3' }).click();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await makeSegment('audio', .5, 2, '混合队列中的音频标注');
  await page.locator('#complete-item').click();
  const [mixedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const mixedResult = path.join(artifacts, 'mixed-mp3-mp4.json'); await mixedDownload.saveAs(mixedResult);
  const mixedExport = JSON.parse(fs.readFileSync(mixedResult, 'utf8'));
  assert.ok(mixedExport.items.filter(i => i.id === 'tone.mp3' || i.id === 'video_demo_1').every(i => i.status === 'complete' && i.segments.length >= 1));
  assert.equal(mixedExport.items.length, previousCount + 1);
  await page.locator('.task-item[data-media-type=video]').click();
  await page.screenshot({ path: path.join(artifacts, 'mixed-media-workspace.png'), fullPage: true });
  await page.locator('#drafts-button').click();
  await page.waitForSelector('#draft-dialog[open]');
  assert.ok(await page.locator('.draft-row').count() >= 3);
  await page.locator('#draft-dialog .close-dialog').click();
  check('mixed MP3/MP4 queue colors, independent switching, both annotations export and earlier drafts remain available');

  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#delete-task').click();
  assert.equal(await page.locator('.task-item').count(), previousCount + 1);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#delete-task').click();
  await page.waitForFunction(count => document.querySelectorAll('.task-item').length === count, previousCount);
  const [removedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const removedPath = path.join(artifacts, 'task-removed.json'); await removedDownload.saveAs(removedPath);
  const removed = JSON.parse(fs.readFileSync(removedPath, 'utf8'));
  assert.equal(removed.items.some(i => i.id === 'video_demo_1'), false);
  assert.ok(removed.items.find(i => i.id === 'tone.mp3').segments.length >= 1);
  assert.ok(fs.existsSync(mp4Path));
  await page.reload(); await restoreLatest(); await page.waitForSelector('#workspace:not([hidden])');
  assert.equal(await page.locator('.task-item').count(), previousCount);
  assert.equal(await page.locator('.task-item[data-media-type=video]').count(), 0);
  check('task removal respects cancel, removes only selected records, persists after reload and keeps the source file');

  const longQueue = { format: 'trace-annotations', schema_version: '1.0', batch_id: 'scroll', assignment_id: 'scroll_A', annotator_id: 'ann_scroll', revision: 0,
    items: Array.from({ length: 24 }, (_, n) => ({ id: `scroll_${n}`, title: `Queue task ${n}`, media_path: n ? `unused_${n}.mp4` : 'media/demo.mp4', media_type: 'video', duration_s: 12, status: 'draft',
      segments: n ? [] : Array.from({ length: 30 }, (_, k) => ({ id: `window_${k}`, start_time: (k % 10) * .5, end_time: (k % 10) * .5 + 1, label: k % 2 ? 'speech_content' : 'visual_observation', annotations: { subject_id: 'unknown', local_fact: `Fact ${k}`, evidence_role: 'event_support' } })) })) };
  const longPath = path.join(fixtures, 'scroll-queue.json'); fs.writeFileSync(longPath, JSON.stringify(longQueue));
  await page.locator('#result-input').setInputFiles(longPath);
  await page.waitForFunction(() => document.querySelectorAll('.task-item').length === 24);
  await page.locator('#attach-input').setInputFiles(mp4Path);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  for (const selector of ['#task-list', '#segment-list']) {
    const metrics = await page.locator(selector).evaluate(node => ({ overflow: getComputedStyle(node).overflowY, height: node.clientHeight, content: node.scrollHeight }));
    assert.equal(metrics.overflow, 'scroll'); assert.ok(metrics.content > metrics.height);
    await page.locator(selector).hover(); await page.mouse.wheel(0, 480);
    await page.waitForFunction(id => document.querySelector(id).scrollTop > 10, selector);
  }
  await page.locator('.timeline-segment').first().click();
  const taskScroll = await page.locator('#task-list').evaluate(node => node.scrollTop);
  const windowScroll = await page.locator('#segment-list').evaluate(node => node.scrollTop);
  await page.locator('#local-fact').fill('Editing keeps both queue scroll positions');
  assert.equal(await page.locator('#task-list').evaluate(node => node.scrollTop), taskScroll);
  assert.equal(await page.locator('#segment-list').evaluate(node => node.scrollTop), windowScroll);
  await page.screenshot({ path: path.join(artifacts, 'queue-scroll-workspace.png'), fullPage: true });
  check('task and time-window lists have independent visible scroll tracks and retain their positions during annotation edits');

  const fresh = await browser.newContext(); const freshPage = await fresh.newPage();
  freshPage.on('pageerror', e => errors.push(e.message));
  await freshPage.goto(origin); await freshPage.waitForSelector('#welcome:not([hidden])');
  await freshPage.locator('#media-input').setInputFiles(mp3Path);
  await freshPage.waitForFunction(() => !document.getElementById('audio-stage').hidden && document.getElementById('audio').readyState >= 2);
  assert.equal(await freshPage.locator('#item-title').textContent(), 'tone.mp3');
  freshPage.once('dialog', dialog => dialog.dismiss()); await freshPage.locator('#delete-task').click();
  assert.equal(await freshPage.locator('.task-item').count(), 1);
  freshPage.once('dialog', dialog => dialog.accept()); await freshPage.locator('#delete-task').click();
  await freshPage.waitForSelector('#welcome:not([hidden])');
  await freshPage.reload(); await freshPage.waitForSelector('#welcome:not([hidden])');
  assert.ok(fs.existsSync(mp3Path));
  await fresh.close();
  check('MP3 imports without a manifest; removing the final task clears its saved queue and keeps the original file');

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
