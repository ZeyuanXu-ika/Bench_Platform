import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { blankGraph, normalizeGraph, graphIssues } from '../graph.mjs';
import { parseResults } from '../core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const fixtures = path.join(root, '.tools', 'graph-browser-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
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
const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
const errors = [], traffic = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => traffic.push({ method: request.method(), url: request.url() }));
const check = name => { checks.push(name); console.log('PASS:', name); };
const stage = async name => { await page.locator(`#graph-workbench button[data-stage="${name}"]`).click(); };
async function downloadJSON(name, targetPage = page) {
  const [download] = await Promise.all([targetPage.waitForEvent('download'), targetPage.locator('#download-result').click()]);
  const target = path.join(artifacts, name); await download.saveAs(target);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
async function waitSaved() {
  await page.waitForFunction(() => document.getElementById('draft-status').textContent.includes('草稿已存'));
}
async function management() {
  if (!(await page.locator('details.g-management').evaluate(node => node.open))) await page.locator('details.g-management > summary').click();
}
async function save(name, feedback) {
  await page.getByRole('button', { name, exact: true }).click();
  if (feedback) await page.waitForFunction(text => document.querySelector('.g-feedback').textContent.includes(text) && !document.querySelector('.g-feedback').classList.contains('error'), feedback);
}
async function makeWindow(kind, start, end, text) {
  await page.locator(`#${kind}`).evaluate((media, time) => { media.currentTime = time; }, start);
  await page.locator('#play-toggle').focus(); await page.keyboard.press('[');
  await page.locator(`#${kind}`).evaluate((media, time) => { media.currentTime = time; }, end);
  await page.keyboard.press(']'); await page.locator('#add-segment').click();
  await page.locator('#segment-category').selectOption(kind === 'video' ? 'visual_observation' : 'acoustic_observation');
  const existing = page.locator('#evidence-subjects label').filter({ hasText: 'P1' }).first();
  if (await existing.count()) await existing.locator('input[type=checkbox]').check();
  else { await page.locator('#evidence-new-subject-name').fill('P1'); await page.locator('#evidence-add-subject').click(); }
  await page.locator('#observation').fill(text);
  await page.locator('#evidence-role').selectOption('both');
}
async function assertNoDangling(data) {
  const workspace = parseResults(data);
  assert.doesNotThrow(() => normalizeGraph(data.graph, workspace));
  return workspace;
}
async function assertEditorLayout() {
  const boxes = await page.locator('.g-editor-layout').evaluateAll(layouts => layouts.map(layout => {
    const form = layout.querySelector('.g-form').getBoundingClientRect();
    const list = layout.querySelector('.g-node-list').getBoundingClientRect();
    return { form: { x: form.x, right: form.right, width: form.width }, list: { x: list.x, right: list.right, width: list.width }, viewport: innerWidth };
  }));
  assert.ok(boxes.length);
  for (const { form, list, viewport } of boxes) {
    assert.ok(form.x + form.width <= list.x + 2, 'desktop main editor must sit to the left of its vertical node list');
    assert.ok(form.width > list.width, 'desktop editor should have more width than its node list');
    assert.ok(form.x >= 0 && list.right <= viewport + 1, 'stage editor and list fit inside the page viewport');
  }
}

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
  await page.goto(origin);
  await page.waitForSelector('#welcome:not([hidden])');
  await page.locator('#manifest-input').setInputFiles(path.join(taskDir, 'tasks.json'));
  await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await makeWindow('video', 1, 2, '合成测试事实一：视频测试信号出现');
  await makeWindow('video', 3, 4, '合成测试事实二：视频测试信号改变');
  await page.locator('#complete-item').click();
  await page.locator('.task-item[data-media-type=audio]').click();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await makeWindow('audio', 1, 2, '合成测试事实一：音频测试信号出现');
  await makeWindow('audio', 3, 4, '合成测试事实二：音频测试信号改变');
  await page.locator('#complete-item').click();
  const evidenceOnly = await downloadJSON('graph-evidence-only.json');
  const video = evidenceOnly.items.find(item => item.id === 'video_demo_1');
  const audio = evidenceOnly.items.find(item => item.id === 'audio_demo_1');
  const refs = [JSON.stringify([video.id, video.segments[0].id]), JSON.stringify([video.id, video.segments[1].id]),
    JSON.stringify([audio.id, audio.segments[0].id]), JSON.stringify([audio.id, audio.segments[1].id])];
  assert.equal(evidenceOnly.graph.facts.length, 4, 'completing evidence now saves its four window facts in the same workflow');
  check('four independently editable video/audio evidence windows save their own linked facts when completed');

  await management();
  await page.locator('#g-entity-name').fill('合成主体 P1');
  await page.locator('#g-entity-aliases').fill('画面主体，声音主体');
  await save('保存主体', '主体已保存');
  const entityID = await page.locator('#g-mention-entity option').filter({ hasText: '合成主体 P1' }).getAttribute('value');
  assert.ok(entityID);
  for (const [description, evidence] of [['第一视频窗中的画面主体', refs[0]], ['第一音频窗中的声音主体', refs[2]], ['第二视频窗中的画面主体', refs[1]], ['第二音频窗中的声音主体', refs[3]]]) {
    const cancel = page.getByRole('button', { name: '取消编辑', exact: true });
    if (await cancel.count()) await cancel.click();
    await page.locator('#g-mention-description').fill(description);
    await page.locator('#g-mention-entity').selectOption(entityID);
    await page.locator('#g-mention-evidence').selectOption(evidence);
    await save('新增提及', '主体提及已保存');
  }
  for (let index = 0; index < 2; index++) {
    await page.locator(`#g-align-timeline-${index}`).fill('scene_shared');
    await page.locator(`#g-align-offset-${index}`).fill(index ? '-0.1' : '0');
    await page.locator('.g-alignment-row').nth(index).getByRole('button', { name: '保存对齐', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.g-feedback').textContent.includes('媒体对齐已保存'));
  }
  const aligned = await downloadJSON('graph-aligned-evidence.json');
  assert.ok(aligned.graph.entities.some(entity => entity.id === entityID));
  const sharedMentions = aligned.graph.mentions.filter(mention => mention.entity_id === entityID);
  assert.equal(sharedMentions.length, 4);
  assert.deepEqual(new Set(sharedMentions.map(mention => mention.evidence_id)), new Set(refs));
  assert.ok(aligned.items.every(item => item.timeline_id === 'scene_shared'));
  assert.equal(aligned.items.find(item => item.id === 'audio_demo_1').time_offset_s, -.1);
  check('explicit cross-modal mentions share one subject and media align on a common timeline with signed offsets');

  await stage('facts');
  await assertEditorLayout();
  for (const initial of evidenceOnly.graph.facts) {
    await page.locator(`.g-node[data-node-id="${initial.id}"]`).click();
    await page.locator('#g-fact-review').selectOption('confirmed'); await save('保存事实', '事实已保存');
  }
  await page.getByRole('button', { name: '新增事实', exact: true }).click();
  await page.locator('#g-fact-text').fill('未提交的事实表单草稿');
  await page.locator('#g-fact-subjects').selectOption([entityID]);
  await page.locator('#g-fact-evidence').selectOption([refs[0]]);
  await stage('events'); await assertEditorLayout(); await stage('facts');
  assert.equal(await page.locator('#g-fact-text').inputValue(), '未提交的事实表单草稿');
  assert.deepEqual(await page.locator('#g-fact-evidence').evaluate(select => [...select.selectedOptions].map(option => option.value)), [refs[0]]);
  const evidencePicker = page.locator('.g-choice-picker[data-control-id="g-fact-evidence"]');
  await page.locator('#g-fact-evidence-filter').fill('音频');
  assert.equal(await evidencePicker.locator('input[type=checkbox]').count(), 2);
  await evidencePicker.locator('input[type=checkbox]').first().check();
  assert.equal(await evidencePicker.locator('.g-choice-count').textContent(), '已选 2 / 4');
  await evidencePicker.locator('input[type=checkbox]').first().uncheck();
  assert.equal(await evidencePicker.locator('.g-choice-count').textContent(), '已选 1 / 4');
  await evidencePicker.locator('input[type=checkbox]').first().check();
  await page.locator('#g-fact-evidence-filter').fill('不存在的素材名字');
  assert.equal(await evidencePicker.locator('input[type=checkbox]').count(), 0);
  assert.equal(await evidencePicker.locator('.g-choice-count').textContent(), '已选 2 / 4');
  await page.locator('#g-fact-evidence-filter').fill('');
  assert.equal(await evidencePicker.locator('input[type=checkbox]:checked').count(), 2);
  const factIDs = [];
  for (const [index, text] of ['P1 在第一区间出现合成测试信号', 'P1 在第二区间改变合成测试信号'].entries()) {
    if (index) await page.getByRole('button', { name: '新增事实', exact: true }).click();
    await page.locator('#g-fact-text').fill(text);
    await page.locator('#g-fact-kind').selectOption('observation');
    await page.locator('#g-fact-subjects').selectOption([entityID]);
    if (index) await page.locator('#g-fact-evidence').selectOption([refs[1], refs[3]]);
    await page.locator('#g-fact-review').selectOption('confirmed');
    assert.equal(await page.locator('#g-fact-review').inputValue(), 'confirmed', 'review selector immediately before saving');
    await save('保存事实', '事实已保存');
    assert.equal(await page.locator('#g-fact-review').inputValue(), 'confirmed', 'review selector immediately after saving');
    factIDs.push(await page.locator('.g-node.active').getAttribute('data-node-id'));
  }
  const facts = await downloadJSON('graph-facts.json');
  assert.equal(facts.graph.facts.length, 6, 'four unified window facts remain alongside two explicit multimodal facts');
  assert.ok(facts.graph.facts.every(fact => fact.review_status === 'confirmed'));
  assert.equal(facts.graph.links.filter(link => link.type === 'supports' && factIDs.includes(link.to_id)).length, 4);
  assert.deepEqual(facts.graph.links.filter(link => link.type === 'supports' && link.to_id === factIDs[0]).map(link => link.from_id).sort(), [refs[0], refs[2]].sort());
  check('visible reference cards support search, check/uncheck and counts while saved JSON retains exactly the selected evidence');
  check('independent confirmed facts each combine multiple video/audio evidence references');

  await stage('events');
  await assertEditorLayout();
  await page.locator('#g-event-title').fill('未提交的事件表单草稿');
  await page.locator('#g-event-facts').selectOption([factIDs[0]]);
  await stage('emotions'); await assertEditorLayout(); await stage('events');
  assert.equal(await page.locator('#g-event-title').inputValue(), '未提交的事件表单草稿');
  assert.deepEqual(await page.locator('#g-event-facts').evaluate(select => [...select.selectedOptions].map(option => option.value)), [factIDs[0]]);
  await page.locator('#g-event-title').fill('P1 的合成测试信号发生改变');
  await page.locator('#g-event-subjects').selectOption([entityID]);
  await page.locator('#g-event-facts').selectOption(factIDs);
  await page.locator('#g-event-review').selectOption('confirmed');
  await save('保存复合事件', '复合事件已保存');
  const eventID = await page.locator('.g-node.active').getAttribute('data-node-id');
  check('a specific event combines independent facts and derives its common source timeline');

  await stage('facts'); await downloadJSON('before-unsaved-form-check.json'); await waitSaved();
  assert.equal(await page.locator('#graph-workbench').getAttribute('data-unsaved-changes'), 'false');
  await page.locator('#g-fact-evidence-filter').fill('只过滤不改内容');
  assert.equal(await page.locator('#graph-workbench').getAttribute('data-unsaved-changes'), 'false', 'reference search must not dirty semantic form content');
  await page.locator('#g-fact-evidence-filter').fill('');
  const originalFactText = await page.locator('#g-fact-text').inputValue();
  const unsavedFactText = originalFactText + '（未提交的跨保存保护测试）';
  await page.locator('#g-fact-text').fill(unsavedFactText);
  assert.equal(await page.locator('#graph-workbench').getAttribute('data-unsaved-changes'), 'true');
  assert.equal(await page.locator('.g-unsaved-note').isVisible(), true);
  const leavingDialog = page.waitForEvent('dialog', { timeout: 5000 });
  const attemptedNavigation = page.goto(new URL('?leave-unsaved-form=1', origin).href, { timeout: 5000 }).catch(() => null);
  const leave = await leavingDialog; assert.equal(leave.type(), 'beforeunload'); await leave.dismiss(); await attemptedNavigation;
  assert.equal(await page.locator('#g-fact-text').inputValue(), unsavedFactText);
  await stage('events'); await save('保存复合事件', '复合事件已保存');
  await stage('facts');
  assert.equal(await page.locator('#g-fact-text').inputValue(), unsavedFactText, 'saving an event must preserve a different stage\'s unsaved fact form');
  assert.equal(await page.locator('#graph-workbench').getAttribute('data-unsaved-changes'), 'true');
  await page.locator('#g-fact-text').fill(originalFactText); await page.locator('#g-fact-review').selectOption('confirmed');
  await save('保存事实', '事实已保存');
  assert.equal(await page.locator('#graph-workbench').getAttribute('data-unsaved-changes'), 'false', 'saving the affected form must clear its unsaved flag');
  await stage('events'); await page.locator('#g-event-review').selectOption('confirmed'); await save('保存复合事件', '复合事件已保存');
  check('search stays clean, unsaved edits warn before leaving, unrelated saves preserve drafts and explicit save clears dirty state');

  await stage('emotions');
  await assertEditorLayout();
  await page.locator('#g-state-label').fill('未提交的情感表单草稿');
  await stage('facts'); await stage('emotions');
  assert.equal(await page.locator('#g-state-label').inputValue(), '未提交的情感表单草稿');
  check('desktop stage editors sit left of vertical lists and unsaved fact/event/emotion fields survive stage changes');
  const stateIDs = [];
  for (const [index, label] of ['平稳（合成验收）', '激动（合成验收）'].entries()) {
    if (index) await page.getByRole('button', { name: '新增情感状态', exact: true }).click();
    await page.locator('#g-state-subject').selectOption(entityID);
    await page.locator('#g-state-label').fill(label);
    await page.locator('#g-state-timeline').selectOption('scene_shared');
    await page.locator('#g-state-start').fill(index ? '2.9' : '.9');
    await page.locator('#g-state-end').fill(index ? '4' : '2');
    await page.locator('#g-state-intensity').selectOption(index ? '4' : '2');
    await page.locator('#g-state-facts').selectOption([factIDs[index]]);
    await page.locator('#g-state-events').selectOption([eventID]);
    await page.locator('#g-state-review').selectOption('confirmed');
    await save('保存情感状态', '情感状态已保存');
    stateIDs.push(await page.locator('.g-emotions > .g-editor-layout').first().locator('.g-node.active').getAttribute('data-node-id'));
  }
  await page.locator('#g-transition-subject').selectOption(entityID);
  await page.locator('#g-transition-from').selectOption(stateIDs[0]);
  await page.locator('#g-transition-to').selectOption(stateIDs[1]);
  await page.locator('#g-transition-events').selectOption([eventID]);
  await page.locator('#g-transition-relation').selectOption('associated_with');
  await page.locator('#g-transition-note').fill('合成数据功能验收；仅标记关联，不推定因果。');
  await page.locator('#g-transition-review').selectOption('confirmed');
  await save('保存情感变化', '情感变化已保存');
  check('one subject has grounded emotion states and an explicitly reviewed event-associated transition');

  await stage('graph');
  await page.waitForSelector('#g-directed-svg');
  assert.equal(await page.locator('details.g-management').evaluate(details => details.open), false);
  const fitMetrics = await page.locator('.g-svg-viewport').evaluate(viewport => ({ mode: viewport.dataset.sizeMode, width: viewport.clientWidth, svg: viewport.querySelector('svg').getBoundingClientRect().width }));
  assert.equal(fitMetrics.mode, 'fit'); assert.ok(fitMetrics.svg <= fitMetrics.width + 1);
  await page.locator('#g-graph-original').click();
  const originalMetrics = await page.locator('.g-svg-viewport').evaluate(viewport => ({ mode: viewport.dataset.sizeMode, width: viewport.clientWidth, svg: viewport.querySelector('svg').getBoundingClientRect().width }));
  assert.equal(originalMetrics.mode, 'original'); assert.equal(originalMetrics.svg, 1450);
  assert.equal(await page.locator('#g-graph-original').getAttribute('aria-pressed'), 'true');
  await page.locator('#g-graph-fit').click();
  assert.equal(await page.locator('#g-graph-fit').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('#g-directed-svg [marker-end]').count() >= 9);
  assert.ok(await page.locator('#g-directed-svg [data-node-type=evidence]').count() >= 4);
  const [svgDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#g-export-svg').click()]);
  const svgFile = path.join(artifacts, 'four-layer-directed-graph.svg'); await svgDownload.saveAs(svgFile);
  const svgText = fs.readFileSync(svgFile, 'utf8');
  assert.ok(svgText.includes('<svg') && svgText.includes('marker-end') && svgText.includes('合成'));
  assert.ok(svgText.includes('width="1450"'), 'exported SVG keeps its complete original canvas independently of display zoom');
  await page.locator('#g-directed-svg [data-node-type=evidence]').first().click();
  await page.getByRole('button', { name: '回放此证据', exact: true }).click();
  await page.waitForSelector('.editor-grid:not([hidden])');
  await page.waitForFunction(() => !document.getElementById('video').seeking && document.getElementById('video').readyState >= 2);
  assert.ok(Math.abs(await page.locator('#video').evaluate(video => video.currentTime) - 1) < .03, 'cross-file graph evidence navigation seeks to the selected evidence start');
  await stage('graph');
  await page.getByRole('button', { name: '标记四层完成', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.g-status').textContent === '四层已完成');
  const complete = await downloadJSON('four-layer-complete.json');
  const normalized = parseResults(complete);
  assert.equal(complete.schema_version, '2.0'); assert.equal(complete.graph.status, 'complete');
  assert.equal(graphIssues(normalized).filter(issue => issue.severity === 'error').length, 0);
  await page.screenshot({ path: path.join(artifacts, 'four-layer-directed-graph.png'), fullPage: true });
  check('saved cross-layer relationships generate arrow-directed SVG, export locally and pass four-layer completion checks');

  await page.locator('#result-input').setInputFiles(path.join(artifacts, 'four-layer-complete.json'));
  await page.waitForFunction(() => document.querySelector('.g-status').textContent === '四层已完成');
  const roundtrip = await downloadJSON('four-layer-roundtrip.json');
  assert.deepEqual(roundtrip.graph, complete.graph);
  await waitSaved(); await page.reload(); await restoreLatest(); await page.waitForSelector('#workspace:not([hidden])');
  await stage('graph');
  const reloaded = await downloadJSON('four-layer-reloaded.json');
  assert.deepEqual(reloaded.graph, complete.graph);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true); await page.reload(); await restoreLatest(); await page.waitForSelector('#workspace:not([hidden])');
  await stage('graph'); await page.waitForSelector('#g-directed-svg');
  assert.equal(await page.locator('.g-status').textContent(), '四层已完成');
  await context.setOffline(false);
  check('2.0 JSON roundtrip, browser reload and fully offline graph restoration preserve all nodes and relationships');

  await stage('evidence');
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.locator('.task-item[data-media-type=video]').click();
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  await page.locator('#segment-start').fill('1.1'); await page.locator('#segment-start').press('Tab');
  const invalidated = await downloadJSON('four-layer-needs-review.json');
  assert.equal(invalidated.graph.status, 'draft');
  assert.ok(invalidated.graph.facts.some(fact => fact.review_status === 'needs_review'));
  assert.ok(invalidated.graph.events.every(event => event.review_status === 'needs_review'));
  assert.ok(invalidated.graph.emotion_states.some(state => state.review_status === 'needs_review'));
  assert.ok(invalidated.graph.emotion_transitions.every(transition => transition.review_status === 'needs_review'));
  page.once('dialog', dialog => dialog.accept()); await page.locator('#delete-segment').click();
  const removedEvidence = await downloadJSON('four-layer-evidence-deleted.json');
  await assertNoDangling(removedEvidence);
  assert.equal(removedEvidence.graph.links.some(link => link.from_type === 'evidence' && link.from_id === refs[0]), false);
  assert.equal(removedEvidence.graph.mentions.some(mention => mention.evidence_id === refs[0]), false);
  check('changing evidence invalidates dependent upper layers and deleting it removes evidence links and mentions safely');

  await stage('events');
  await page.locator('.g-node-list .g-node').first().click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '删除选中复合事件', exact: true }).click();
  const removedEvent = await downloadJSON('four-layer-event-deleted.json'); await assertNoDangling(removedEvent);
  assert.equal(removedEvent.graph.events.length, 0);
  assert.equal(removedEvent.graph.links.some(link => link.from_type === 'event' || link.to_type === 'event'), false);
  assert.ok(removedEvent.graph.emotion_states.every(state => state.review_status === 'needs_review'));
  check('graph-node deletion cleans incident edges and marks affected annotations for review');

  const lastWindow = structuredClone(complete); lastWindow.graph = blankGraph();
  for (const item of lastWindow.items) {
    delete item.subject_ids;
    item.segments = item.id === 'video_demo_1' ? [item.segments[0]] : []; item.status = item.segments.length ? 'complete' : 'draft';
    for (const segment of item.segments) { delete segment.annotations.subject_ids; delete segment.annotations.fact_id; }
  }
  const lastWindowFile = path.join(fixtures, 'completed-single-window.json'); fs.writeFileSync(lastWindowFile, JSON.stringify(lastWindow));
  await page.locator('#result-input').setInputFiles(lastWindowFile);
  await stage('evidence');
  await page.locator('#folder-input').setInputFiles(taskDir);
  await page.locator('.task-item[data-media-type=video]').click();
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.locator('.segment-row').first().click();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#delete-segment').click();
  const emptyRecord = await downloadJSON('completed-last-window-deleted.json');
  const emptiedVideo = emptyRecord.items.find(item => item.id === 'video_demo_1');
  assert.equal(emptiedVideo.segments.length, 0); assert.equal(emptiedVideo.status, 'draft');
  await assertNoDangling(emptyRecord);
  check('deleting the last window of a completed material returns it to a valid exportable draft');

  const legacy = structuredClone(complete); legacy.schema_version = '1.0'; delete legacy.graph;
  for (const item of legacy.items) {
    delete item.subject_ids;
    for (const segment of item.segments) {
      segment.annotations.subject_id = 'unknown'; delete segment.annotations.subject_ids; delete segment.annotations.fact_id;
    }
  }
  const legacyFile = path.join(fixtures, 'legacy-v1.json'); fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  await page.locator('#result-input').setInputFiles(legacyFile);
  await page.waitForFunction(() => document.querySelector('.g-status').textContent === '四层待完成');
  const migrated = await downloadJSON('legacy-to-v2.json');
  assert.equal(migrated.schema_version, '2.0');
  assert.equal(migrated.graph.facts.length, 4);
  assert.ok(migrated.graph.facts.every(fact => fact.review_status !== 'confirmed'));
  assert.equal(new Set(migrated.graph.mentions.map(mention => mention.entity_id)).size, 4);
  assert.deepEqual(migrated.items.map(item => item.segments.map(segment => segment.id)), legacy.items.map(item => item.segments.map(segment => segment.id)));

  const legacyContext = await browser.newContext({ acceptDownloads: true });
  const legacyPage = await legacyContext.newPage();
  legacyPage.on('pageerror', error => errors.push(error.message));
  legacyContext.on('request', request => traffic.push({ method: request.method(), url: request.url() }));
  await legacyPage.goto(origin); await legacyPage.waitForSelector('#welcome:not([hidden])');
  const oldWorkspace = parseResults(legacy); oldWorkspace.id = 'legacy-draft-persistence-fixture'; delete oldWorkspace.graph;
  for (const item of oldWorkspace.manifest.items) { delete item.timeline_id; delete item.time_offset_s; }
  await legacyPage.evaluate(async workspace => {
    const databaseName = 'bench-platform-local-v1:' + new URL('.', location.href).pathname;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('workspaces', 'readwrite'); transaction.objectStore('workspaces').put(workspace);
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    }); database.close();
  }, oldWorkspace);
  await legacyPage.reload(); await restoreLatest(legacyPage); await legacyPage.waitForSelector('#workspace:not([hidden])');
  await legacyPage.waitForFunction(async id => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('bench-platform-local-v1:' + new URL('.', location.href).pathname, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const saved = await new Promise((resolve, reject) => { const request = database.transaction('workspaces').objectStore('workspaces').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); database.close();
    return Boolean(saved?.graph);
  }, oldWorkspace.id);
  const firstLegacyReload = await downloadJSON('legacy-draft-first-reload.json', legacyPage);
  await legacyPage.reload(); await restoreLatest(legacyPage); await legacyPage.waitForSelector('#workspace:not([hidden])');
  const secondLegacyReload = await downloadJSON('legacy-draft-second-reload.json', legacyPage);
  assert.deepEqual(secondLegacyReload.graph, firstLegacyReload.graph);
  assert.deepEqual(secondLegacyReload.items.map(item => item.segments.map(segment => ({ id: segment.id, text: segment.annotations.local_fact }))),
    legacy.items.map(item => item.segments.map(segment => ({ id: segment.id, text: segment.annotations.local_fact }))));
  await legacyContext.close();
  check('an old IndexedDB workspace migrates once and retains graph UUIDs, source window IDs and text across repeated reloads');

  await stage('graph'); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'four-layer-mobile.png'), fullPage: true });
  check('legacy 1.0 migrates to unconfirmed facts without merging unknown subjects and mobile layout remains contained');

  assert.deepEqual(errors, []);
  assert.ok(traffic.every(request => request.method === 'GET' && (request.url.startsWith(new URL(origin).origin + '/') || request.url.startsWith('blob:'))), JSON.stringify(traffic));
  check('no application exceptions, media/result upload requests or third-party resource requests');
  fs.writeFileSync(path.join(artifacts, 'graph-browser-report.json'), JSON.stringify({ status: 'passed', checked_at: new Date().toISOString(), checks, errors, request_count: traffic.length,
    limitations: ['Synthetic fixtures verify workflow and graph structure, not semantic quality of real research annotations', 'Native save dialog is not automated; real JSON and SVG downloads are validated'] }, null, 2));
  console.log(`Graph browser verification: ${checks.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'graph-failure.png'), fullPage: true }).catch(() => {});
  console.error('Graph browser verification FAILED:', error); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
