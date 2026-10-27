import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results');
fs.mkdirSync(artifacts, { recursive: true });
const origin = process.env.BASE_URL || 'http://127.0.0.1:8787/';
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const browsers = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(browsers)) for (const dir of fs.readdirSync(browsers).sort().reverse()) {
    const candidate = path.join(browsers, dir, 'chrome-win64', 'chrome.exe');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
  }
}
const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
const checks = [], errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
const check = name => { checks.push(name); console.log('PASS:', name); };
const ev = (item, window) => JSON.stringify([item, window]);
const template = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'demo-graph.json'), 'utf8'));
function reviewedFixture() {
  const result = structuredClone(template);
  for (const collection of ['facts', 'events', 'emotion_states', 'emotion_transitions']) {
    result.graph[collection].forEach(node => { node.review_status = 'confirmed'; });
  }
  result.graph.status = 'complete';
  parseResults(result); // Fail before opening the UI if the fixture itself is invalid.
  return result;
}
const stage = async name => page.locator(`.g-tab[data-stage="${name}"]`).click();
let loadNumber = 0;
async function load(data) {
  const incoming = structuredClone(data); incoming.batch_id += `_audit_${++loadNumber}`;
  const expectedTitle = incoming.items[0].title;
  await page.locator('#result-input').setInputFiles({ name: 'frontend-continuation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await page.waitForSelector('#workspace:not([hidden])');
  await page.waitForFunction(batch => document.getElementById('batch-id').value === batch, incoming.batch_id);
  await page.waitForFunction(title => document.getElementById('item-title').textContent === title, expectedTitle);
  await page.waitForFunction(count => document.querySelectorAll('.task-item').length === count, data.items.length);
}
async function downloadJSON(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const file = path.join(artifacts, `frontend-continuation-${name}.json`);
  await download.saveAs(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function downloadSVG(button, name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  const file = path.join(artifacts, `frontend-continuation-${name}.svg`);
  await download.saveAs(file);
  const source = fs.readFileSync(file, 'utf8');
  return page.evaluate(text => {
    const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
    return { parseErrors: xml.querySelectorAll('parsererror').length, scope: xml.documentElement.getAttribute('data-export-scope'),
      nodes: [...xml.querySelectorAll('g[data-node-id]')].map(node => ({ type: node.getAttribute('data-node-type'), id: node.getAttribute('data-node-id') })) };
  }, source);
}
const kinds = [
  { stage: 'facts', type: 'fact', id: 'fact_1', save: '保存事实', review: '#g-fact-review', field: '#g-fact-text', descendants: ['event_1', 'state_1', 'transition_1'] },
  { stage: 'events', type: 'event', id: 'event_1', save: '保存复合事件', review: '#g-event-review', field: '#g-event-title', descendants: ['transition_1'] },
  { stage: 'emotions', type: 'emotion_state', id: 'state_1', save: '保存情感状态', review: '#g-state-review', field: '#g-state-label', descendants: ['transition_1'] },
];
async function edit(kind) {
  await stage(kind.stage);
  await page.locator(`.g-node[data-node-id="${kind.id}"]`).click();
}
async function save(kind) {
  await page.getByRole('button', { name: kind.save, exact: true }).click();
  assert.equal(await page.locator('.g-feedback').evaluate(node => !node.hidden && node.classList.contains('error')), false);
}
function nodes(graph) { return [...graph.facts, ...graph.events, ...graph.emotion_states, ...graph.emotion_transitions]; }

try {
  await page.goto(origin);
  await page.waitForSelector('#welcome:not([hidden])');
  await load(reviewedFixture());
  await stage('facts');
  await page.locator('#g-fact-text').fill('UNSAVED_FACT_A');
  await stage('evidence');
  await page.locator('.segment-row').nth(1).click();
  let cancelObserved = false;
  page.once('dialog', async dialog => { cancelObserved = true; await dialog.dismiss(); });
  await page.locator('#build-fact').click();
  assert.equal(cancelObserved, true, 'Replacing a dirty new fact must require explicit confirmation');
  assert.equal(await page.locator('.g-tab.active').getAttribute('data-stage'), 'evidence');
  await stage('facts'); assert.equal(await page.locator('#g-fact-text').inputValue(), 'UNSAVED_FACT_A');
  await stage('evidence');
  let acceptObserved = false;
  page.once('dialog', async dialog => { acceptObserved = true; await dialog.accept(); });
  await page.locator('#build-fact').click();
  await page.waitForSelector('#g-fact-text');
  assert.equal(acceptObserved, true);
  assert.equal(await page.locator('#g-fact-text').inputValue(), template.items[0].segments[1].annotations.observation);
  assert.deepEqual(await page.locator('#g-fact-evidence').evaluate(select => [...select.selectedOptions].map(option => option.value)), [ev('demo_video', 'v2')]);
  await page.locator('#g-fact-subjects').selectOption('demo_subject');
  await page.locator('#g-fact-review').selectOption('confirmed'); await save(kinds[0]);
  check('replacing a dirty new fact requires confirmation; cancel retains its text and accept alone loads the new evidence seed');

  for (const kind of kinds) {
    const reordered = reviewedFixture(); reordered.graph.links.reverse();
    await load(reordered); await edit(kind);
    await page.locator(kind.review).selectOption('confirmed'); // Same value still emits a real control change.
    await save(kind);
    const result = await downloadJSON(`${kind.type}-unchanged`);
    assert.ok(nodes(result.graph).every(node => node.review_status === 'confirmed'), `${kind.type}: no-op save invalidated reviewed descendants`);
    assert.equal(result.graph.status, 'complete');
    assert.equal(result.revision, reordered.revision ?? 0);
    assert.deepEqual(result.graph.links.map(link => link.id).sort(), reordered.graph.links.map(link => link.id).sort());
  }
  check('unchanged saves of facts, events and emotion states retain all reviewed descendants');

  for (const kind of kinds) {
    await load(reviewedFixture()); await edit(kind);
    await page.locator(kind.review).selectOption('draft'); await save(kind);
    const result = await downloadJSON(`${kind.type}-review-only`);
    for (const node of nodes(result.graph)) assert.equal(node.review_status, node.id === kind.id ? 'draft' : 'confirmed');
  }
  check('changing only review metadata affects the selected record without forcing unrelated upper-level re-review');

  for (const kind of kinds) {
    await load(reviewedFixture()); await edit(kind);
    const original = await page.locator(kind.field).inputValue();
    await page.locator(kind.field).fill(original + ' / revised content');
    await page.locator(kind.review).selectOption('confirmed'); await save(kind);
    const result = await downloadJSON(`${kind.type}-content-changed`);
    for (const id of kind.descendants) assert.equal(nodes(result.graph).find(node => node.id === id).review_status, 'needs_review');
  }
  check('real fact, event and emotional-state content changes still invalidate their actual descendants');

  await load(reviewedFixture()); await edit(kinds[0]);
  const evidenceCards = page.locator('.g-choice-picker[data-control-id="g-fact-evidence"]');
  const audioIndex = await evidenceCards.locator('input[type=checkbox]').evaluateAll((inputs, key) => inputs.findIndex(input => input.value === key), ev('demo_audio', 'a1'));
  assert.ok(audioIndex >= 0); await evidenceCards.locator('input[type=checkbox]').nth(audioIndex).uncheck();
  await page.locator('#g-fact-review').selectOption('confirmed'); await save(kinds[0]);
  const changedRefs = await downloadJSON('fact-evidence-changed');
  assert.equal(changedRefs.graph.links.filter(link => link.to_type === 'fact' && link.to_id === 'fact_1' && link.type === 'supports').length, 1);
  assert.equal(changedRefs.graph.events.find(node => node.id === 'event_1').review_status, 'needs_review');
  assert.equal(changedRefs.graph.emotion_transitions.find(node => node.id === 'transition_1').review_status, 'needs_review');
  check('changing actual evidence references via visible checkboxes invalidates dependent interpretations');

  const mixedRelations = reviewedFixture();
  mixedRelations.graph.events.push({ id: 'event_2', title: '第二个已复核事件', subject_ids: ['demo_subject'], timeline_id: 'demo_scene', review_status: 'confirmed' });
  mixedRelations.graph.links.push(
    { id: 'mixed_constitutes', from_type: 'fact', from_id: 'fact_2', to_type: 'event', to_id: 'event_2', type: 'constitutes' },
    { id: 'mixed_causes', from_type: 'event', from_id: 'event_2', to_type: 'emotion_transition', to_id: 'transition_1', type: 'causes' }
  );
  parseResults(mixedRelations); await load(mixedRelations); await stage('emotions');
  await page.locator('.g-node[data-node-id="transition_1"]').click();
  await page.locator('#g-transition-note').fill(mixedRelations.graph.emotion_transitions[0].note + ' 补充复核说明。');
  await page.locator('#g-transition-review').selectOption('confirmed');
  await page.getByRole('button', { name: '保存情感变化', exact: true }).click();
  const mixedSaved = await downloadJSON('mixed-event-relations');
  const eventRelations = Object.fromEntries(mixedSaved.graph.links.filter(link => link.to_type === 'emotion_transition' && link.to_id === 'transition_1').map(link => [link.from_id, link.type]));
  assert.deepEqual(eventRelations, { event_1: 'associated_with', event_2: 'causes' });
  assert.equal(await page.locator('#g-transition-event-relations select[data-event-id]').count(), 2);
  await page.locator('#g-transition-event-relations select[data-event-id="event_2"]').selectOption('associated_with');
  await page.locator('#g-transition-review').selectOption('confirmed');
  await page.getByRole('button', { name: '保存情感变化', exact: true }).click();
  const changedSecondRelation = await downloadJSON('second-event-relation-changed');
  assert.deepEqual(Object.fromEntries(changedSecondRelation.graph.links.filter(link => link.to_type === 'emotion_transition' && link.to_id === 'transition_1').map(link => [link.from_id, link.type])), { event_1: 'associated_with', event_2: 'associated_with' });
  await page.locator('#g-transition-event-relations select[data-event-id="event_1"]').selectOption('causes');
  await page.locator('#g-transition-review').selectOption('confirmed');
  await page.getByRole('button', { name: '保存情感变化', exact: true }).click();
  const changedFirstRelation = await downloadJSON('first-event-relation-changed');
  assert.deepEqual(Object.fromEntries(changedFirstRelation.graph.links.filter(link => link.to_type === 'emotion_transition' && link.to_id === 'transition_1').map(link => [link.from_id, link.type])), { event_1: 'causes', event_2: 'associated_with' });
  check('editing a transition preserves each event relation independently instead of promoting every association to causation');

  await load(reviewedFixture());
  for (const kind of kinds) {
    await edit(kind);
    const form = page.locator(`.g-form[data-editor-type="${kind.type}"]`);
    const layout = form.locator('..'), list = layout.locator(':scope > .g-node-list');
    assert.equal(await layout.evaluate(node => {
      const form = node.querySelector(':scope > .g-form'), list = node.querySelector(':scope > .g-node-list');
      return Boolean(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, 'DOM keyboard order must follow the visual editor -> list order');
    const formBox = await form.boundingBox(), listBox = await list.boundingBox(); assert.ok(formBox.x < listBox.x);
    await form.locator('.g-actions button').last().focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.g-node-list .g-list-top'))), true);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileForm = await form.boundingBox(), mobileList = await list.boundingBox(); assert.ok(mobileForm.y < mobileList.y);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1500, height: 1000 });
  }
  check('facts, events and emotion editors precede their lists in both DOM keyboard order and desktop/mobile layout');

  const large = structuredClone(template); large.batch_id = 'frontend_continuation_large'; large.items = [large.items[0]];
  large.items[0].segments = Array.from({ length: 201 }, (_, n) => ({ id: `w${n}`, start_time: 1, end_time: 2, label: 'visual_observation',
    annotations: { subject_id: 'P1', observation: `Evidence ${n}`, local_fact: '', evidence_role: 'event_support', uncertainty: '' } }));
  large.graph = { status: 'draft', entities: [{ id: 'P1', name: 'P1', aliases: [] }], mentions: [],
    facts: Array.from({ length: 201 }, (_, n) => ({ id: `f${n}`, text: `FACT_${n}`, subject_ids: ['P1'], kind: 'observation', speaker_id: '', review_status: 'draft' })),
    events: [], emotion_states: [], emotion_transitions: [],
    links: Array.from({ length: 201 }, (_, n) => ({ id: `l${n}`, from_type: 'evidence', from_id: ev(large.items[0].id, `w${n}`), to_type: 'fact', to_id: `f${n}`, type: 'supports' })) };
  parseResults(large); await load(large); await stage('graph');
  await page.locator('.g-graph-browser > summary').click();
  await page.locator('.g-graph-node[data-node-type="fact"][data-node-id="f200"]').click();
  assert.equal(await page.locator('#g-directed-svg [data-node-id="f200"]').count(), 1);
  assert.equal(await page.locator('#g-directed-svg [data-node-type="evidence"]').evaluateAll((nodes, key) => nodes.some(node => node.getAttribute('data-node-id') === key), ev(large.items[0].id, 'w200')), true);
  const focusedSVG = await downloadSVG('#g-export-svg', 'focused-view');
  assert.equal(focusedSVG.parseErrors, 0); assert.equal(focusedSVG.scope, 'current-view');
  assert.ok(focusedSVG.nodes.some(node => node.id === 'f200'));
  const fullSVG = await downloadSVG('#g-export-full-svg', 'full-graph');
  assert.equal(fullSVG.parseErrors, 0); assert.equal(fullSVG.scope, 'full');
  assert.equal(fullSVG.nodes.filter(node => node.type === 'fact').length, 201);
  assert.equal(fullSVG.nodes.filter(node => node.type === 'evidence').length, 201);
  check('a focused fact beyond the first 200 total nodes and its upstream evidence are visible; full SVG preserves every node');

  await page.getByRole('button', { name: '显示全部关系', exact: true }).click();
  assert.equal(await page.locator('#g-graph-prev').isDisabled(), true);
  let pages = 1;
  while (await page.locator('#g-graph-next').isEnabled()) {
    await page.locator('#g-graph-next').click(); pages++;
    assert.ok(pages <= 10, 'Graph pagination failed to reach a terminal page');
  }
  assert.ok(pages > 1); assert.equal(await page.locator('#g-graph-prev').isEnabled(), true);
  assert.equal(await page.locator('#g-directed-svg [data-node-id="f200"]').count(), 1);
  assert.ok((await page.locator('#g-graph-page-status').textContent()).trim());
  const lastPage = await downloadSVG('#g-export-svg', 'last-page');
  assert.equal(lastPage.scope, 'current-view'); assert.ok(lastPage.nodes.some(node => node.id === 'f200'));
  assert.ok(lastPage.nodes.length < fullSVG.nodes.length);
  await page.screenshot({ path: path.join(artifacts, 'frontend-continuation-large-graph.png'), fullPage: true });
  check('graph pagination reaches the last records and current-view export is explicitly distinct from full-graph export');

  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(new URL(origin).origin + '/') || request.url.startsWith('blob:'))), JSON.stringify(requests));
  check('continuation workflows produce no application errors, uploads or third-party requests');
  fs.writeFileSync(path.join(artifacts, 'frontend-continuation-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, errors, request_count: requests.length }, null, 2));
  console.log(`Frontend continuation verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'frontend-continuation-failure.png'), fullPage: true }).catch(() => {});
  console.error('Frontend continuation verification FAILED:', error); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
