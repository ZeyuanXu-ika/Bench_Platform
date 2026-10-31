import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, newWorkspace, makeExport, parseResults } from '../core.mjs';
import { evidenceKey, blankGraph, graphIssues } from '../graph.mjs';

function workspace() {
  const ws = newWorkspace(parseManifest({ schema_version: '1.0', batch_id: 'v2_batch', assignment_id: 'A', annotator_id: 'ann01',
    items: [{ id: 'video', media_path: 'clip.mp4', duration_s: 4, source_id: 'scene', clip_start_s: 10 }] }));
  ws.records.video.segments = [0, 1].map(n => ({ id: `w${n}`, start_time: n, end_time: n + 1, label: 'visual_observation',
    annotations: { subject_id: 'P1', local_fact: `P1 的客观动作 ${n}`, observation: '', evidence_role: 'event_support', uncertainty: '' } }));
  return ws;
}

function graph(ws) {
  return { ...blankGraph(), entities: [{ id: 'P1', name: '人物甲', aliases: ['黄衣人'] }],
    mentions: [{ id: 'M1', entity_id: 'P1', evidence_id: evidenceKey('video', 'w0'), description: '画面中的黄衣人' },
      { id: 'M2', entity_id: 'P1', evidence_id: evidenceKey('video', 'w1'), description: '后续画面中的同一主体' }],
    facts: [{ id: 'F1', text: 'P1 将文件放到桌上', subject_ids: ['P1'], kind: 'observation', speaker_id: '', review_status: 'confirmed' },
      { id: 'F2', text: 'P1 把文件推回', subject_ids: ['P1'], kind: 'observation', speaker_id: '', review_status: 'confirmed' }],
    events: [{ id: 'E1', title: 'P1 退回文件', subject_ids: ['P1'], timeline_id: 'scene', review_status: 'confirmed' }],
    emotion_states: [{ id: 'S1', subject_id: 'P1', label: '平静', timeline_id: 'scene', start_time: 10, end_time: 11, intensity: null, review_status: 'confirmed' },
      { id: 'S2', subject_id: 'P1', label: '不满', timeline_id: 'scene', start_time: 11, end_time: 12, intensity: 2, review_status: 'confirmed' }],
    emotion_transitions: [{ id: 'T1', subject_id: 'P1', from_state_id: 'S1', to_state_id: 'S2', note: '依据经复核的语音和动作判断', review_status: 'confirmed' }],
    links: [
      { id: 'L1', from_type: 'evidence', from_id: evidenceKey('video', 'w0'), to_type: 'fact', to_id: 'F1', type: 'supports' },
      { id: 'L2', from_type: 'evidence', from_id: evidenceKey('video', 'w1'), to_type: 'fact', to_id: 'F2', type: 'supports' },
      { id: 'L3', from_type: 'fact', from_id: 'F1', to_type: 'event', to_id: 'E1', type: 'constitutes' },
      { id: 'L4', from_type: 'fact', from_id: 'F2', to_type: 'event', to_id: 'E1', type: 'constitutes' },
      { id: 'L5', from_type: 'fact', from_id: 'F1', to_type: 'emotion_state', to_id: 'S1', type: 'grounds' },
      { id: 'L6', from_type: 'fact', from_id: 'F2', to_type: 'emotion_state', to_id: 'S2', type: 'grounds' },
      { id: 'L7', from_type: 'event', from_id: 'E1', to_type: 'emotion_transition', to_id: 'T1', type: 'associated_with' }
    ] };
}

test('v2 export and import preserve the four layers and stable evidence references', () => {
  const ws = workspace(); ws.graph = graph(ws);
  const result = makeExport(ws); assert.equal(result.schema_version, '2.0');
  const restored = parseResults(JSON.stringify(result));
  assert.deepEqual(restored.graph, result.graph);
  assert.deepEqual(restored.records, ws.records);
  assert.equal(restored.manifest.items[0].time_offset_s, 10);
  assert.equal(restored.manifest.items[0].timeline_id, 'scene');
  assert.equal(graphIssues(restored).filter(issue => issue.severity === 'error').length, 0);
});

test('state causal notes and direct state change edges roundtrip without rewriting historical transitions', () => {
  const ws = workspace(); ws.graph = graph(ws);
  ws.graph.links.push({ id: 'state-cause', from_type: 'event', from_id: 'E1', to_type: 'emotion_state', to_id: 'S2', type: 'causes', note: '人工确认的该事件专属依据' },
    { id: 'state-change', from_type: 'emotion_state', from_id: 'S1', to_type: 'emotion_state', to_id: 'S2', type: 'transitions_to' });
  const output = makeExport(ws), restored = parseResults(output);
  assert.deepEqual(restored.graph, output.graph);
  assert.deepEqual(restored.graph.emotion_transitions, ws.graph.emotion_transitions);
  assert.equal(restored.graph.links.find(link => link.id === 'state-cause').note, '人工确认的该事件专属依据');
});

test('derived event times survive roundtrip, ignore stale imported values and support old exports', () => {
  const ws = workspace(); ws.graph = graph(ws);
  ws.records.video.segments[1].start_time = 3; ws.records.video.segments[1].end_time = 4;
  ws.graph.emotion_states[1].end_time=14;
  const result = makeExport(ws);
  assert.deepEqual(result.derived.event_time_ranges.E1, { status: 'derived', timeline_id: 'scene', time_ranges: [{ start_time: 10, end_time: 11 }, { start_time: 13, end_time: 14 }] });
  assert.deepEqual(makeExport(parseResults(result)).derived, result.derived);
  result.derived.event_time_ranges.E1.time_ranges = [{ start_time: -999, end_time: 999 }];
  assert.deepEqual(makeExport(parseResults(result)).derived, makeExport(ws).derived);
  delete result.derived;
  assert.deepEqual(makeExport(parseResults(result)).derived, makeExport(ws).derived);
  ws.graph.links = ws.graph.links.filter(l => l.id !== 'L2');
  assert.equal(makeExport(ws).derived.event_time_ranges.E1.status, 'unresolved');
});

test('fact occurrence explanations and evidence presentation roundtrip with a derived event union',()=>{
  const ws=workspace();ws.graph=graph(ws);const records=structuredClone(ws.records);
  ws.graph.emotion_states[0].end_time=13.5;ws.graph.emotion_states[1].end_time=14;
  Object.assign(ws.graph.facts[0],{timeline_id:'scene',time_ranges:[{start_time:12,end_time:13.5}],time_note:'Later evidence recounts earlier content'});ws.graph.events[0].time_ranges=[{start_time:100,end_time:200}];
  const exported=makeExport(ws),restored=parseResults(exported);assert.equal(restored.graph.events[0].time_ranges,undefined);assert.equal(exported.derived.event_time_ranges.E1.status,'derived');assert.equal(restored.graph.facts[0].time_note,ws.graph.facts[0].time_note);assert.deepEqual(exported.derived.fact_temporal.F1.occurrence.time_ranges,[{start_time:12,end_time:13.5}]);assert.deepEqual(exported.derived.fact_temporal.F1.evidence_presentation.time_ranges,[{start_time:10,end_time:11}]);assert.deepEqual(exported.derived.event_time_ranges.E1.time_ranges,[{start_time:11,end_time:13.5}]);assert.deepEqual(ws.records,records);assert.deepEqual(makeExport(restored).derived,exported.derived);
});

test('legacy v1 data migrates to reviewable facts without replacing time-window IDs', () => {
  const source = makeExport(workspace()); source.schema_version = '1.0'; delete source.graph;
  const ws = parseResults(source);
  assert.deepEqual(ws.records.video.segments.map(segment => segment.id), ['w0', 'w1']);
  assert.equal(ws.graph.facts.length, 2);
  assert.ok(ws.graph.facts.every(fact => fact.review_status !== 'confirmed'));
  assert.equal(ws.graph.links.filter(link => link.type === 'supports').length, 2);
  const restored = parseResults(makeExport(ws));
  assert.deepEqual(restored.graph, ws.graph);
});

test('unknown legacy subjects remain distinct instead of creating a false shared person', () => {
  const source = makeExport(workspace()); source.schema_version = '1.0'; delete source.graph;
  source.items[0].segments.forEach(segment => { segment.annotations.subject_id = 'unknown'; });
  const ws = parseResults(source);
  const subjects = ws.graph.facts.map(fact => fact.subject_ids[0]);
  assert.equal(new Set(subjects).size, 2);
});

test('graph v2 rejects missing or dangling graph data instead of silently discarding it', () => {
  const source = makeExport(workspace()); delete source.graph;
  assert.throws(() => parseResults(source), /图谱/);
  const ws = workspace(); ws.graph = graph(ws);
  const result = makeExport(ws); result.graph.links[0].from_id = evidenceKey('missing', 'window');
  assert.throws(() => parseResults(result));
});

test('explicit common time offsets allow independent audio and video on one timeline', () => {
  const manifest = parseManifest({ schema_version: '2.0', items: [
    { id: 'v', media_path: 'clip.mp4', timeline_id: 'scene_1', time_offset_s: 10 },
    { id: 'a', media_path: 'clip.mp3', timeline_id: 'scene_1', time_offset_s: -2.5 },
  ] });
  assert.equal(manifest.items[0].timeline_id, manifest.items[1].timeline_id);
  assert.equal(manifest.items[1].time_offset_s, -2.5);
});
