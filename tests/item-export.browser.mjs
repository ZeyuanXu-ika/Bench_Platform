import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
fixture.batch_id = 'per_material_export'; fixture.graph.status = 'draft';
const second = structuredClone(fixture.items[0]); second.id = 'second_video'; second.media_path = 'other/demo.mp4'; second.title = '第二条视频'; second.timeline_id = 'second_scene';
for (const segment of second.segments) delete segment.annotations.fact_id;
fixture.items.push(second); parseResults(fixture);
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const name of fs.readdirSync(cache).sort().reverse()) { const candidate = path.join(cache, name, 'chrome-win64', 'chrome.exe'); if (name.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; } }
}
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
const check = message => { checks.push(message); console.log('PASS:', message); };
let serial = 0;
async function currentJSON() {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const file = path.join(artifacts, `per-material-${serial++}.json`); await download.saveAs(file);
  await page.waitForFunction(() => !document.getElementById('export-result').disabled);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')); parseResults(payload); return { payload, file };
}
async function newState() {
  await page.locator('.g-tab[data-stage=emotions]').click();
  await page.locator('.g-layer-view .g-time-inputs input').nth(0).fill('9'); await page.locator('.g-layer-view .g-time-inputs input').nth(1).fill('10');
  await page.locator('.g-layer-view').getByRole('button', { name: '新建时间窗', exact: true }).click();
}
try {
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8787/');
  await page.locator('#result-input').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForSelector('#workspace:not([hidden])');
  const first = await currentJSON();
  assert.equal(first.payload.items.length, 1); assert.equal(first.payload.items[0].id, 'demo_video');
  assert.equal(await page.locator('.task-item').count(), 3);
  await page.locator('.task-item').filter({ hasText: '第二条视频' }).click(); const other = await currentJSON();
  assert.equal(other.payload.items.length, 1); assert.equal(other.payload.items[0].id, 'second_video');
  check('saving each video produces its own one-item JSON and leaves the project queue intact');
  await page.evaluate(() => {
    window.__folderFiles = {}; window.__closed = 0;
    window.showDirectoryPicker = async () => ({ getFileHandle: async name => ({ createWritable: async () => ({ write: async body => { window.__folderFiles[name] = body; }, close: async () => { window.__closed++; } }) }) });
  });
  await page.locator('#export-all').click(); await page.waitForFunction(() => window.__closed === 3 && !document.getElementById('export-all').disabled);
  const folder = await page.evaluate(() => window.__folderFiles);
  assert.equal(Object.keys(folder).length, 3); assert.equal(new Set(Object.values(folder).map(body => JSON.parse(body).source_item_id)).size, 3);
  for (const body of Object.values(folder)) { const payload = JSON.parse(body); assert.equal(payload.items.length, 1); parseResults(payload); }
  check('batch folder saving writes one JSON per material with distinct names even for repeated video basenames');
  await page.evaluate(() => { window.showDirectoryPicker = undefined; });
  const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-all').click()]);
  const zipFile = path.join(artifacts, 'per-material-batch.zip'); await zipDownload.saveAs(zipFile);
  const unpacked = JSON.parse(execFileSync('python', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({n:json.loads(z.read(n)) for n in z.namelist()}))', zipFile], { encoding: 'utf8' }));
  assert.equal(Object.keys(unpacked).length, 3); assert.ok(Object.values(unpacked).every(payload => payload.items.length === 1));
  check('browsers without folder saving download a ZIP of separate JSON files rather than one merged annotation file');
  await page.locator('#result-input').setInputFiles(first.file); await page.waitForFunction(expected=>document.querySelector('.task-item[aria-current=true] .task-annotation-source')?.textContent.includes(expected),path.basename(first.file));
  await newState(); const created = await currentJSON();
  assert.equal(created.payload.graph.emotion_states.at(-1).id, 'S001');
  assert.ok(await page.locator('.g-node-id').filter({ hasText: /^S001$/ }).count());
  await page.locator('#g-undo').click(); await newState(); const afterUndo = await currentJSON();
  assert.equal(afterUndo.payload.graph.emotion_states.at(-1).id, 'S002');
  await page.locator('#result-input').setInputFiles(afterUndo.file);
  await page.waitForFunction(expected=>document.querySelector('.task-item[aria-current=true] .task-annotation-source')?.textContent.includes(expected),path.basename(afterUndo.file));
  await newState(); const reopened = await currentJSON();
  assert.equal(reopened.payload.graph.emotion_states.at(-1).id, 'S003');
  check('standalone JSON reopens for annotation; sequential state IDs remain readable and are not reused after undo or reopen');
  await page.screenshot({ path: path.join(artifacts, 'per-material-save.png'), fullPage: true });
  assert.deepEqual(errors, []); console.log(`Per-material export browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'per-material-export-failure.png'), fullPage: true });
  console.error('Per-material export FAILED:', error, errors); process.exitCode = 1;
} finally { await browser.close(); }
