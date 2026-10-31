import { saveItemDownloadAndProjectSnapshot } from './project-snapshot.mjs';
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
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
fixture.batch_id = 'emotion_state_test'; fixture.graph.status = 'draft';
for (const collection of ['facts', 'events', 'emotion_states']) for (const node of fixture.graph[collection]) node.review_status = 'confirmed';
fixture.graph.entities.push({ id: 'other_subject', name: '另一主体', aliases: [] });
fixture.graph.emotion_states.push(...fixture.graph.emotion_states.map(state => ({ ...state, id: `${state.id}_other`, subject_id: 'other_subject', label: `另一主体 ${state.label}` })));
fixture.graph.events.push({ ...fixture.graph.events[0], id: 'event_2', title: '另一关联事件' });
for (const link of fixture.graph.links.filter(link => link.to_type === 'event')) fixture.graph.links.push({ ...link, id: `${link.id}_event2`, to_id: 'event_2' });
fixture.graph.links.push({ id: 'cause-state', from_type: 'event', from_id: 'event_1', to_type: 'emotion_state', to_id: 'state_2', type: 'causes', note: '事件一的原始因果依据' },
  { id: 'associate-state', from_type: 'event', from_id: 'event_2', to_type: 'emotion_state', to_id: 'state_2', type: 'associated_with' });
parseResults(fixture);
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
const selectNode = id => page.locator(`.g-node[data-node-id="${id}"]`).click();
const relation = id => page.locator(`#g-state-event-relations select[data-event-id="${id}"]`);
const reason = id => page.locator(`#g-state-event-relations textarea[data-event-id="${id}"]`);
async function exported(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const file = path.join(artifacts, `emotion-state-${name}.json`); const project = await saveItemDownloadAndProjectSnapshot(download, page, file);
  const value = project; parseResults(value); return value;
}
async function saveState() {
  await page.getByRole('button', { name: '保存情感状态', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.g-feedback').textContent.includes('情感状态已保存') && !document.querySelector('.g-feedback').classList.contains('error'));
}
try {
  await page.goto(origin); await page.locator('#result-input').setInputFiles({ name: 'state-input.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForSelector('#workspace:not([hidden])');
  const original = await exported('original');
  for (const name of ['evidence', 'facts', 'events', 'emotions', 'graph']) {
    await stage(name); assert.equal(await page.locator('.g-management').count(), 0);
  }
  await stage('emotions');
  assert.equal(await page.locator('.g-emotions>.g-editor-layout').count(), 1);
  assert.equal(await page.locator('#g-transition-subject').count(), 0);
  assert.equal(await page.getByRole('button', { name: '新增情感变化', exact: true }).count(), 0);
  assert.equal(await page.locator('.g-layer-view .g-time-row[data-node-type=emotion_state]').count(), 4);
  await selectNode('state_2');
  assert.equal(await relation('event_1').inputValue(), 'causes'); assert.equal(await relation('event_2').inputValue(), 'associated_with');
  assert.equal(await reason('event_1').inputValue(), '事件一的原始因果依据');
  await saveState(); const unchanged = await exported('unchanged');
  assert.deepEqual(unchanged.graph, original.graph); assert.equal(unchanged.revision, original.revision);
  check('removed panels stay absent in every stage; per-event state relations import and save unchanged without rewriting history');
  await reason('event_1').fill(''); await page.getByRole('button', { name: '保存情感状态', exact: true }).click();
  await page.waitForSelector('.g-feedback.error');
  const rejected = await exported('missing-reason'); assert.deepEqual(rejected.graph, unchanged.graph);
  await reason('event_1').fill('事件一的新依据'); await relation('event_2').selectOption('causes'); await reason('event_2').fill('事件二的独立依据');
  await stage('facts'); await stage('emotions');
  assert.equal(await reason('event_1').inputValue(), '事件一的新依据'); assert.equal(await reason('event_2').inputValue(), '事件二的独立依据');
  await saveState(); const causes = await exported('causes');
  assert.equal(causes.graph.links.find(link => link.id === 'cause-state').note, '事件一的新依据');
  assert.equal(causes.graph.links.find(link => link.id === 'associate-state').note, '事件二的独立依据');
  assert.equal(causes.graph.links.find(link => link.id === 'associate-state').type, 'causes');
  assert.deepEqual(causes.graph.emotion_transitions, original.graph.emotion_transitions);
  check('each causal relation requires its own reason and unsaved relation fields survive stage changes');
  await selectNode('state_1');
  await page.locator('.g-state-choice-row>input[data-state-id="state_1"]').check();
  await page.locator('.g-layer-view .g-time-row[data-node-id="state_2"] input[data-state-id="state_2"]').check();
  await page.getByRole('button', { name: '连接选中状态', exact: true }).click();
  let linked = await exported('linked');
  const edges = linked.graph.links.filter(link => link.type === 'transitions_to'); assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].from_type, edges[0].from_id, edges[0].to_type, edges[0].to_id], ['emotion_state', 'state_1', 'emotion_state', 'state_2']);
  assert.deepEqual(linked.graph.emotion_transitions, original.graph.emotion_transitions);
  const revision = linked.revision;
  await page.getByRole('button', { name: '连接选中状态', exact: true }).click();
  const duplicate = await exported('duplicate'); assert.equal(duplicate.graph.links.filter(link => link.type === 'transitions_to').length, 1); assert.equal(duplicate.revision, revision);
  assert.equal(await page.locator('.g-layer-view .g-time-row[data-node-type=emotion_relation]').count(), 1);
  check('two same-subject state choices create exactly one direct edge, with duplicate prevention and a shared-axis connector');
  await page.locator('.g-state-choice-row>input[data-state-id="state_1_other"]').check();
  await page.getByRole('button', { name: '连接选中状态', exact: true }).click(); await page.waitForSelector('.g-feedback.error');
  const reversed = await exported('reversed'); assert.equal(reversed.graph.links.filter(link => link.type === 'transitions_to').length, 1);
  await selectNode('state_1_other');
  assert.equal(await page.locator('.g-layer-view .g-time-row[data-node-type=emotion_state]').count(), 4);
  await page.locator('.g-state-choice-row>input[data-state-id="state_1_other"]').uncheck();
  assert.equal(await page.locator('.g-state-choice-row>input:checked').count(), 2);
  check('different subjects remain visible together while multi-selection rejects cross-subject connections independently of the editor');
  await stage('graph');
  assert.equal(await page.locator(`#g-directed-svg path[data-edge-id="${edges[0].id}"]`).count(), 1);
  assert.match(await page.locator(`#g-directed-svg path[data-edge-id="${edges[0].id}"] title`).textContent(), /情感变化/);
  await stage('emotions');
  await page.locator('.g-layer-view .g-time-row[data-node-type=emotion_transition] .g-time-band').last().click();
  assert.equal(await page.locator('#g-state-label').inputValue(), fixture.graph.emotion_states[1].label);
  assert.equal(await page.locator('.g-state-history').count(), 1);
  await page.locator(`.g-state-change-row[data-edge-id="${edges[0].id}"]`).getByRole('button', { name: '删除连边', exact: true }).click();
  const deleted = await exported('deleted'); assert.equal(deleted.graph.links.filter(link => link.type === 'transitions_to').length, 0);
  assert.deepEqual(deleted.graph.emotion_transitions, original.graph.emotion_transitions);
  await page.locator('.g-state-history > summary').click();
  assert.equal(await page.locator('.g-state-history select').count(), 0);
  assert.doesNotMatch(await page.locator('#workspace').innerText(), /待复核|复核状态/);
  check('graph renders a single edge; old transition selection opens its state, and deleting the new edge preserves historical data');
  await page.screenshot({ path: path.join(artifacts, 'emotion-state-editor.png'), fullPage: true });
  await selectNode('state_2');
  await page.locator('#g-state-events').selectOption([]); await page.locator('#g-state-facts').selectOption([]);
  const constituents=fixture.graph.links.filter(link=>link.from_type==='fact' && link.to_type==='event' && link.to_id==='event_1').map(link=>link.from_id);
  assert.ok(constituents.length>=2);
  await page.locator('#g-state-events').selectOption(['event_1']);
  const chosenFacts=()=>page.locator('#g-state-facts').evaluate(select=>[...select.selectedOptions].map(o=>o.value));
  assert.deepEqual((await chosenFacts()).sort(),[...constituents].sort());
  const subset=[constituents.at(-1)];await page.locator('#g-state-facts').selectOption(subset);
  await stage('facts');await stage('emotions');assert.deepEqual(await chosenFacts(),subset);
  await saveState();await selectNode('state_1');await selectNode('state_2');assert.deepEqual(await chosenFacts(),subset);
  const partial=await exported('partial-event-facts');
  assert.deepEqual(partial.graph.links.filter(l=>l.to_type==='emotion_state'&&l.to_id==='state_2'&&l.from_type==='fact').map(l=>l.from_id),subset);
  check('newly selected event defaults its facts; manual exclusions survive drafts, save and reopening');
  await page.locator('#g-state-facts').selectOption([]);await saveState();await selectNode('state_1');await selectNode('state_2');assert.deepEqual(await chosenFacts(),[]);
  const eventOnly=await exported('event-only');assert.equal(eventOnly.graph.links.filter(l=>l.to_type==='emotion_state'&&l.to_id==='state_2'&&l.from_type==='fact').length,0);
  assert.equal(eventOnly.graph.links.filter(l=>l.to_type==='emotion_state'&&l.to_id==='state_2'&&l.from_type==='event').length,1);
  await page.locator('#g-state-events').selectOption([]);await page.locator('#g-state-facts').selectOption(subset);await saveState();
  const factOnly=await exported('fact-only');assert.equal(factOnly.graph.links.filter(l=>l.to_type==='emotion_state'&&l.to_id==='state_2'&&l.from_type==='event').length,0);
  check('event-only and fact-only emotion states both save without fabricating the other support relation');
  await page.locator('#g-state-facts').selectOption([]);await page.getByRole('button',{name:'保存情感状态',exact:true}).click();await page.waitForSelector('.g-feedback.error');
  const unsupported=await exported('unsupported');assert.deepEqual(unsupported.graph,factOnly.graph);
  check('a state with no selected fact or event is rejected without mutating saved annotations');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []); check('integrated editor fits mobile without application exceptions');
  console.log(`Emotion state browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'emotion-state-failure.png'), fullPage: true });
  console.error('Emotion state FAILED:', error, errors); process.exitCode = 1;
} finally { await browser.close(); }
