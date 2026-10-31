import { saveItemDownloadAndProjectSnapshot } from './project-snapshot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { newWorkspace, parseManifest, makeExport, parseResults } from '../core.mjs';
import { blankGraph, evidenceKey } from '../graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results'); fs.mkdirSync(artifacts, { recursive: true });
const fixtures = path.join(root, '.tools', 'timeline-edit-fixtures'); fs.mkdirSync(fixtures, { recursive: true });
execFileSync('python', ['-c', 'import sys,zipfile;from pathlib import Path;r=Path(sys.argv[2]).resolve();z=zipfile.ZipFile(sys.argv[1]);assert all((r/i.filename).resolve().is_relative_to(r) for i in z.infolist());z.extractall(r)', path.join(root, 'samples', 'demo-task.zip'), fixtures]);
const taskDir = path.join(fixtures, 'demo-task');
const manifest = JSON.parse(fs.readFileSync(path.join(taskDir, 'tasks.json'), 'utf8'));
for (const item of manifest.items) { item.timeline_id = 'scene'; item.time_offset_s = item.media_type === 'audio' ? -.1 : 0; }
const ws = newWorkspace(parseManifest(manifest)); ws.graph = blankGraph();
ws.graph.entities.push({ id: 'p', name: '测试人物', aliases: [] });
let serial = 0;
const link = (from_type, from_id, to_type, to_id, type) => ws.graph.links.push({ id: `L${serial++}`, from_type, from_id, to_type, to_id, type });
for (const item of ws.manifest.items) {
  ws.records[item.id].segments = [1, 5].map((start, n) => ({ id: `w${n}`, start_time: start, end_time: start + 1,
    label: item.media_type === 'audio' ? 'acoustic_observation' : 'visual_observation', annotations: { subject_ids: ['p'], fact_id: `f${n}`, local_fact: `测试事实${n}`, evidence_role: 'event_support' } }));
  for (const segment of ws.records[item.id].segments) {
    const ref = evidenceKey(item.id, segment.id);
    ws.graph.mentions.push({ id: `M${serial}`, entity_id: 'p', evidence_id: ref, description: '测试人物' });
    link('evidence', ref, 'fact', segment.annotations.fact_id, 'supports');
  }
}
for (let n = 0; n < 2; n++) {
  ws.graph.facts.push({ id: `f${n}`, text: `测试事实${n}`, subject_ids: ['p'], kind: 'observation', speaker_id: '', review_status: 'confirmed' });
  link('fact', `f${n}`, 'event', 'e', 'constitutes');
  ws.graph.emotion_states.push({ id: `s${n}`, label: n ? '激动' : '平静', subject_id: 'p', timeline_id: 'scene', start_time: n ? 4.9 : .9, end_time: n ? 6 : 2, intensity: null, review_status: 'confirmed' });
}
ws.graph.events.push({ id: 'e', title: '测试复合事件', subject_ids: ['p'], timeline_id: 'scene', review_status: 'confirmed' });
ws.graph.emotion_transitions.push({ id: 't', subject_id: 'p', from_state_id: 's0', to_state_id: 's1', note: '', review_status: 'confirmed' });
const input = path.join(fixtures, 'input.json'); fs.writeFileSync(input, JSON.stringify(makeExport(ws)));
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const name of fs.readdirSync(cache).sort().reverse()) {
    const candidate = path.join(cache, name, 'chrome-win64', 'chrome.exe');
    if (name.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
  }
}
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const stage = async name => { await page.locator(`.g-tab[data-stage="${name}"]`).click(); };
let exports = 0;
async function exported() {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-result').click()]);
  const file = path.join(artifacts, `timeline-edit-${exports++}.json`); const project = await saveItemDownloadAndProjectSnapshot(download, page, file);
  const value = project; parseResults(value); return value;
}
const band = (type, id, index = 0) => page.locator(`.g-layer-view .g-time-row[data-node-type="${type}"][data-node-id="${id}"] .g-time-band`).nth(index);
async function drag(target, delta, edge = null, cancel = false) {
  await target.scrollIntoViewIfNeeded();
  const geometry = await target.evaluate(el => ({ width: el.parentElement.getBoundingClientRect().width,
    low: Number(el.closest('.g-layer-timeline').querySelector('.g-time-scale').getAttribute('aria-valuemin')),
    high: Number(el.closest('.g-layer-timeline').querySelector('.g-time-scale').getAttribute('aria-valuemax')) }));
  const rect = await (edge ? target.locator(`[data-edge="${edge}"]`) : target).boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + delta / (geometry.high - geometry.low) * geometry.width, y, { steps: 8 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(100);
}
async function draw(start, end) {
  await page.locator('.g-layer-view').getByRole('button', { name: '全览', exact: true }).click();
  const target = page.locator('.g-layer-view .g-time-draw'); await target.scrollIntoViewIfNeeded();
  const rect = await target.boundingBox();
  const scale = page.locator('.g-layer-view .g-time-scale');
  const low = Number(await scale.getAttribute('aria-valuemin')), high = Number(await scale.getAttribute('aria-valuemax'));
  const x = time => rect.x + (time - low) / (high - low) * rect.width;
  await page.mouse.move(x(start), rect.y + 15); await page.mouse.down();
  await page.mouse.move(x(end), rect.y + 15, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(100);
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .04, `${actual} should be near ${expected}`);
try {
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8787/');
  await page.locator('#result-input').setInputFiles(input); await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('#folder-input').setInputFiles(taskDir); await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);
  const videoID = ws.manifest.items.find(item => item.media_type === 'video').id;
  const audioID = ws.manifest.items.find(item => item.media_type === 'audio').id;
  await stage('facts'); await page.locator('.g-layer-view').getByRole('button', { name: '放大', exact: true }).click();
  await drag(band('fact', 'f0'), .5);
  let value = await exported();
  close(value.items.find(item => item.id === videoID).segments[0].start_time, 1);
  close(value.items.find(item => item.id === audioID).segments[0].start_time, 1);
  assert.equal(value.items.find(item => item.id === videoID).segments[1].start_time, 5);
  assert.equal(value.graph.events[0].review_status, 'needs_review');
  console.log('PASS: fact dragging changes independent fact times without moving cross-modal evidence');
  const beforeCancel = value; await drag(band('fact', 'f0'), .7, null, true); value = await exported();
  assert.deepEqual(value.items, beforeCancel.items); assert.deepEqual(value.graph, beforeCancel.graph); assert.equal(value.revision, beforeCancel.revision);
  const oldEnd = value.derived.event_time_ranges.e.time_ranges[0].end_time;
  await drag(band('fact', 'f0'), .4, 'end'); value = await exported();
  close(value.derived.event_time_ranges.e.time_ranges[0].end_time, oldEnd + .4);
  console.log('PASS: Escape cancels previews without writes and resizing a fact edge persists the independent window union');
  const first = value.derived.event_time_ranges.e.time_ranges[0],factsBeforeEventDrag=structuredClone(value.graph.facts);
  await stage('events'); await drag(band('event', 'e', 1), -.5); value = await exported();
  close(value.items.find(item => item.id === videoID).segments[1].start_time, 5);
  assert.deepEqual(value.derived.event_time_ranges.e.time_ranges[0], first);assert.deepEqual(value.graph.facts,factsBeforeEventDrag);
  assert.equal(value.graph.events[0].time_ranges,undefined);assert.equal(await page.locator('.g-time-row[data-node-type=event] .g-time-handle').count(),0);console.log('PASS: event bars are read-only derived unions and attempted drags preserve facts and evidence');
  const evidenceBefore = structuredClone(value.items);
  await stage('emotions');
  await band('emotion_state','s0').click();
  await page.locator('#g-state-label').fill('尚未保存的情感说明');
  await drag(band('emotion_state', 's0'), .4); value = await exported();
  assert.equal(await page.locator('#g-state-label').inputValue(), '尚未保存的情感说明');
  assert.equal(value.graph.emotion_states.find(state => state.id === 's0').label, '平静', 'dragging time must not commit unrelated unsaved text');
  close(value.graph.emotion_states.find(state => state.id === 's0').start_time, 1.3);
  assert.deepEqual(value.items, evidenceBefore); assert.equal(value.graph.emotion_transitions[0].review_status, 'needs_review');
  await drag(band('emotion_state', 's1'), .2, 'end'); value = await exported();
  close(value.graph.emotion_states.find(state => state.id === 's1').end_time, 6.2);
  console.log('PASS: emotion state dragging edits actual states; change connections do not add duplicate windows');
  const counts = { facts: value.graph.facts.length, events: value.graph.events.length, states: value.graph.emotion_states.length };
  await draw(8.5, 9); value = await exported();
  assert.equal(value.graph.emotion_states.length, counts.states + 1); assert.equal(value.graph.emotion_states.at(-1).label, '');
  await stage('facts'); await draw(7.8, 7.1); value = await exported();
  assert.equal(value.graph.facts.length, counts.facts + 1); assert.equal(value.graph.facts.at(-1).text, '');
  assert.equal(await page.locator('#g-fact-text').inputValue(), '');
  close(value.graph.facts.at(-1).time_ranges[0].start_time,7.1);
  assert.deepEqual(value.items,evidenceBefore);
  await stage('events'); await draw(9.2, 10); value = await exported();
  assert.equal(value.graph.events.length, counts.events + 1); assert.equal(value.graph.facts.length, counts.facts + 2);
  assert.equal(value.graph.events.at(-1).title, '');
  console.log('PASS: forward and reverse drawing create editable empty state/fact/event drafts without creating source evidence');
  await page.screenshot({ path: path.join(artifacts, 'timeline-edit.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Timeline editing browser verification: 6 checks passed.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'timeline-edit-failure.png'), fullPage: true });
  console.error('Timeline editing FAILED:', error, errors); process.exitCode = 1;
} finally { await browser.close(); }
