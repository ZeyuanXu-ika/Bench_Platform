import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const origin = process.env.BASE_URL || 'http://127.0.0.1:8787/';
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const browsers = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(browsers)) for (const dir of fs.readdirSync(browsers).sort().reverse()) {
    const candidate = path.join(browsers, dir, 'chrome-win64', 'chrome.exe');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
  }
}
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
fixture.batch_id = 'relation_editor_browser';
for (const id of ['event_2', 'event_3']) {
  fixture.graph.events.push({ ...fixture.graph.events[0], id, title: `合成关系回归 ${id}` });
  for (const edge of fixture.graph.links.filter(link => link.to_type === 'event' && link.to_id === 'event_1')) {
    fixture.graph.links.push({ ...edge, id: `${edge.id}_${id}`, to_id: id });
  }
}
fixture.graph.links.find(link => link.to_type === 'emotion_transition').type = 'causes';
fixture.graph.links.push({ id: 'mixed_relation_event_2', from_type: 'event', from_id: 'event_2', to_type: 'emotion_transition', to_id: 'transition_1', type: 'associated_with' });
for (const key of ['facts', 'events', 'emotion_states', 'emotion_transitions']) for (const entry of fixture.graph[key]) entry.review_status = 'confirmed';
fixture.graph.status = 'complete';
parseResults(fixture);

const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage(), checks = [], errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
const check = name => { checks.push(name); console.log('PASS:', name); };
const stage = async name => page.locator(`#graph-workbench button[data-stage="${name}"]`).click();
const control = id => page.locator(`#g-transition-event-relations select[data-event-id="${id}"]`);
const choice = id => page.locator(`[data-control-id="g-transition-events"] input[type="checkbox"][value="${id}"]`);
const transitionEdges = data => data.graph.links.filter(link => link.to_type === 'emotion_transition' && link.to_id === 'transition_1').sort((a, b) => a.from_id.localeCompare(b.from_id));
const types = data => Object.fromEntries(transitionEdges(data).map(link => [link.from_id, link.type]));
async function save() {
  await page.locator('#g-transition-review').selectOption('confirmed');
  await page.getByRole('button', { name: '保存情感变化', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.g-feedback').hidden && document.querySelector('.g-feedback').textContent.includes('情感变化已保存') && !document.querySelector('.g-feedback').classList.contains('error'));
}
async function download(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const filename = path.join(artifacts, `relation-editor-${name}.json`); await download.saveAs(filename);
  const result = JSON.parse(fs.readFileSync(filename, 'utf8')); parseResults(result); return result;
}

try {
  await page.goto(origin); await page.waitForSelector('#welcome:not([hidden])');
  await page.locator('#result-input').setInputFiles({ name: 'mixed-relations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(batch => document.getElementById('batch-id').value === batch, fixture.batch_id);
  await stage('emotions'); await page.locator('.g-node[data-node-id="transition_1"]').click();
  assert.equal(await control('event_1').inputValue(), 'causes');
  assert.equal(await control('event_2').inputValue(), 'associated_with');
  assert.equal(await page.locator('#g-transition-relation').isVisible(), false);
  check('imported mixed causal/association edges have independent, correctly named event controls');

  const baseline = await download('baseline');
  await save();
  const noChange = await download('no-change');
  assert.deepEqual(noChange.graph, baseline.graph);
  assert.equal(noChange.graph.status, 'complete'); assert.equal(noChange.revision, baseline.revision);
  check('unchanged confirmed transition save preserves complete graph, revision and stable edge IDs');

  await page.locator('#g-transition-note').fill('只修改变化说明，原有事件关系各自保持。');
  await save(); const noteOnly = await download('note-only');
  assert.deepEqual(transitionEdges(noteOnly), transitionEdges(fixture));
  check('editing only the explanation and saving preserves every imported mixed relation and edge ID');

  await control('event_2').selectOption('causes'); await save();
  const secondChanged = await download('second-edge');
  assert.deepEqual(types(secondChanged), { event_1: 'causes', event_2: 'causes' });
  assert.deepEqual(transitionEdges(secondChanged).find(link => link.from_id === 'event_1'), transitionEdges(noteOnly).find(link => link.from_id === 'event_1'));
  assert.equal(transitionEdges(secondChanged).find(link => link.from_id === 'event_2').id, 'mixed_relation_event_2');
  await control('event_1').selectOption('associated_with'); await save();
  const firstChanged = await download('first-edge');
  assert.deepEqual(types(firstChanged), { event_1: 'associated_with', event_2: 'causes' });
  assert.deepEqual(transitionEdges(firstChanged).find(link => link.from_id === 'event_2'), transitionEdges(secondChanged).find(link => link.from_id === 'event_2'));
  check('changing one event relationship changes only its edge and retains existing edge identity');

  const eventOneControlID = await control('event_1').getAttribute('id');
  await control('event_1').selectOption('causes');
  await control('event_2').selectOption('associated_with');
  for (let round = 0; round < 2; round++) {
    await stage('facts'); await stage('emotions');
    assert.equal(await control('event_1').inputValue(), 'causes');
    assert.equal(await control('event_2').inputValue(), 'associated_with');
    assert.equal(await control('event_1').getAttribute('id'), eventOneControlID);
  }
  await choice('event_1').uncheck();
  assert.equal(await page.locator('#g-transition-relation').isVisible(), true);
  assert.equal(await page.locator('#g-transition-relation').inputValue(), 'associated_with');
  await choice('event_1').check();
  assert.equal(await control('event_1').inputValue(), 'causes');
  assert.equal(await control('event_2').inputValue(), 'associated_with');
  await save(); const restored = await download('restored-draft');
  assert.deepEqual(types(restored), { event_1: 'causes', event_2: 'associated_with' });
  check('event-keyed dirty relationships survive repeated stage changes and deselect/reselect without exchanging semantics');

  await choice('event_2').uncheck();
  assert.equal(await page.locator('#g-transition-relation').isVisible(), true);
  await page.locator('#g-transition-relation').selectOption('associated_with');
  await save(); const single = await download('single-event');
  assert.deepEqual(types(single), { event_1: 'associated_with' });
  await page.locator('#g-transition-relation').selectOption('causes');
  await choice('event_3').check();
  assert.equal(await control('event_1').inputValue(), 'causes');
  assert.equal(await control('event_3').inputValue(), 'associated_with');
  await save(); const newlyLinked = await download('new-event');
  assert.deepEqual(types(newlyLinked), { event_1: 'causes', event_3: 'associated_with' });
  check('single-event compatibility remains usable and newly selected events default to association independently');

  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(new URL(origin).origin + '/') || request.url.startsWith('blob:'))));
  check('real browser imports and downloads without application exceptions or upload requests');
  fs.writeFileSync(path.join(artifacts, 'relation-editor-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, errors, request_count: requests.length }, null, 2));
  console.log(`Relationship editor verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'relation-editor-failure.png'), fullPage: true }).catch(() => {});
  console.error('Relationship editor verification FAILED:', error); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
