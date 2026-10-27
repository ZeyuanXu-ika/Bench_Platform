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
const fixtures = path.join(root, '.tools', 'evidence-fact-browser-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
execFileSync(process.env.PYTHON_EXECUTABLE || 'python', ['-c',
  'import sys,zipfile;from pathlib import Path;r=Path(sys.argv[2]).resolve();z=zipfile.ZipFile(sys.argv[1]);assert all((r/i.filename).resolve().is_relative_to(r) for i in z.infolist());z.extractall(r)',
  path.join(root, 'samples', 'demo-task.zip'), fixtures]);
const videoPath = path.join(fixtures, 'demo-task', 'media', 'demo.mp4');
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
const ev = (item, window) => JSON.stringify([item, window]);
function emptyFixture() {
  const data = structuredClone(template); data.batch_id = 'evidence_fact_browser';
  data.graph = { status: 'draft', entities: [], mentions: [], facts: [], events: [], emotion_states: [], emotion_transitions: [], links: [] };
  for (const item of data.items) for (const segment of item.segments) segment.annotations = {
    subject_id: '', observation: '', local_fact: '', evidence_role: 'both', uncertainty: ''
  };
  parseResults(data); return data;
}
const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage(), checks = [], errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
const check = name => { checks.push(name); console.log('PASS:', name); };
const stage = async name => page.locator(`.g-tab[data-stage="${name}"]`).click();
let loadNumber = 0;
async function load(data) {
  const incoming = structuredClone(data); incoming.batch_id += `_${++loadNumber}`;
  await page.locator('#result-input').setInputFiles({ name: 'evidence-fact.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await page.waitForFunction(batch => document.getElementById('batch-id').value === batch, incoming.batch_id);
  await page.waitForSelector('#workspace:not([hidden])');
}
async function download(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const target = path.join(artifacts, `evidence-fact-${name}.json`); await download.saveAs(target);
  const data = JSON.parse(fs.readFileSync(target, 'utf8')); parseResults(data); return data;
}
async function saveEvidence() {
  await page.locator('#build-fact').click();
  await page.waitForFunction(() => document.getElementById('evidence-fact-status').textContent.includes('证据与事实已保存'));
  assert.equal(await page.locator('.g-tab.active').getAttribute('data-stage'), 'evidence', 'unified save must remain beside the media and time window');
}
async function createSubject(name) {
  await page.locator('#evidence-new-subject-name').fill(name);
  await page.locator('#evidence-add-subject').click();
  const row = page.locator('#evidence-subjects label').filter({ hasText: name }).last();
  await row.locator('input[type=checkbox]').waitFor();
  assert.equal(await row.locator('input[type=checkbox]').isChecked(), true);
  return row.locator('input[type=checkbox]').getAttribute('value');
}
async function checkedSubjects() { return page.locator('#evidence-subjects input[type=checkbox]:checked').evaluateAll(nodes => nodes.map(node => node.value)); }
async function setEvidenceSubject(id, checked = true) {
  const inputs = page.locator('#evidence-subjects input[type=checkbox]');
  const index = await inputs.evaluateAll((nodes, id) => nodes.findIndex(node => node.value === id), id);
  assert.ok(index >= 0, `missing task subject ${id}`); await inputs.nth(index).setChecked(checked);
}
async function choose(id, value, checked = true) {
  const inputs = page.locator(`[data-control-id="${id}"] input[type=checkbox]`);
  const index = await inputs.evaluateAll((nodes, id) => nodes.findIndex(node => node.value === id), value);
  assert.ok(index >= 0, `missing reference ${id}:${value}`); await inputs.nth(index).setChecked(checked);
}
async function saveGraph(name) {
  await page.getByRole('button', { name, exact: true }).click();
  assert.equal(await page.locator('.g-feedback').evaluate(node => node.classList.contains('error')), false);
}

try {
  await page.goto(origin); await page.waitForSelector('#welcome:not([hidden])');
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await load(emptyFixture()); await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#evidence-subjects input[type=checkbox]').count(), 0);
  assert.equal(await page.locator('#local-fact').isVisible(), false);
  assert.equal(await page.locator('#observation').isVisible(), true);
  assert.equal(await page.locator('.annotation-panel textarea:visible').count(), 1, 'evidence and fact share one visible description input');
  const subjectA = await createSubject('甲（递交材料的人）'), subjectB = await createSubject('乙（接收材料的人）');
  assert.deepEqual(new Set(await checkedSubjects()), new Set([subjectA, subjectB]));
  await page.locator('#observation').fill('甲把材料递给乙，乙接过材料。');
  await page.locator('#evidence-fact-review').selectOption('confirmed');
  await saveEvidence();
  const first = await download('first'); const record = first.items[0].segments[0];
  const fact = first.graph.facts.find(entry => entry.id === record.annotations.fact_id);
  assert.ok(fact, 'one unified save must create an actual graph fact');
  assert.equal(first.graph.facts.length, 1); assert.equal(fact.text, '甲把材料递给乙，乙接过材料。');
  assert.deepEqual(new Set(fact.subject_ids), new Set([subjectA, subjectB]));
  assert.deepEqual(new Set(record.annotations.subject_ids), new Set([subjectA, subjectB]));
  assert.equal(record.annotations.observation, fact.text);
  assert.equal(first.graph.mentions.filter(mention => mention.evidence_id === ev('demo_video', 'v1')).length, 2);
  assert.ok(first.graph.links.some(link => link.from_id === ev('demo_video', 'v1') && link.to_id === fact.id && link.type === 'supports'));
  check('one evidence editor creates multiple named subjects and saves its only description as a graph fact in place');

  const edgeIDs = first.graph.links.map(link => link.id).sort();
  await saveEvidence(); const repeated = await download('repeated');
  assert.equal(repeated.graph.facts.length, 1); assert.equal(repeated.items[0].segments[0].annotations.fact_id, fact.id);
  assert.deepEqual(repeated.graph.links.map(link => link.id).sort(), edgeIDs);
  assert.equal(repeated.revision, first.revision, 'a repeated unchanged save must not create a new result revision');
  check('repeated unified saves retain the fact identity, relationship identities and result revision');

  await stage('events'); await choose('g-event-facts', fact.id);
  await page.locator('#g-event-subjects').selectOption([subjectA, subjectB]);
  await page.locator('#g-event-title').fill('甲向乙递交材料'); await page.locator('#g-event-review').selectOption('confirmed');
  await saveGraph('保存复合事件');
  let layered = await download('event'); const event = layered.graph.events[0];
  assert.deepEqual(new Set(event.subject_ids), new Set([subjectA, subjectB]));
  await stage('emotions'); await choose('g-state-facts', fact.id); await page.locator('#g-state-subject').selectOption(subjectA);
  await choose('g-state-events', event.id); await page.locator('#g-state-label').fill('平静');
  await page.locator('#g-state-start').fill('1'); await page.locator('#g-state-end').fill('3');
  await page.locator('#g-state-review').selectOption('confirmed'); await saveGraph('保存情感状态');
  layered = await download('state'); const state = layered.graph.emotion_states[0]; assert.equal(state.subject_id, subjectA);
  check('compound events and emotion states directly reference the fact produced beside the evidence and inherit its selected subjects');

  await stage('evidence'); await page.locator('.segment-row').first().click();
  await page.locator('#observation').fill('甲把两份材料递给乙，乙接过材料。');
  await page.locator('#evidence-fact-review').selectOption('confirmed'); await saveEvidence();
  const updated = await download('updated');
  assert.equal(updated.graph.facts.length, 1); assert.equal(updated.graph.facts[0].id, fact.id);
  assert.equal(updated.graph.facts[0].text, '甲把两份材料递给乙，乙接过材料。');
  assert.equal(updated.graph.events.find(entry => entry.id === event.id).review_status, 'needs_review');
  assert.equal(updated.graph.emotion_states.find(entry => entry.id === state.id).review_status, 'needs_review');
  check('editing the unified description updates the same fact and requests review of its actual event and emotion dependents');

  await page.locator('.segment-row').nth(1).click();
  await setEvidenceSubject(subjectA); await page.locator('#observation').fill('甲整理剩余材料。'); await saveEvidence();
  const second = await download('second-window'); const secondFact = second.graph.facts.find(entry => entry.text === '甲整理剩余材料。');
  assert.deepEqual(secondFact.subject_ids, [subjectA]);
  await page.locator('.segment-row').first().click(); await setEvidenceSubject(subjectB, false); await saveEvidence();
  const narrowed = await download('deselected');
  assert.deepEqual(narrowed.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectA]);
  assert.deepEqual(narrowed.items[0].segments[1].annotations.subject_ids, [subjectA]);
  assert.ok(narrowed.graph.entities.some(entry => entry.id === subjectB), 'unchecking a window must not delete a reusable person');
  check('subject checkboxes are window-specific, reuse task identities and never delete another window or the subject itself');

  await setEvidenceSubject(subjectB); await page.locator('#evidence-fact-kind').selectOption('reported_speech');
  await page.locator('#evidence-fact-speaker').selectOption(subjectA);
  await page.locator('#observation').fill('甲称乙已收到材料。'); await saveEvidence();
  const reported = await download('reported'); const statement = reported.graph.facts.find(entry => entry.id === fact.id);
  assert.equal(statement.kind, 'reported_speech'); assert.equal(statement.speaker_id, subjectA);
  assert.deepEqual(new Set(statement.subject_ids), new Set([subjectA, subjectB]));
  check('reported speech keeps the speaker explicit rather than promoting the spoken claim into an observed event');

  await stage('facts'); await page.locator(`.g-node[data-node-id="${fact.id}"]`).click();
  await page.locator('#g-fact-subjects').selectOption([subjectB]);
  await page.locator('#g-fact-text').fill('甲称乙已收到两份材料。'); await saveGraph('保存事实');
  await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '甲称乙已收到两份材料。');
  assert.equal(await page.locator('#evidence-fact-speaker').inputValue(), subjectA);
  await saveEvidence();
  const advanced = await download('advanced-edited');
  assert.deepEqual(advanced.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectB]);
  assert.equal(advanced.graph.facts.find(entry => entry.id === fact.id).speaker_id, subjectA);
  assert.equal(advanced.items[0].segments[0].annotations.observation, advanced.graph.facts.find(entry => entry.id === fact.id).text);
  check('editing a linked fact in the advanced fact page updates the same description when returning to its evidence window');

  const savedGraph = advanced.graph, savedAnnotation = advanced.items[0].segments[0].annotations;
  const reloadDialog = dialog => dialog.accept(); page.once('dialog', reloadDialog); await page.reload(); await page.waitForSelector('#welcome:not([hidden])');
  page.removeListener('dialog', reloadDialog);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.locator('#welcome-drafts').click(); await page.locator('#draft-dialog .draft-row').first().click();
  await page.waitForSelector('#workspace:not([hidden])'); await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.deepEqual(new Set(await checkedSubjects()), new Set([subjectA, subjectB]));
  const restored = await download('restored'); assert.deepEqual(restored.graph, savedGraph);
  assert.deepEqual(restored.items[0].segments[0].annotations, savedAnnotation);
  await load(restored); const roundtrip = await download('roundtrip'); assert.deepEqual(roundtrip.graph, savedGraph);
  assert.deepEqual(roundtrip.items[0].segments[0].annotations, savedAnnotation);
  check('explicit draft restoration and result reimport preserve multiple subjects, the primary fact binding and the full graph');

  await stage('facts'); await page.locator(`.g-node[data-node-id="${fact.id}"]`).click();
  await page.locator('#g-fact-subjects').selectOption([subjectA]); await saveGraph('保存事实');
  const selectedSubset = await download('subset-before-inline');
  assert.deepEqual(selectedSubset.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectA]);
  assert.deepEqual(new Set(selectedSubset.items[0].segments[0].annotations.subject_ids), new Set([subjectA, subjectB]));
  await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.deepEqual(new Set(await checkedSubjects()), new Set([subjectA, subjectB]));
  await saveEvidence(); const subsetUnchanged = await download('subset-inline-unchanged');
  assert.deepEqual(subsetUnchanged.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectA]);
  assert.equal(subsetUnchanged.revision, selectedSubset.revision, 'an unchanged inline save must not broaden the advanced fact subject subset');
  await page.locator('#observation').fill('甲说明材料已经交付。'); await saveEvidence();
  const subsetEdited = await download('subset-inline-edited');
  assert.deepEqual(subsetEdited.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectA]);
  assert.deepEqual(new Set(subsetEdited.items[0].segments[0].annotations.subject_ids), new Set([subjectA, subjectB]));
  await page.locator('#attach-input').setInputFiles(videoPath);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('#complete-item').click();
  await page.waitForFunction(() => document.getElementById('progress-label').textContent.startsWith('1 / 2'));
  const subsetCompleted = await download('subset-completed');
  assert.deepEqual(subsetCompleted.graph.facts.find(entry => entry.id === fact.id).subject_ids, [subjectA]);
  assert.deepEqual(new Set(subsetCompleted.items[0].segments[0].annotations.subject_ids), new Set([subjectA, subjectB]));
  check('advanced fact subjects stay narrower than evidence participants across unchanged inline save, text editing and real-media task completion');

  const legacy = emptyFixture(); legacy.items[0].segments[0].annotations = {
    subject_id: '旧主体', observation: '旧观察内容', local_fact: '不同的历史局部事实', evidence_role: 'both', uncertainty: ''
  };
  await load(legacy); await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.equal(await page.locator('#observation').inputValue(), '旧观察内容');
  assert.equal(await page.locator('#local-fact').isVisible(), false);
  const legacyOpened = await download('legacy-opened'); assert.equal(legacyOpened.items[0].segments[0].annotations.local_fact, '不同的历史局部事实');
  await page.locator('#observation').fill('更新后的客观事实'); await saveEvidence();
  const legacySaved = await download('legacy-saved');
  assert.equal(legacySaved.items[0].segments[0].annotations.local_fact, '不同的历史局部事实');
  assert.equal(legacySaved.graph.facts.find(entry => entry.id === legacySaved.items[0].segments[0].annotations.fact_id).text, '更新后的客观事实');
  check('legacy observation and a different historical local-fact field survive opening and unified saving without silent loss');

  await stage('facts'); const boundID = legacySaved.items[0].segments[0].annotations.fact_id;
  await page.locator(`.g-node[data-node-id="${boundID}"]`).click(); page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除事实', exact: true }).click();
  const deleted = await download('deleted-fact');
  assert.ok(!deleted.graph.facts.some(entry => entry.id === boundID));
  assert.ok(!deleted.items[0].segments[0].annotations.fact_id);
  assert.ok(!deleted.graph.links.some(entry => entry.to_type === 'fact' && entry.to_id === boundID));
  check('deleting the linked fact cleans its primary binding and incident relationships without leaving an invalid result');

  await stage('evidence'); await page.locator('.segment-row').first().click();
  const reusable = await page.locator('#evidence-subjects input[type=checkbox]').evaluateAll(nodes => nodes.map(node => node.value));
  assert.ok(reusable.length);
  for (const id of await checkedSubjects()) await setEvidenceSubject(id, false);
  const cleared = await download('cleared-subjects');
  assert.deepEqual(cleared.items[0].segments[0].annotations.subject_ids, []);
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存'));
  const clearReloadDialog = dialog => dialog.accept(); page.once('dialog', clearReloadDialog);
  await page.reload(); page.removeListener('dialog', clearReloadDialog); await page.waitForSelector('#welcome:not([hidden])');
  await page.locator('#welcome-drafts').click(); await page.locator('#draft-dialog .draft-row').first().click();
  await page.waitForSelector('#workspace:not([hidden])'); await stage('evidence'); await page.locator('.segment-row').first().click();
  assert.deepEqual(await checkedSubjects(), []);
  const restoredCatalog = await page.locator('#evidence-subjects input[type=checkbox]').evaluateAll(nodes => nodes.map(node => node.value));
  assert.deepEqual(new Set(restoredCatalog), new Set(reusable));
  await setEvidenceSubject(reusable[0]);
  assert.deepEqual(await checkedSubjects(), [reusable[0]]);
  check('clearing every subject stays explicitly empty after refresh while the task catalog keeps reusable subject identities');

  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(new URL(origin).origin + '/') || request.url.startsWith('blob:'))));
  check('combined evidence and fact annotation produces no browser exceptions, media uploads or third-party resource requests');
  await page.screenshot({ path: path.join(artifacts, 'evidence-fact-final.png'), fullPage: true, animations: 'disabled' });
  fs.writeFileSync(path.join(artifacts, 'evidence-fact-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, errors, request_count: requests.length }, null, 2));
  console.log(`Evidence/fact browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'evidence-fact-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  console.error('Evidence/fact browser verification FAILED:', error); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
