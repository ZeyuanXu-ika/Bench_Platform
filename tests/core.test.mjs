import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, parseResults, newWorkspace, makeExport, blankRecord, matchFile, completionErrors, mediaPath, manifestFromFiles, planMediaImport, editInterval, MAX_ITEMS, MAX_SEGMENTS } from '../core.mjs';

function manifest() { return parseManifest({ batch_id: 'batch_001', assignment_id: 'task_a', annotator_id: 'ann01', items: [
  { id: 'video_01', media_path: 'video/demo.mp4', media_type: 'video', duration_s: 12, clip_start_s: 600, video_fps: 25 },
] }); }
function complete(ws) {
  ws.records.video_01 = { ...blankRecord(ws.manifest.items[0]), status: 'complete', segments: [
    { id: 's_1', start_time: 1, end_time: 3, label: 'visual_observation', annotations: { subject_id: 'unknown', observation: '画面有测试色块', local_fact: '', evidence_role: 'event_support', uncertainty: '合成素材' } },
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

test('unclassified time frames roundtrip as drafts and cannot be marked complete', () => {
  const ws = complete(newWorkspace(manifest()));
  const rec = ws.records.video_01; rec.status = 'draft'; rec.segments[0].label = 'unclassified';
  assert.ok(completionErrors(ws.manifest.items[0], rec).some(e => e.includes('归属类别')));
  const data = makeExport(ws);
  assert.equal(parseResults(data).records.video_01.segments[0].label, 'unclassified');
  data.items[0].status = 'complete'; assert.throws(() => parseResults(data), /不完整/);
});

test('local facts belong to individual windows and survive export, while legacy observations still import', () => {
  const ws = complete(newWorkspace(manifest()));
  const first = ws.records.video_01.segments[0]; first.annotations.local_fact = '人物在区间内抬手'; first.annotations.observation = '';
  const second = structuredClone(first); second.id = 's_2'; second.annotations.local_fact = '区间内出现言语内容'; second.label = 'speech_content';
  ws.records.video_01.segments.push(second);
  const restored = parseResults(makeExport(ws)).records.video_01;
  assert.deepEqual(restored.segments.map(s => s.annotations.local_fact), ['人物在区间内抬手', '区间内出现言语内容']);
  assert.equal(completionErrors(ws.manifest.items[0], restored).length, 0);
  const legacy = makeExport(complete(newWorkspace(manifest()))); delete legacy.items[0].segments[0].annotations.local_fact;
  assert.equal(parseResults(legacy).records.video_01.segments[0].annotations.observation, '画面有测试色块');
});
test('imports reject repeated segment IDs, unsupported versions and excessive segments', () => {
  const data = makeExport(complete(newWorkspace(manifest())));
  data.items[0].segments.push({ ...data.items[0].segments[0] }); assert.throws(() => parseResults(data), /重复/);
  data.items[0].segments = Array(MAX_SEGMENTS + 1).fill(data.items[0].segments[0]); assert.throws(() => parseResults(data), /1000/);
  data.schema_version = '99'; assert.throws(() => parseResults(data), /版本/);
});

test('moving a time frame preserves its length and clamps to both media boundaries', () => {
  const seg = { start_time: 2, end_time: 5 };
  assert.deepEqual(editInterval(seg, 1.25, 'move', 12), { start_time: 3.25, end_time: 6.25 });
  assert.deepEqual(editInterval(seg, -20, 'move', 12), { start_time: 0, end_time: 3 });
  assert.deepEqual(editInterval(seg, 20, 'move', 12), { start_time: 9, end_time: 12 });
  assert.deepEqual(seg, { start_time: 2, end_time: 5 });
});

test('direct media import supports MP3 and MP4 together and respects audio MIME for shared containers', () => {
  const m = manifestFromFiles([{ name: 'voice.MP3', type: 'audio/mpeg' }, { name: 'clip.mp4', type: 'video/mp4' }, { name: 'sound.webm', type: 'audio/webm' }, { name: 'voice.weba', type: 'audio/webm' }]);
  assert.deepEqual(m.items.map(i => i.media_type), ['audio', 'video', 'audio', 'audio']);
  assert.deepEqual(m.items.map(i => i.id), ['voice.MP3', 'clip.mp4', 'sound.webm', 'voice.weba']);
});

test('media imports append only missing paths and keep existing custom IDs and annotations intact', () => {
  const ws = complete(newWorkspace(manifest()));
  const before = structuredClone(ws);
  const plan = planMediaImport(ws.manifest, [{ name: 'demo.mp4', type: 'video/mp4' }, { name: 'voice.mp3', type: 'audio/mpeg' }, { name: 'VOICE.MP3', type: 'audio/mpeg' }]);
  assert.equal(plan.skipped, 2); assert.equal(plan.added.length, 1);
  assert.deepEqual(plan.bindings[0].ids, ['video_01']);
  assert.equal(plan.added[0].media_type, 'audio'); assert.equal(plan.added[0].id, 'voice.mp3');
  assert.deepEqual(ws, before);
});

test('media import uses relative paths for duplicate names, rejects ambiguous loose files and handles ID collisions', () => {
  const m = parseManifest({ items: [{ id: 'voice.mp3', media_path: 'a/demo.mp4' }, { id: 'second', media_path: 'b/demo.mp4' }] });
  assert.throws(() => planMediaImport(m, [{ name: 'demo.mp4' }]), /多个不同路径/);
  const plan = planMediaImport(m, [{ name: 'demo.mp4', webkitRelativePath: 'root/a/demo.mp4' }, { name: 'voice.mp3' }]);
  assert.equal(plan.skipped, 1); assert.deepEqual(plan.bindings[0].ids, ['voice.mp3']);
  assert.equal(plan.added[0].id, 'voice.mp3_2');
});

test('an over-limit append is rejected before the existing manifest changes', () => {
  const m = { items: Array.from({ length: MAX_ITEMS }, (_, n) => ({ id: `id_${n}`, media_path: `file_${n}.mp3` })) };
  assert.throws(() => planMediaImport(m, [{ name: 'new.mp3' }]), /超过/);
  assert.equal(m.items.length, MAX_ITEMS);
});

test('resizing either edge retains the other edge and prevents inverted or empty frames', () => {
  const seg = { start_time: 2, end_time: 5 };
  assert.deepEqual(editInterval(seg, .5, 'start', 12), { start_time: 2.5, end_time: 5 });
  assert.deepEqual(editInterval(seg, -20, 'start', 12), { start_time: 0, end_time: 5 });
  assert.deepEqual(editInterval(seg, 20, 'start', 12), { start_time: 4.999, end_time: 5 });
  assert.deepEqual(editInterval(seg, .5, 'end', 12), { start_time: 2, end_time: 5.5 });
  assert.deepEqual(editInterval(seg, 20, 'end', 12), { start_time: 2, end_time: 12 });
  assert.deepEqual(editInterval(seg, -20, 'end', 12), { start_time: 2, end_time: 2.001 });
});
