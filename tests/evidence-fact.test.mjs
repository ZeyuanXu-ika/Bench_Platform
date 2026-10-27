import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkspace, parseManifest, cleanSegment, completionErrors, makeExport, parseResults } from '../core.mjs';
import { evidenceKey, normalizeGraph, removeGraphNode } from '../graph.mjs';
import { createSubjectResolver } from '../subject-lineage.mjs';
import { getEvidenceFact, saveEvidenceFact, setEvidenceSubjects } from '../evidence-fact.mjs';

const ref = evidenceKey('video', 'window');
function workspace() {
  const ws = newWorkspace(parseManifest({ batch_id: 'batch', assignment_id: 'assignment', annotator_id: 'annotator', items: [
    { id: 'video', media_path: 'v.mp4', media_type: 'video', timeline_id: 'scene', duration_s: 10 }
  ] }));
  ws.graph.entities.push(...['A', 'B', 'C'].map(id => ({ id, name: `主体 ${id}`, aliases: [] })));
  ws.records.video.segments.push(cleanSegment({ id: 'window', start_time: 0, end_time: 2, label: 'visual_observation', annotations: { subject_id: 'A', observation: '主体 A 将文件递给主体 B', local_fact: '旧局部事实保留', evidence_role: 'both' } }, ws.manifest.items[0]));
  return ws;
}
function save(ws, changes = {}) { return saveEvidenceFact(ws, 'video', 'window', { text: '主体 A 将文件递给主体 B', subject_ids: ['A', 'B'], ...changes }); }
function closedWorkspace() {
  const ws = workspace(), { fact } = save(ws, { review_status: 'confirmed' });
  ws.graph.events.push({ id: 'event', title: '提交文件', subject_ids: ['A', 'B'], timeline_id: 'scene', review_status: 'confirmed' });
  ws.graph.emotion_states.push({ id: 'state', subject_id: 'A', label: '平静', timeline_id: 'scene', start_time: 0, end_time: 2, intensity: null, review_status: 'confirmed' });
  ws.graph.links.push(
    { id: 'constitutes', from_type: 'fact', from_id: fact.id, to_type: 'event', to_id: 'event', type: 'constitutes' },
    { id: 'grounds', from_type: 'fact', from_id: fact.id, to_type: 'emotion_state', to_id: 'state', type: 'grounds' },
    { id: 'associated', from_type: 'event', from_id: 'event', to_type: 'emotion_state', to_id: 'state', type: 'associated_with' }
  );
  ws.graph.status = 'complete'; ws.graph = normalizeGraph(ws.graph, ws); return ws;
}
test('optional canonical evidence subjects and primary fact binding roundtrip while old annotations remain compatible', () => {
  const ws = workspace(), original = structuredClone(ws.records.video.segments[0].annotations);
  const { fact, modified } = save(ws);
  assert.equal(modified, true); assert.equal(fact.review_status, 'needs_review');
  assert.deepEqual(fact.subject_ids, ['A', 'B']); assert.equal(ws.records.video.segments[0].annotations.fact_id, fact.id);
  const restored = parseResults(makeExport(ws));
  assert.deepEqual(restored.records.video.segments[0].annotations.subject_ids, ['A', 'B']);
  assert.equal(restored.records.video.segments[0].annotations.local_fact, original.local_fact);
  assert.equal(restored.graph.facts.length, 1); assert.equal(restored.graph.mentions.length, 2);
  assert.equal(restored.records.video.segments[0].annotations.observation, fact.text);
  const old = workspace();
  assert.equal(Object.hasOwn(parseResults(makeExport(old)).records.video.segments[0].annotations, 'subject_ids'), false);
});
test('canonical subject lists reject invalid identifiers, duplicates, oversized lists and dangling entities atomically', () => {
  const ws = workspace(), item = ws.manifest.items[0], raw = ws.records.video.segments[0];
  for (const invalid of ['A', [''], ['A', 'A'], ['\n'], Array(101).fill('A')]) assert.throws(() => cleanSegment({ ...raw, annotations: { ...raw.annotations, subject_ids: invalid } }, item));
  const before = structuredClone(ws);
  assert.throws(() => setEvidenceSubjects(ws, 'video', 'window', ['missing']), /不存在/);
  assert.deepEqual(ws, before);
  const data = makeExport(ws); data.items[0].subject_ids = ['missing'];
  assert.throws(() => parseResults(data), /不存在/);
});
test('subject selection persists as a reusable task catalog and empty selection suppresses legacy fallback', () => {
  const ws = workspace();
  assert.equal(setEvidenceSubjects(ws, 'video', 'window', ['A', 'B']), true);
  assert.deepEqual(ws.manifest.items[0].subject_ids, ['A', 'B']);
  assert.deepEqual(createSubjectResolver(ws).fromEvidence([ref]).map(entry => entry.id), ['A', 'B']);
  assert.equal(setEvidenceSubjects(ws, 'video', 'window', ['B', 'A']), false);
  setEvidenceSubjects(ws, 'video', 'window', []);
  assert.deepEqual(ws.manifest.items[0].subject_ids, ['A', 'B']);
  assert.deepEqual(createSubjectResolver(ws).fromEvidence([ref]), []);
  assert.deepEqual(ws.graph.mentions, []);
  assert.ok(completionErrors(ws.manifest.items[0], ws.records.video).some(text => text.includes('主体')));
  const restored = parseResults(makeExport(ws)); assert.deepEqual(restored.manifest.items[0].subject_ids, ['A', 'B']);
});
test('saving observation creates one factual node and relation with selected subjects, without inventing review', () => {
  const ws = workspace(); const first = save(ws), second = save(ws);
  assert.equal(second.modified, false); assert.equal(second.fact.id, first.fact.id);
  assert.equal(ws.graph.facts.length, 1); assert.equal(ws.graph.links.length, 1);
  assert.equal(ws.graph.links[0].from_id, ref); assert.equal(ws.graph.links[0].to_id, first.fact.id);
  assert.equal(first.fact.review_status, 'needs_review');
});
test('unchanged saves preserve completed graph, review decisions, edge identities and subject order', () => {
  const ws = closedWorkspace(), before = structuredClone(ws);
  const result = save(ws, { subject_ids: ['B', 'A'] });
  assert.equal(result.modified, false); assert.deepEqual(ws, before);
});
test('actual factual changes invalidate descendants but a review-only edit does not', () => {
  const ws = closedWorkspace();
  save(ws, { review_status: 'needs_review' });
  assert.equal(ws.graph.status, 'draft'); assert.equal(ws.graph.events[0].review_status, 'confirmed'); assert.equal(ws.graph.emotion_states[0].review_status, 'confirmed');
  save(ws, { text: '主体 A 把文件放回桌上', review_status: 'confirmed' });
  assert.equal(ws.graph.events[0].review_status, 'needs_review'); assert.equal(ws.graph.emotion_states[0].review_status, 'needs_review');
  assert.equal(ws.graph.facts[0].review_status, 'confirmed');
});
test('subject changes invalidate fact interpretations and preserve unrelated entity records', () => {
  const ws = closedWorkspace(), factID = ws.graph.facts[0].id;
  setEvidenceSubjects(ws, 'video', 'window', ['C']);
  assert.equal(ws.graph.facts[0].id, factID); assert.equal(ws.graph.facts[0].review_status, 'needs_review');
  assert.equal(ws.graph.events[0].review_status, 'needs_review');
  assert.deepEqual(ws.graph.mentions.map(entry => entry.entity_id), ['C']);
  assert.equal(ws.graph.entities.length, 3);
});
test('reported speech requires an explicit speaker selected in this window and failed saves are atomic', () => {
  const ws = workspace(), before = structuredClone(ws);
  for (const changes of [{ text: '' }, { subject_ids: [] }, { kind: 'bad' }, { review_status: 'bad' }, { kind: 'reported_speech', speaker_id: '' }, { kind: 'reported_speech', speaker_id: 'C' }]) {
    assert.throws(() => save(ws, changes)); assert.deepEqual(ws, before);
  }
  const { fact } = save(ws, { kind: 'reported_speech', speaker_id: 'A' });
  assert.equal(fact.speaker_id, 'A'); assert.equal(fact.kind, 'reported_speech');
});
test('only an unambiguous matching single-window legacy fact is reused; unrelated and shared facts are preserved', () => {
  const ws = workspace(), { fact } = save(ws); delete ws.records.video.segments[0].annotations.fact_id;
  assert.equal(getEvidenceFact(ws, 'video', 'window').id, fact.id);
  assert.equal(save(ws).fact.id, fact.id);
  delete ws.records.video.segments[0].annotations.fact_id;
  ws.records.video.segments.push(cleanSegment({ id: 'another', start_time: 3, end_time: 4, label: 'visual_observation', annotations: {} }, ws.manifest.items[0]));
  ws.graph.links.push({ id: 'shared', from_type: 'evidence', from_id: evidenceKey('video', 'another'), to_type: 'fact', to_id: fact.id, type: 'supports' });
  assert.equal(getEvidenceFact(ws, 'video', 'window'), null);
  const created = save(ws); assert.notEqual(created.fact.id, fact.id); assert.equal(ws.graph.facts.length, 2);
  assert.equal(ws.graph.links.find(entry => entry.id === 'shared').to_id, fact.id);
});
test('multiple matching legacy facts are never silently merged or overwritten', () => {
  const ws = workspace(), { fact } = save(ws); delete ws.records.video.segments[0].annotations.fact_id;
  ws.graph.facts.push({ ...fact, id: 'another-fact' });
  ws.graph.links.push({ id: 'another-support', from_type: 'evidence', from_id: ref, to_type: 'fact', to_id: 'another-fact', type: 'supports' });
  assert.equal(getEvidenceFact(ws, 'video', 'window'), null);
  const result = save(ws, { text: '新的原地事实描述' });
  assert.equal(ws.graph.facts.length, 3); assert.notEqual(result.fact.id, fact.id);
  assert.equal(ws.graph.facts.find(entry => entry.id === fact.id).text, fact.text);
});
test('editing an explicitly shared primary fact synchronizes only its bound description windows', () => {
  const ws = workspace(), { fact } = save(ws);
  ws.records.video.segments.push(cleanSegment({ id: 'bound', start_time: 3, end_time: 4, label: 'visual_observation', annotations: { subject_id: 'A', subject_ids: ['A'], observation: fact.text, fact_id: fact.id, local_fact: '保留旧字段' } }, ws.manifest.items[0]));
  ws.records.video.segments.push(cleanSegment({ id: 'unbound', start_time: 5, end_time: 6, label: 'visual_observation', annotations: { subject_id: 'B', observation: '独立观察' } }, ws.manifest.items[0]));
  for (const id of ['bound', 'unbound']) ws.graph.links.push({ id: 'support-' + id, from_type: 'evidence', from_id: evidenceKey('video', id), to_type: 'fact', to_id: fact.id, type: 'supports' });
  save(ws, { text: '共享事实的新描述' });
  assert.equal(ws.records.video.segments[1].annotations.observation, '共享事实的新描述');
  assert.equal(ws.records.video.segments[1].annotations.local_fact, '保留旧字段');
  assert.deepEqual(ws.records.video.segments[1].annotations.subject_ids, ['A']);
  assert.equal(ws.records.video.segments[2].annotations.observation, '独立观察');
});
test('deleting a fact, support, subject or final mention removes only the corresponding canonical bindings', () => {
  for (const remove of ['fact', 'link']) {
    const ws = workspace(), { fact } = save(ws);
    removeGraphNode(ws, remove, remove === 'fact' ? fact.id : ws.graph.links[0].id);
    assert.equal(Object.hasOwn(ws.records.video.segments[0].annotations, 'fact_id'), false);
    assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  }
  const ws = workspace(); save(ws);
  const mention = ws.graph.mentions.find(entry => entry.entity_id === 'A');
  ws.graph.mentions.push({ ...mention, id: 'second-mention' });
  removeGraphNode(ws, 'mention', mention.id); assert.deepEqual(ws.records.video.segments[0].annotations.subject_ids, ['A', 'B']);
  removeGraphNode(ws, 'mention', 'second-mention'); assert.deepEqual(ws.records.video.segments[0].annotations.subject_ids, ['B']);
  assert.deepEqual(ws.manifest.items[0].subject_ids, ['A', 'B']);
  removeGraphNode(ws, 'entity', 'B'); assert.deepEqual(ws.records.video.segments[0].annotations.subject_ids, []); assert.deepEqual(ws.manifest.items[0].subject_ids, ['A']);
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
});
test('imports reject dangling primary fact bindings and mismatched support references', () => {
  const ws = workspace(); save(ws);
  const data = makeExport(ws); data.items[0].segments[0].annotations.fact_id = 'missing';
  assert.throws(() => parseResults(data), /事实/);
  const noSupport = makeExport(ws); noSupport.graph.links = [];
  assert.throws(() => parseResults(noSupport), /支持关系/);
});
test('an existing fact may describe only A while its evidence contains A and B, without silently broadening on save', () => {
  const ws = workspace(), { fact } = save(ws);
  ws.graph.facts.find(entry => entry.id === fact.id).subject_ids = ['A'];
  const noChange = save(ws, { subject_ids: ['A'], evidence_subject_ids: ['A', 'B'] });
  assert.equal(noChange.modified, false); assert.deepEqual(noChange.fact.subject_ids, ['A']);
  save(ws, { text: '只描述 A 的具体动作', subject_ids: ['A'], evidence_subject_ids: ['A', 'B'] });
  assert.deepEqual(ws.graph.facts[0].subject_ids, ['A']); assert.deepEqual(ws.records.video.segments[0].annotations.subject_ids, ['A', 'B']);
});
test('an explicitly shared fact retains subjects and speaker grounded in another support window', () => {
  const ws = workspace(), { fact } = save(ws, { subject_ids: ['A'] });
  ws.records.video.segments.push(cleanSegment({ id: 'other', start_time: 3, end_time: 4, label: 'speech_content', annotations: { subject_id: 'B', subject_ids: ['B'] } }, ws.manifest.items[0]));
  ws.graph.mentions.push({ id: 'mention-other-B', entity_id: 'B', evidence_id: evidenceKey('video', 'other'), description: '另一支持窗中的发言者' });
  ws.graph.links.push({ id: 'support-other', from_type: 'evidence', from_id: evidenceKey('video', 'other'), to_type: 'fact', to_id: fact.id, type: 'supports' });
  Object.assign(ws.graph.facts[0], { subject_ids: ['A', 'B'], kind: 'reported_speech', speaker_id: 'B' });
  const result = save(ws, { subject_ids: ['A', 'B'], evidence_subject_ids: ['A'], kind: 'reported_speech', speaker_id: 'B' });
  assert.equal(result.modified, false); assert.deepEqual(result.fact.subject_ids, ['A', 'B']); assert.equal(result.fact.speaker_id, 'B');
  assert.deepEqual(ws.records.video.segments[0].annotations.subject_ids, ['A']);
  assert.deepEqual(ws.records.video.segments[1].annotations.subject_ids, ['B']);
});
function legacyPair() {
  const ws = workspace(); ws.records.video.segments[0].annotations.subject_id = '主体甲';
  ws.records.video.segments.push(cleanSegment({ id: 'second', start_time: 3, end_time: 4, label: 'visual_observation', annotations: { subject_id: '主体甲', observation: '第二窗动作' } }, ws.manifest.items[0]));
  const resolver = createSubjectResolver(ws), [subject] = resolver.fromEvidence([ref]); resolver.commit([subject]);
  save(ws, { subject_ids: [subject.id] }); return { ws, subject };
}
test('registering the first legacy window preserves the exact same-clue identity for another window and after roundtrip', () => {
  const { ws, subject } = legacyPair(), secondRef = evidenceKey('video', 'second');
  assert.equal(ws.records.video.segments[0].annotations.subject_id, '主体甲');
  assert.deepEqual(createSubjectResolver(ws).fromEvidence([secondRef]).map(entry => entry.id), [subject.id]);
  assert.equal(createSubjectResolver(ws).forItem('video').length, 1);
  const restored = parseResults(makeExport(ws));
  assert.deepEqual(createSubjectResolver(restored).fromEvidence([secondRef]).map(entry => entry.id), [subject.id]);
});
test('later changing or adding a selected actor cannot reinterpret another unregistered legacy clue as that new actor', () => {
  for (const mode of ['replace', 'append']) {
    const { ws, subject } = legacyPair();
    setEvidenceSubjects(ws, 'video', 'window', mode === 'replace' ? ['B'] : [subject.id, 'B']);
    const next = createSubjectResolver(ws).fromEvidence([evidenceKey('video', 'second')]);
    assert.equal(next.length, 1); assert.notEqual(next[0].id, 'B');
    assert.equal(ws.records.video.segments[0].annotations.subject_id, mode === 'replace' ? 'B' : subject.id);
  }
});
