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
const template = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
function fixture() {
  const data = structuredClone(template); data.batch_id = 'subject_lineage_browser';
  data.graph = { status: 'draft', entities: [{ id: 'unrelated_first', name: '无关默认主体', aliases: [] }],
    mentions: [], facts: [], events: [], emotion_states: [], emotion_transitions: [], links: [] };
  for (const item of data.items) for (const segment of item.segments) {
    segment.annotations.subject_id = item.id === 'demo_video' ? '主体甲' : '主体乙';
  }
  parseResults(data); return data;
}
const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage(), checks = [], errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
const check = name => { checks.push(name); console.log('PASS:', name); };
const ev = (item, segment) => JSON.stringify([item, segment]);
const stage = async name => page.locator(`.g-tab[data-stage="${name}"]`).click();
const options = id => page.locator(`#${id}`).evaluate(select => [...select.options].filter(option => option.value).map(option => ({ id: option.value, text: option.textContent })));
const selected = id => page.locator(`#${id}`).evaluate(select => [...select.selectedOptions].map(option => option.value).filter(Boolean));
async function expectSingle(id, text) {
  const entries = await options(id); assert.equal(entries.length, 1, `${id}: only the inherited subject belongs in this control`);
  assert.ok(entries[0].text.includes(text), `${id}: expected ${text}, got ${entries[0].text}`);
  assert.deepEqual(await selected(id), [entries[0].id]);
  const hiddenControl = await page.locator(`#${id}`).evaluate(control => {
    const style = getComputedStyle(control), box = control.getBoundingClientRect();
    return control.tabIndex < 0 && control.getAttribute('aria-hidden') === 'true' &&
      (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || box.width <= 1);
  });
  assert.equal(hiddenControl, true, `${id}: a unique inherited subject must display as a card, not a dropdown`);
  assert.ok((await page.locator(`.g-subject-lineage[data-control-id="${id}"]`).textContent()).includes(text));
  return entries[0].id;
}
async function choose(id, value, checked = true) {
  const inputs = page.locator(`[data-control-id="${id}"] input[type="checkbox"]`);
  const index = await inputs.evaluateAll((nodes, wanted) => nodes.findIndex(node => node.value === wanted), value);
  assert.ok(index >= 0, `${id}: missing visible reference checkbox ${value}`);
  await inputs.nth(index).setChecked(checked);
}
let loadNumber = 0;
async function load(data) {
  const incoming = structuredClone(data); incoming.batch_id += `_${++loadNumber}`;
  await page.locator('#result-input').setInputFiles({ name: 'subject-lineage.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await page.waitForFunction(batch => document.getElementById('batch-id').value === batch, incoming.batch_id);
  await page.waitForSelector('#workspace:not([hidden])');
  return incoming;
}
async function download(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const filename = path.join(artifacts, `subject-lineage-${name}.json`); await download.saveAs(filename);
  const data = JSON.parse(fs.readFileSync(filename, 'utf8')); parseResults(data); return data;
}
async function save(name, message) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(wanted => {
    const feedback = document.querySelector('.g-feedback');
    return feedback.textContent.includes(wanted) && !feedback.classList.contains('error');
  }, message);
}

try {
  await page.goto(origin); await page.waitForSelector('#welcome:not([hidden])');
  await load(fixture());
  await stage('facts');
  const subjectA = await expectSingle('g-fact-subjects', '主体甲');
  const beforeSave = await download('before-save');
  assert.equal(beforeSave.graph.entities.length, 1, 'deriving a subject preview must not alter the stored graph');
  check('a new fact inherits only the current material evidence subject and renders one subject card without a global list');

  await stage('evidence'); await page.locator('.segment-row').first().click(); await page.locator('#build-fact').click();
  assert.equal(await expectSingle('g-fact-subjects', '主体甲'), subjectA);
  assert.deepEqual(await selected('g-fact-evidence'), [ev('demo_video', 'v1')]);
  await page.locator('#g-fact-text').fill('主体甲作出可观察动作。');
  await save('保存事实', '事实已保存');
  const first = await download('first-fact');
  const factA = first.graph.facts.find(entry => entry.text === '主体甲作出可观察动作。');
  assert.deepEqual(factA.subject_ids, [subjectA]);
  assert.equal(first.graph.entities.find(entry => entry.id === subjectA).name, '主体甲');
  assert.ok(first.graph.mentions.some(entry => entry.entity_id === subjectA && entry.evidence_id === ev('demo_video', 'v1')));
  assert.equal(first.items[0].segments[0].annotations.subject_id, '主体甲');
  check('organizing evidence into a fact reuses its subject identity and commits an explicit evidence mention without changing the source annotation');

  await stage('events'); await choose('g-event-facts', factA.id);
  assert.equal(await expectSingle('g-event-subjects', '主体甲'), subjectA);
  await page.locator('#g-event-title').fill('主体甲完成该动作'); await save('保存复合事件', '复合事件已保存');
  const eventData = await download('event'); const eventA = eventData.graph.events[0];
  assert.deepEqual(eventA.subject_ids, [subjectA]);
  await stage('emotions'); await choose('g-state-facts', factA.id);
  assert.equal(await expectSingle('g-state-subject', '主体甲'), subjectA);
  await page.locator('#g-state-label').fill('平静'); await page.locator('#g-state-start').fill('1'); await page.locator('#g-state-end').fill('3');
  await save('保存情感状态', '情感状态已保存');
  const stateData = await download('first-state'); const stateA = stateData.graph.emotion_states[0];
  assert.equal(stateA.subject_id, subjectA);
  await page.getByRole('button', { name: '新增情感状态', exact: true }).click(); await choose('g-state-facts', factA.id);
  await page.locator('#g-state-label').fill('紧张'); await page.locator('#g-state-start').fill('6'); await page.locator('#g-state-end').fill('8');
  await save('保存情感状态', '情感状态已保存');
  const secondStateData = await download('second-state'); const stateB = secondStateData.graph.emotion_states.find(entry => entry.id !== stateA.id);
  assert.equal(await expectSingle('g-transition-subject', '主体甲'), subjectA);
  await page.locator('#g-transition-from').selectOption(stateA.id); await page.locator('#g-transition-to').selectOption(stateB.id);
  await choose('g-transition-events', eventA.id); await page.locator('#g-transition-note').fill('两状态之间存在变化，仅记录事件关联。');
  await save('保存情感变化', '情感变化已保存');
  const fourLayers = await download('four-layers');
  assert.equal(fourLayers.graph.emotion_transitions[0].subject_id, subjectA);
  assert.ok(!fourLayers.graph.facts.some(entry => entry.subject_ids.includes('unrelated_first')));
  check('fact, compound event, emotion states and transition keep the inherited subject ID instead of selecting the first global entity');

  await stage('facts'); await page.getByRole('button', { name: '新增事实', exact: true }).click();
  await page.locator('#g-fact-text').fill('甲任务未保存的事实草稿');
  await page.locator('.task-item[data-media-type="audio"]').click(); await stage('facts');
  assert.equal(await page.locator('#g-fact-text').inputValue(), '', 'a different task must not receive the previous new-fact draft');
  const subjectB = await expectSingle('g-fact-subjects', '主体乙'); assert.notEqual(subjectB, subjectA);
  await choose('g-fact-evidence', ev('demo_audio', 'a1')); await page.locator('#g-fact-text').fill('主体乙发出声音。');
  await save('保存事实', '事实已保存');
  const second = await download('second-task'); const factB = second.graph.facts.find(entry => entry.text === '主体乙发出声音。');
  assert.deepEqual(factB.subject_ids, [subjectB]);
  await page.locator('.task-item[data-media-type="video"]').click(); await stage('facts');
  assert.equal(await page.locator('#g-fact-text').inputValue(), '甲任务未保存的事实草稿');
  assert.equal(await expectSingle('g-fact-subjects', '主体甲'), subjectA);
  check('new-form drafts and inherited subjects stay isolated per material and return intact when switching back');

  await stage('events'); await page.getByRole('button', { name: '新增复合事件', exact: true }).click();
  await choose('g-event-facts', factA.id); assert.equal(await expectSingle('g-event-subjects', '主体甲'), subjectA);
  await choose('g-event-facts', factA.id, false); await choose('g-event-facts', factB.id);
  assert.equal(await expectSingle('g-event-subjects', '主体乙'), subjectB);
  await choose('g-event-facts', factA.id);
  const derived = await options('g-event-subjects');
  assert.deepEqual(new Set(derived.map(entry => entry.id)), new Set([subjectA, subjectB]));
  assert.ok(derived.every(entry => entry.id !== 'unrelated_first'));
  check('changing actual supporting facts updates the inherited subject range and multiple candidates come only from those facts');

  // Return to a saved record before reloading so a known persisted identity can be checked.
  await stage('facts'); await page.locator(`.g-node[data-node-id="${factA.id}"]`).click();
  const savedGraph = (await download('before-refresh')).graph;
  const acceptReload = dialog => dialog.accept(); page.once('dialog', acceptReload);
  await page.reload(); await page.waitForSelector('#welcome:not([hidden])');
  page.removeListener('dialog', acceptReload);
  assert.equal(await page.locator('#workspace').isVisible(), false, 'refresh must not reopen research content automatically');
  await page.locator('#welcome-drafts').click(); await page.locator('#draft-dialog:not([hidden]) .draft-row').first().click();
  await page.waitForSelector('#workspace:not([hidden])');
  await stage('facts'); await page.locator(`.g-node[data-node-id="${factA.id}"]`).click();
  assert.deepEqual(await selected('g-fact-subjects'), [subjectA]);
  const restored = await download('restored'); assert.deepEqual(restored.graph, savedGraph);
  await load(restored); await stage('facts'); await page.locator(`.g-node[data-node-id="${factB.id}"]`).click();
  assert.deepEqual(await selected('g-fact-subjects'), [subjectB]);
  assert.deepEqual((await download('roundtrip')).graph, savedGraph);
  check('refresh starts empty until explicit draft restore and both restore and JSON roundtrip retain all saved subject identities');

  const known = fixture(); known.graph.entities.push({ id: 'mapped', name: '人工共指主体', aliases: [] });
  known.graph.mentions.push({ id: 'mapped_mention', entity_id: 'mapped', evidence_id: ev('demo_video', 'v1'), description: '人工确认的视觉提及' });
  await load(known); await stage('evidence'); await page.locator('.segment-row').first().click(); await page.locator('#build-fact').click();
  assert.equal(await expectSingle('g-fact-subjects', '人工共指主体'), 'mapped');
  check('explicit evidence-to-subject coreference takes priority over the raw textual subject clue');

  const historical = fixture();
  historical.graph.facts.push({ id: 'historical_fact', text: '已有人工事实', subject_ids: ['unrelated_first'], kind: 'observation', speaker_id: '', review_status: 'needs_review' });
  historical.graph.links.push({ id: 'historical_support', from_type: 'evidence', from_id: ev('demo_video', 'v1'), to_type: 'fact', to_id: 'historical_fact', type: 'supports' });
  await load(historical); await stage('facts'); await page.locator('.g-node[data-node-id="historical_fact"]').click();
  assert.deepEqual(await selected('g-fact-subjects'), ['unrelated_first']);
  assert.deepEqual((await download('historical-opened')).graph, historical.graph);
  await save('保存事实', '事实已保存');
  assert.deepEqual((await download('historical-saved')).graph.facts[0].subject_ids, ['unrelated_first']);
  check('opening and saving a historical fact preserves its existing manual subject identity instead of silently replacing it');

  const narrowed = fixture();
  narrowed.graph.entities.push({ id: 'focused_A', name: '已选主体甲', aliases: [] }, { id: 'present_B', name: '同窗其他主体乙', aliases: [] });
  narrowed.graph.mentions.push(
    { id: 'mention_A', entity_id: 'focused_A', evidence_id: ev('demo_video', 'v1'), description: '同窗主体甲' },
    { id: 'mention_B', entity_id: 'present_B', evidence_id: ev('demo_video', 'v1'), description: '同窗主体乙' });
  narrowed.graph.facts.push({ id: 'focused_fact', text: '该事实只描述主体甲', subject_ids: ['focused_A'], kind: 'observation', speaker_id: '', review_status: 'needs_review' });
  narrowed.graph.links.push({ id: 'focused_support', from_type: 'evidence', from_id: ev('demo_video', 'v1'), to_type: 'fact', to_id: 'focused_fact', type: 'supports' });
  await load(narrowed); await stage('events'); await choose('g-event-facts', 'focused_fact');
  assert.equal(await expectSingle('g-event-subjects', '已选主体甲'), 'focused_A');
  await page.locator('#g-event-title').fill('主体甲的事件'); await save('保存复合事件', '复合事件已保存');
  await stage('emotions'); await choose('g-state-facts', 'focused_fact');
  assert.equal(await expectSingle('g-state-subject', '已选主体甲'), 'focused_A');
  await page.locator('#g-state-label').fill('平静'); await page.locator('#g-state-start').fill('1'); await page.locator('#g-state-end').fill('3');
  await save('保存情感状态', '情感状态已保存');
  const narrowedResult = await download('narrowed-subject');
  assert.deepEqual(narrowedResult.graph.events[0].subject_ids, ['focused_A']);
  assert.equal(narrowedResult.graph.emotion_states[0].subject_id, 'focused_A');
  check('events and emotions inherit the subjects actually selected in their fact instead of reintroducing other people visible in its evidence');

  await load(first); await stage('evidence'); await page.locator('.segment-row').first().click();
  await page.locator('#subject-id').fill('主体丙'); await page.locator('#build-fact').click();
  const subjectC = await expectSingle('g-fact-subjects', '主体丙'); assert.notEqual(subjectC, subjectA);
  await page.locator('#g-fact-text').fill('主体丙的新事实。'); await save('保存事实', '事实已保存');
  const changedClue = await download('changed-evidence-subject');
  assert.deepEqual(changedClue.graph.facts.find(entry => entry.id === factA.id).subject_ids, [subjectA]);
  assert.equal(changedClue.graph.facts.find(entry => entry.id === factA.id).review_status, 'needs_review');
  assert.deepEqual(changedClue.graph.facts.find(entry => entry.text === '主体丙的新事实。').subject_ids, [subjectC]);
  assert.ok(changedClue.graph.mentions.some(entry => entry.entity_id === subjectC && entry.evidence_id === ev('demo_video', 'v1')));
  check('editing an evidence subject replaces stale automatic inheritance while preserving the old fact as an explicitly reviewable record');

  await load(fixture()); await stage('evidence'); await page.locator('.segment-row').first().click(); await page.locator('#build-fact').click();
  const originalDraftSubject = (await selected('g-fact-subjects'))[0]; assert.ok(originalDraftSubject);
  await page.locator('#g-fact-text').fill('主体变更后仍保留的自定义事实草稿。');
  await stage('evidence'); await page.locator('.segment-row').first().click(); await page.locator('#subject-id').fill('主体丁');
  await stage('facts');
  const revisedDraftSubject = await expectSingle('g-fact-subjects', '主体丁'); assert.notEqual(revisedDraftSubject, originalDraftSubject);
  assert.equal(await page.locator('#g-fact-text').inputValue(), '主体变更后仍保留的自定义事实草稿。');
  assert.deepEqual(await selected('g-fact-evidence'), [ev('demo_video', 'v1')]);
  await save('保存事实', '事实已保存');
  const revisedDraft = await download('draft-follows-subject');
  assert.deepEqual(revisedDraft.graph.facts[0].subject_ids, [revisedDraftSubject]);
  assert.equal(revisedDraft.graph.entities.find(entry => entry.id === revisedDraftSubject).name, '主体丁');
  check('an unsaved fact directly revisited after its evidence subject changes keeps its text and references while selecting and saving the new subject');

  const unknown = fixture(); unknown.items[0].segments.forEach(entry => { entry.annotations.subject_id = 'unknown'; });
  await load(unknown); await stage('evidence'); await page.locator('.segment-row').first().click(); await page.locator('#build-fact').click();
  const firstUnknown = (await selected('g-fact-subjects'))[0]; assert.ok(firstUnknown);
  await stage('evidence'); await page.locator('.segment-row').nth(1).click();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#build-fact').click();
  const nextUnknown = (await selected('g-fact-subjects'))[0]; assert.ok(nextUnknown); assert.notEqual(nextUnknown, firstUnknown);
  check('unknown evidence subjects remain separate identities across windows rather than being silently merged');

  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(new URL(origin).origin + '/') || request.url.startsWith('blob:'))));
  check('subject inheritance uses local data without application errors, uploads or third-party requests');
  await page.screenshot({ path: path.join(artifacts, 'subject-lineage-final.png'), fullPage: true });
  fs.writeFileSync(path.join(artifacts, 'subject-lineage-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, errors, request_count: requests.length }, null, 2));
  console.log(`Subject lineage verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'subject-lineage-failure.png'), fullPage: true }).catch(() => {});
  console.error('Subject lineage verification FAILED:', error); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
