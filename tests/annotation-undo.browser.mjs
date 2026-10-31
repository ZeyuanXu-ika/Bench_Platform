import { saveItemDownloadAndProjectSnapshot } from './project-snapshot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const fixtures = path.join(root, '.tools', 'annotation-undo-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
execFileSync('python', ['-c', 'import sys,zipfile;from pathlib import Path;r=Path(sys.argv[2]).resolve();z=zipfile.ZipFile(sys.argv[1]);assert all((r/i.filename).resolve().is_relative_to(r) for i in z.infolist());z.extractall(r)', path.join(root, 'samples', 'demo-task.zip'), fixtures]);
const taskDir = path.join(fixtures, 'demo-task');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
fixture.graph.status = 'draft'; fixture.batch_id = 'annotation_undo_test';
fixture.graph.entities.push({ id: 'other_subject', name: '另一主体', aliases: [] });
fixture.graph.emotion_states.push({ ...fixture.graph.emotion_states[0], id: 'other_state', subject_id: 'other_subject' },
  { ...fixture.graph.emotion_states[1], id: 'state_3', start_time: 9, end_time: 10 });
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const name of fs.readdirSync(cache).sort().reverse()) {
    const candidate = path.join(cache, name, 'chrome-win64', 'chrome.exe');
    if (name.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
  }
}
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
const check = message => { checks.push(message); console.log('PASS:', message); };
const stage = name => page.locator(`.g-tab[data-stage="${name}"]`).click();
let serial = 0;
async function exported() {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const file = path.join(artifacts, `annotation-undo-${serial++}.json`); const project = await saveItemDownloadAndProjectSnapshot(download, page, file);
  const value = project; parseResults(value); return value;
}
const listCheck = id => page.locator(`.g-state-choice-row>input[data-state-id="${id}"]`);
const timeCheck = id => page.locator(`.g-layer-view .g-time-row[data-node-id="${id}"] input[data-state-id="${id}"]`);
const band = (type, id, n = 0) => page.locator(`.g-layer-view .g-time-row[data-node-type="${type}"][data-node-id="${id}"] .g-time-band`).nth(n);
async function drag(target, delta, evidence = false) {
  await target.scrollIntoViewIfNeeded();
  const geometry = await target.evaluate((el, original) => {
    const scale = document.querySelector('.g-layer-view .g-time-scale');
    return { width: el.parentElement.getBoundingClientRect().width,
      span: original ? document.querySelector('#video').duration : Number(scale.getAttribute('aria-valuemax')) - Number(scale.getAttribute('aria-valuemin')) };
  }, evidence);
  const box = await target.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + delta / geometry.span * geometry.width, y, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(100);
}
function sameAnnotations(actual, expected) { assert.deepEqual(actual.items, expected.items); assert.deepEqual(actual.graph, expected.graph); assert.ok(actual.revision > expected.revision); }
try {
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8787/');
  await page.locator('#result-input').setInputFiles({ name: 'undo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForSelector('#workspace:not([hidden])'); await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);
  for (const name of ['evidence', 'facts', 'events', 'emotions', 'graph']) {
    await stage(name);
    assert.doesNotMatch(await page.locator('#workspace').innerText(), /待复核|复核状态/);
    assert.equal(await page.locator('select[id$="-review"]').count(), 0);
  }
  check('all annotation stages omit review options and badges while importing legacy metadata');
  await stage('emotions'); const original = await exported();
  await listCheck('state_1').check(); await page.locator('.g-node[data-node-id="state_2"]').click();
  await timeCheck('state_2').check();
  assert.equal(await listCheck('state_1').isChecked(), true); assert.equal(await listCheck('state_2').isChecked(), true);
  assert.equal(await page.locator('#g-state-label').inputValue(), fixture.graph.emotion_states[1].label);
  await listCheck('other_state').check(); await page.locator('#g-connect-selected').click(); await page.waitForSelector('.g-feedback.error');
  const rejected = await exported(); assert.deepEqual(rejected.graph, original.graph); assert.equal(rejected.revision, original.revision);
  await listCheck('other_state').uncheck(); await page.locator('#g-connect-selected').click();
  const linked = await exported(); assert.equal(linked.graph.links.filter(link => link.type === 'transitions_to').length, 1);
  await page.locator('#g-undo').click(); const unlinked = await exported(); sameAnnotations(unlinked, original);
  check('list and timeline multi-selection stays independent from the editor; cross-subject linking is atomic and a link can be undone');
  await band('emotion_state', 'state_3').click({ modifiers: ['Control'] });
  assert.equal(await listCheck('state_3').isChecked(), true);
  const beforeChain = await exported(); await page.locator('#g-connect-selected').click(); const chain = await exported();
  assert.deepEqual(chain.graph.links.filter(link => link.type === 'transitions_to').map(link => [link.from_id, link.to_id]), [['state_1', 'state_2'], ['state_2', 'state_3']]);
  await page.locator('.g-state-selection-count').click(); await page.keyboard.press('Control+z');
  sameAnnotations(await exported(), beforeChain);
  await page.getByRole('button', { name: '清空多选', exact: true }).click();
  check('Ctrl-click selects additional states without moving time; three selected states form an ordered chain undone as one action');
  await page.locator('#g-state-label').click(); await page.keyboard.press('End'); await page.keyboard.type('x');
  const beforeTextUndo = await exported(); await page.locator('#g-state-label').focus(); await page.keyboard.press('Control+z'); const afterTextUndo = await exported();
  assert.equal(afterTextUndo.revision, beforeTextUndo.revision); assert.deepEqual(afterTextUndo.graph, beforeTextUndo.graph);
  check('Ctrl+Z inside text fields retains native text undo and does not roll back saved annotation data');
  await stage('facts'); const beforeTime = await exported(); await drag(band('fact', 'fact_1'), .5); const moved = await exported();
  assert.notDeepEqual(moved.items, beforeTime.items); await page.locator('#g-undo').click(); sameAnnotations(await exported(), beforeTime);
  check('undoing a fact drag restores all supporting source windows, derived events, links and legacy flags together');
  await drag(band('fact', 'fact_1'), .3); const firstMove = await exported();
  await stage('events'); await drag(band('event', 'event_1'), .2); const secondMove = await exported(); assert.notDeepEqual(secondMove.items, firstMove.items);
  await page.locator('#g-undo').click(); sameAnnotations(await exported(), firstMove);
  await page.locator('#g-undo').click(); sameAnnotations(await exported(), beforeTime);
  check('successive fact and event drags undo in order across stages while revisions remain monotonic');
  await stage('evidence'); const beforeEvidence = await exported();
  await drag(page.locator('#timeline .timeline-segment[data-segment-id="v1"]'), .4, true);
  const movedEvidence = await exported(); assert.notDeepEqual(movedEvidence.items, beforeEvidence.items);
  await page.locator('#g-undo').click(); sameAnnotations(await exported(), beforeEvidence);
  check('the original evidence timeline also supports undo without detaching the local video');
  await stage('emotions'); await page.screenshot({ path: path.join(artifacts, 'multi-select-undo.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Multi-select and undo browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'multi-select-undo-failure.png'), fullPage: true });
  console.error('Multi-select/undo FAILED:', error, errors); process.exitCode = 1;
} finally { await browser.close(); }
