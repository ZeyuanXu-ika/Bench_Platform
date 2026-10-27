import test from 'node:test';
import assert from 'node:assert/strict';
import { blankGraph, evidenceKey, normalizeGraph } from '../graph.mjs';
import { createSubjectResolver } from '../subject-lineage.mjs';

const ref = (item, segment) => evidenceKey(item, segment);
function workspace() {
  return { manifest: { items: [{ id: 'v1', media_type: 'video' }, { id: 'v2', media_type: 'video' }] },
    records: { v1: { segments: [{ id: 'a', start_time: 0, end_time: 1, annotations: { subject_id: '黄衣人' } }, { id: 'b', start_time: 1, end_time: 2, annotations: { subject_id: '黄衣人' } }] },
      v2: { segments: [{ id: 'a', start_time: 0, end_time: 1, annotations: { subject_id: '黄衣人' } }] } }, graph: blankGraph() };
}
const entity = (id, name = id) => ({ id, name, aliases: [] });
const mention = (id, subject, evidence) => ({ id, entity_id: subject, evidence_id: evidence, description: '人工共指' });
const edge = (id, fromType, from, toType, to, type) => ({ id, from_type: fromType, from_id: from, to_type: toType, to_id: to, type });

test('evidence clues become stable planned subjects without changing workspace or creating a global default', () => {
  const ws = workspace(), before = structuredClone(ws), resolver = createSubjectResolver(ws);
  const first = resolver.fromEvidence([ref('v1', 'a')]);
  assert.equal(first.length, 1); assert.equal(first[0].name, '黄衣人'); assert.equal(first[0].pending, true);
  assert.equal(resolver.fromEvidence([ref('v1', 'a')])[0].id, first[0].id);
  assert.deepEqual(ws, before);
  assert.deepEqual(resolver.fromEvidence([]), []); assert.deepEqual(resolver.forItem('missing'), []);
});

test('ordinary clues reuse only within a material while same names in different materials remain separate', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws);
  const one = resolver.forItem('v1'), two = resolver.forItem('v2');
  assert.equal(one.length, 1); assert.deepEqual(one[0].evidence_ids, [ref('v1', 'a'), ref('v1', 'b')]);
  assert.notEqual(one[0].id, two[0].id);
  resolver.commit(one);
  const reloaded = createSubjectResolver(ws);
  assert.equal(reloaded.fromEvidence([ref('v1', 'b')])[0].id, one[0].id);
  assert.notEqual(reloaded.forItem('v2')[0].id, one[0].id);
});

test('explicit coreference mentions override raw clues and no name or alias guesses merge identities', () => {
  const ws = workspace(); ws.graph.entities.push(entity('p1', '黄衣人'), { id: 'p2', name: '另一个人', aliases: ['黄衣人'] });
  ws.graph.mentions.push(mention('m1', 'p2', ref('v1', 'a')));
  const resolver = createSubjectResolver(ws);
  assert.equal(resolver.fromEvidence([ref('v1', 'a')])[0].id, 'p2');
  assert.equal(resolver.fromEvidence([ref('v1', 'b')])[0].id, 'p2');
  assert.ok(!['p1', 'p2'].includes(resolver.forItem('v2')[0].id));
});

test('an exact canonical subject ID can be intentionally reused across materials', () => {
  const ws = workspace(); ws.graph.entities.push(entity('p1', '主主体'));
  for (const record of Object.values(ws.records)) for (const segment of record.segments) segment.annotations.subject_id = 'p1';
  const resolver = createSubjectResolver(ws), candidates = resolver.fromEvidence([ref('v1', 'a'), ref('v2', 'a')]);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].id, 'p1'); assert.equal(candidates[0].pending, false);
  resolver.commit(candidates); assert.equal(ws.graph.entities.length, 1); assert.equal(ws.graph.mentions.length, 2);
});

test('unknown evidence stays separate and long labels receive short collision-free IDs; blanks remain empty', () => {
  const ws = workspace();
  ws.records.v1.segments[0].annotations.subject_id = 'unknown'; ws.records.v1.segments[1].annotations.subject_id = 'UNKNOWN';
  ws.records.v2.segments[0].annotations.subject_id = '主'.repeat(500);
  const resolver = createSubjectResolver(ws), unknowns = resolver.forItem('v1'), long = resolver.forItem('v2');
  assert.equal(unknowns.length, 2); assert.notEqual(unknowns[0].id, unknowns[1].id);
  assert.equal(long[0].name.length, 500); assert.ok(long[0].id.length <= 200);
  resolver.commit([...unknowns, ...long]); assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  ws.records.v2.segments.push({ id: 'empty', annotations: { subject_id: '  ' } });
  assert.deepEqual(resolver.fromEvidence([ref('v2', 'empty')]), []);
});

test('commit is idempotent, preserves raw annotations and review metadata, and survives resolver recreation', () => {
  const ws = workspace(), before = structuredClone(ws.records), resolver = createSubjectResolver(ws), candidates = resolver.forItem('v1');
  assert.equal(resolver.commit(candidates), true);
  const committed = structuredClone(ws.graph); assert.equal(resolver.commit(candidates), false);
  assert.deepEqual(ws.graph, committed); assert.deepEqual(ws.records, before);
  const afterReload = createSubjectResolver(ws); assert.equal(afterReload.forItem('v1')[0].id, candidates[0].id);
  assert.equal(afterReload.forItem('v1')[0].pending, false);
  assert.equal(afterReload.commit(afterReload.forItem('v1')), false);
});

test('facts and events inherit grounded subjects while preserving historical saved subject identities', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws), [main] = resolver.forItem('v1'); resolver.commit([main]);
  ws.graph.entities.push(entity('historical'), entity('speaker'));
  ws.graph.facts.push({ id: 'f1', text: '说话人声称黄衣人离开', subject_ids: ['historical'], kind: 'reported_speech', speaker_id: 'speaker', review_status: 'confirmed' });
  ws.graph.events.push({ id: 'ev1', title: '陈述离开一事', subject_ids: ['historical'], timeline_id: 'v1', review_status: 'confirmed' });
  ws.graph.links.push(edge('l1', 'evidence', ref('v1', 'a'), 'fact', 'f1', 'supports'), edge('l2', 'fact', 'f1', 'event', 'ev1', 'constitutes'));
  assert.deepEqual(new Set(resolver.fromFacts(['f1']).map(entry => entry.id)), new Set(['historical', 'speaker']));
  assert.deepEqual(new Set(resolver.fromEvents(['ev1']).map(entry => entry.id)), new Set(['historical']));
  assert.deepEqual(resolver.fromFacts(['f1']).find(entry => entry.id === 'historical').evidence_ids, []);
  assert.deepEqual(resolver.fromFacts(['missing']), []); assert.deepEqual(resolver.fromEvents(['missing']), []);
  assert.equal(ws.graph.facts[0].review_status, 'confirmed');
});

test('stale candidates cannot add mentions after evidence is reassigned and failed commit is atomic', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws), candidates = resolver.forItem('v1');
  ws.graph.entities.push(entity('manual')); ws.graph.mentions.push(mention('m1', 'manual', ref('v1', 'a')));
  const before = structuredClone(ws.graph);
  assert.throws(() => resolver.commit(candidates), /主体已变化/);
  assert.deepEqual(ws.graph, before);
});

test('multiple explicit subjects stay available and conflicting same-clue mappings never choose the first person', () => {
  const ws = workspace(); ws.graph.entities.push(entity('p1'), entity('p2'));
  ws.graph.mentions.push(mention('m1', 'p1', ref('v1', 'a')), mention('m2', 'p2', ref('v1', 'a')));
  const resolver = createSubjectResolver(ws);
  assert.deepEqual(new Set(resolver.fromEvidence([ref('v1', 'a')]).map(entry => entry.id)), new Set(['p1', 'p2']));
  const unresolved = resolver.fromEvidence([ref('v1', 'b')]);
  assert.equal(unresolved.length, 1); assert.equal(unresolved[0].pending, true);
  assert.ok(!['p1', 'p2'].includes(unresolved[0].id));
});

test('planned UUIDs cannot collide with subsequently added nodes of another graph type', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws), [first] = resolver.forItem('v1');
  ws.graph.facts.push({ id: first.id, text: '已有其他类型节点', subject_ids: [], kind: 'observation', speaker_id: '', review_status: 'draft' });
  const [next] = resolver.forItem('v1'); assert.notEqual(next.id, first.id);
  assert.throws(() => resolver.commit([first]), /主体依据已变化/);
  resolver.commit([next]); assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
});

test('a fact selecting only A from two-person evidence propagates only A, with its evidence mappings intact', () => {
  const ws = workspace(); ws.graph.entities.push(entity('A'), entity('B'));
  ws.graph.mentions.push(mention('mA', 'A', ref('v1', 'a')), mention('mB', 'B', ref('v1', 'a')));
  ws.graph.facts.push({ id: 'fA', text: 'A放下文件', subject_ids: ['A'], kind: 'observation', speaker_id: '', review_status: 'confirmed' });
  ws.graph.events.push({ id: 'evA', title: 'A提交文件', subject_ids: ['A'], timeline_id: 'v1', review_status: 'confirmed' });
  ws.graph.links.push(edge('lA', 'evidence', ref('v1', 'a'), 'fact', 'fA', 'supports'), edge('lev', 'fact', 'fA', 'event', 'evA', 'constitutes'));
  const resolver = createSubjectResolver(ws);
  assert.deepEqual(resolver.fromFacts(['fA']).map(entry => entry.id), ['A']);
  assert.deepEqual(resolver.fromEvents(['evA']).map(entry => entry.id), ['A']);
  assert.deepEqual(resolver.fromEvents(['evA'])[0].evidence_ids, [ref('v1', 'a')]);
});

test('saved event participants are not broadened by other fact subjects; unassigned nodes may fall back to their evidence', () => {
  const ws = workspace(); ws.graph.entities.push(entity('A'), entity('B'));
  ws.graph.mentions.push(mention('mA', 'A', ref('v1', 'a')), mention('mB', 'B', ref('v1', 'a')));
  ws.graph.facts.push({ id: 'fAB', text: 'A和B出现', subject_ids: ['A', 'B'], kind: 'observation', speaker_id: '', review_status: 'confirmed' });
  ws.graph.events.push({ id: 'evA', title: 'A参与事件', subject_ids: ['A'], timeline_id: 'v1', review_status: 'confirmed' });
  ws.graph.links.push(edge('lAB', 'evidence', ref('v1', 'a'), 'fact', 'fAB', 'supports'), edge('levA', 'fact', 'fAB', 'event', 'evA', 'constitutes'));
  const resolver = createSubjectResolver(ws);
  assert.deepEqual(resolver.fromEvents(['evA']).map(entry => entry.id), ['A']);
  ws.graph.events[0].subject_ids = [];
  assert.deepEqual(new Set(resolver.fromEvents(['evA']).map(entry => entry.id)), new Set(['A', 'B']));
  ws.graph.facts[0].subject_ids = [];
  assert.deepEqual(new Set(resolver.fromFacts(['fAB']).map(entry => entry.id)), new Set(['A', 'B']));
});

test('editing raw evidence subject supersedes old automatic mentions without mutating on derivation or deleting historical nodes', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws), [before] = resolver.fromEvidence([ref('v1', 'a')]);
  resolver.commit([before]);
  ws.graph.facts.push({ id: 'historical', text: '旧事实', subject_ids: [before.id], kind: 'observation', speaker_id: '', review_status: 'needs_review' });
  ws.records.v1.segments[0].annotations.subject_id = '新主体';
  const snapshot = structuredClone(ws), [after] = resolver.fromEvidence([ref('v1', 'a')]);
  assert.notEqual(after.id, before.id); assert.equal(after.name, '新主体'); assert.deepEqual(ws, snapshot);
  resolver.commit([after]);
  assert.ok(ws.graph.entities.some(entry => entry.id === before.id));
  assert.equal(ws.graph.facts[0].subject_ids[0], before.id);
  assert.deepEqual(ws.graph.mentions.filter(entry => entry.evidence_id === ref('v1', 'a')).map(entry => entry.entity_id), [after.id]);
  assert.equal(createSubjectResolver(ws).fromEvidence([ref('v1', 'a')])[0].id, after.id);
  assert.equal(resolver.commit(resolver.fromEvidence([ref('v1', 'a')])), false);
});

test('manual coreference still overrides changed raw clues while commit cleans only the selected stale automatic mention', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws); resolver.commit(resolver.forItem('v1'));
  ws.records.v1.segments[0].annotations.subject_id = '改变后的线索';
  ws.graph.entities.push(entity('manual', '经人工确认主体')); ws.graph.mentions.push(mention('manual-mention', 'manual', ref('v1', 'a')));
  const before = structuredClone(ws), subjects = resolver.fromEvidence([ref('v1', 'a')]);
  assert.deepEqual(subjects.map(entry => entry.id), ['manual']); assert.deepEqual(ws, before);
  assert.equal(resolver.commit(subjects), true);
  assert.deepEqual(ws.graph.mentions.filter(entry => entry.evidence_id === ref('v1', 'a')).map(entry => entry.id), ['manual-mention']);
  assert.equal(ws.graph.mentions.filter(entry => entry.evidence_id === ref('v1', 'b')).length, 1);
});

test('adding manual coreference overrides a previously automatic subject even when the raw clue has not changed', () => {
  const ws = workspace(), resolver = createSubjectResolver(ws); resolver.commit(resolver.fromEvidence([ref('v1', 'a')]));
  ws.graph.entities.push(entity('manual', '真正主体')); ws.graph.mentions.push(mention('manual-mention', 'manual', ref('v1', 'a')));
  const snapshot = structuredClone(ws), subjects = resolver.fromEvidence([ref('v1', 'a')]);
  assert.deepEqual(subjects.map(entry => entry.id), ['manual']); assert.deepEqual(ws, snapshot);
  assert.equal(resolver.commit(subjects), true);
  assert.deepEqual(ws.graph.mentions.filter(entry => entry.evidence_id === ref('v1', 'a')).map(entry => entry.id), ['manual-mention']);
});
