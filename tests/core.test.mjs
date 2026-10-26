import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, parseResults, newWorkspace, makeExport, blankRecord, matchFile, completionErrors, mediaPath, MAX_SEGMENTS } from '../core.mjs';

function manifest() { return parseManifest({ batch_id: 'batch_001', assignment_id: 'task_a', annotator_id: 'ann01', items: [
  { id: 'video_01', media_path: 'video/demo.mp4', media_type: 'video', duration_s: 12, clip_start_s: 600, video_fps: 25 },
] }); }
function complete(ws) {
  ws.records.video_01 = { ...blankRecord(ws.manifest.items[0]), status: 'complete', segments: [
    { id: 's_1', start_time: 1, end_time: 3, label: 'visual_observation', annotations: { subject_id: 'unknown', observation: '画面有测试色块', evidence_role: 'event_support', uncertainty: '合成素材' } },
  ] }; return ws;
}
test('export and reimport preserve complete intervals, Chinese question fields and source offsets', () => {
  const original = complete(newWorkspace(manifest()));
  const restored = parseResults(JSON.stringify(makeExport(original)));
  assert.deepEqual(restored.records, original.records);
  assert.equal(restored.manifest.items[0].clip_start_s, 600);
  assert.equal(completionErrors(restored.manifest.items[0], restored.records.video_01).length, 0);
});
test('both independent assignments keep the same asset ID without sharing identity', () => {
  const a = complete(newWorkspace(manifest())); const b = complete(newWorkspace(manifest()));
  b.manifest.annotator_id = 'ann02'; b.manifest.assignment_id = 'task_b';
  b.records.video_01.segments[0].annotations.observation = '独立观察';
  assert.equal(makeExport(a).items[0].id, makeExport(b).items[0].id);
  assert.notEqual(makeExport(a).assignment_id, makeExport(b).assignment_id);
  assert.notDeepEqual(makeExport(a).items[0].segments, makeExport(b).items[0].segments);
});
test('reject remote URLs, traversal, duplicate IDs and non-finite times', () => {
  for (const value of ['https://example.org/video.mp4', '../video.mp4', 'C:\\video.mp4', 'file:///a.mp4']) assert.throws(() => mediaPath(value));
  const m = manifest(); assert.throws(() => parseManifest({ ...m, items: [...m.items, m.items[0]] }));
  const data = makeExport(complete(newWorkspace(m))); data.items[0].segments[0].end_time = Infinity;
  assert.throws(() => parseResults(data));
});
test('reject intervals outside the media and incomplete records marked complete', () => {
  const data = makeExport(complete(newWorkspace(manifest()))); data.items[0].segments[0].end_time = 20;
  assert.throws(() => parseResults(data), /超出/);
  data.items[0].segments[0].end_time = 2; data.items[0].segments[0].annotations.observation = '';
  assert.throws(() => parseResults(data), /不完整/);
});
test('file matching uses full relative paths and rejects ambiguous basenames', () => {
  const task = manifest().items[0];
  const good = { name: 'demo.mp4', webkitRelativePath: 'batch/video/demo.mp4' };
  assert.equal(matchFile(task, [good]), good);
  assert.throws(() => matchFile(task, [{ name: 'demo.mp4', webkitRelativePath: 'a/demo.mp4' }, { name: 'demo.mp4', webkitRelativePath: 'b/demo.mp4' }]), /同名/);
});
test('untrusted extra properties cannot pollute prototypes or survive normalization', () => {
  const data = makeExport(complete(newWorkspace(manifest())));
  const malicious = JSON.parse(JSON.stringify(data).replace('"format":', '"__proto__":{"injected":true},"format":'));
  const clean = makeExport(parseResults(malicious));
  assert.equal({}.injected, undefined); assert.equal(Object.hasOwn(clean, '__proto__'), false);
});
test('drafts can be exported before completion but need an assignment identity', () => {
  const ws = newWorkspace(manifest()); assert.equal(makeExport(ws).items[0].status, 'draft');
  ws.manifest.annotator_id = ''; assert.throws(() => makeExport(ws), /标注员/);
});
test('imports reject repeated segment IDs, unsupported versions and excessive segments', () => {
  const data = makeExport(complete(newWorkspace(manifest())));
  data.items[0].segments.push({ ...data.items[0].segments[0] }); assert.throws(() => parseResults(data), /重复/);
  data.items[0].segments = Array(MAX_SEGMENTS + 1).fill(data.items[0].segments[0]); assert.throws(() => parseResults(data), /1000/);
  data.schema_version = '99'; assert.throws(() => parseResults(data), /版本/);
});
