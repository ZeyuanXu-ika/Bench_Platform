import test from 'node:test';
import assert from 'node:assert/strict';
import { blankGraph, evidenceKey, evidenceNodes, evidenceBounds, normalizeGraph, migrateLegacyGraph, graphIssues,
  invalidateEvidence, removeEvidence, removeGraphNode, MAX_GRAPH_NODES, MAX_GRAPH_LINKS } from '../graph.mjs';

function workspace() {
  return { manifest: { items: [{ id: 'video', title: 'Test video', media_type: 'video', source_id: 'source', timeline_id: 'scene', time_offset_s: 0, clip_start_s: 100 }] },
    records: { video: { segments: [{ id: 'window', label: 'visual_observation', start_time: 0, end_time: 2,
      annotations: { subject_id: 'person_1', local_fact: '人物将文件放到桌面', observation: '' } }] } }, graph: blankGraph() };
}
function link(id, from_type, from_id, to_type, to_id, type) { return { id, from_type, from_id, to_type, to_id, type }; }
function closedGraph() {
  const ws = workspace();
  ws.graph = { status: 'complete', entities: [{ id: 'p1', name: '人物 1', aliases: ['黄衣人'] }],
    mentions: [{ id: 'm1', entity_id: 'p1', evidence_id: evidenceKey('video', 'window'), description: '画面中的黄衣人' }],
    facts: [{ id: 'f1', text: '人物 1 将文件放到桌面', subject_ids: ['p1'], kind: 'observation', speaker_id: '', review_status: 'confirmed' }],
    events: [{ id: 'ev1', title: '人物 1 提交文件', subject_ids: ['p1'], timeline_id: 'scene', review_status: 'confirmed' }],
    emotion_states: [{ id: 's1', subject_id: 'p1', label: '平静', timeline_id: 'scene', start_time: 0, end_time: 2, intensity: null, review_status: 'confirmed' }],
    emotion_transitions: [], links: [link('l1', 'evidence', evidenceKey('video', 'window'), 'fact', 'f1', 'supports'), link('l2', 'fact', 'f1', 'event', 'ev1', 'constitutes'),
      link('l3', 'fact', 'f1', 'emotion_state', 's1', 'grounds'), link('l4', 'event', 'ev1', 'emotion_state', 's1', 'associated_with')] };
  return ws;
}
function transitionGraph() {
  const ws = closedGraph();
  ws.records.video.segments.push({ id: 'later', label: 'speech_content', start_time: 2, end_time: 4, annotations: {} });
  ws.graph.mentions.push({ id: 'm2', entity_id: 'p1', evidence_id: evidenceKey('video', 'later'), description: '同一人物继续讲话' });
  ws.graph.facts.push({ id: 'f2', text: '人物 1 说“我不接受”', subject_ids: ['p1'], kind: 'reported_speech', speaker_id: 'p1', review_status: 'confirmed' });
  ws.graph.events.push({ id: 'ev2', title: '人物 1 拒绝安排', subject_ids: ['p1'], timeline_id: 'scene', review_status: 'confirmed' });
  ws.graph.emotion_states.push({ id: 's2', subject_id: 'p1', label: '不满', timeline_id: 'scene', start_time: 2, end_time: 4, intensity: 3, review_status: 'confirmed' });
  ws.graph.emotion_transitions.push({ id: 't1', subject_id: 'p1', from_state_id: 's1', to_state_id: 's2', note: '', review_status: 'confirmed' });
  ws.graph.links.push(link('l5', 'evidence', evidenceKey('video', 'later'), 'fact', 'f2', 'supports'), link('l6', 'fact', 'f2', 'event', 'ev2', 'constitutes'),
    link('l7', 'fact', 'f2', 'emotion_state', 's2', 'grounds'), link('l8', 'event', 'ev2', 'emotion_transition', 't1', 'associated_with'));
  return ws;
}

test('evidence identity uses a safe item/segment tuple and derives global time without mutating media windows', () => {
  const ws = workspace(), before = structuredClone(ws);
  ws.manifest.items[0].time_offset_s = 5;
  const [node] = evidenceNodes(ws);
  assert.equal(node.id, '["video","window"]'); assert.equal(node.start_time, 0); assert.equal(node.global_start_time, 5); assert.equal(node.global_end_time, 7);
  assert.equal(node.timeline_id, 'scene'); assert.equal(node.modality, 'visual_observation'); assert.equal(node.media_type, 'video');
  assert.notEqual(evidenceKey('a:b', 'c'), evidenceKey('a', 'b:c'));
  assert.deepEqual(ws.records, before.records);
});

test('evidence bounds require explicit common timelines and include audio/video offsets', () => {
  const ws = workspace();
  ws.manifest.items.push({ id: 'audio', source_id: 'other', timeline_id: 'scene', media_type: 'audio', time_offset_s: 2 });
  ws.records.audio = { segments: [{ id: 'window', start_time: 1, end_time: 3, label: 'speech_content' }] };
  const refs = [evidenceKey('video', 'window'), evidenceKey('audio', 'window')];
  assert.deepEqual(evidenceBounds(ws, refs), { timeline_id: 'scene', start_time: 0, end_time: 5 });
  assert.equal(evidenceBounds(ws, []), null);
  ws.manifest.items[1].timeline_id = 'independent';
  assert.throws(() => evidenceBounds(ws, refs), /不同时间轴/);
  assert.throws(() => evidenceBounds(ws, ['missing']), /不存在/);
});

test('a reviewed four-layer graph with a stable emotional state can be complete without inventing a transition', () => {
  const ws = closedGraph();
  assert.deepEqual(normalizeGraph(ws.graph, ws), ws.graph);
  assert.equal(graphIssues(ws).filter(issue => issue.severity === 'error').length, 0);
  assert.ok(graphIssues(ws).some(issue => issue.severity === 'warning'));
});

test('normalization whitelists fields and cannot rehydrate prototype properties or hidden media payloads', () => {
  const ws = closedGraph();
  const raw = JSON.parse(JSON.stringify(ws.graph).replace('"status":', '"__proto__":{"polluted":true},"status":'));
  raw.secret = 'drop'; raw.facts[0].asset_bytes = 'drop';
  const clean = normalizeGraph(raw, ws);
  assert.equal({}.polluted, undefined); assert.equal(Object.hasOwn(clean, '__proto__'), false);
  assert.equal(Object.hasOwn(clean, 'secret'), false); assert.equal(Object.hasOwn(clean.facts[0], 'asset_bytes'), false);
});

test('dangling entity, evidence and graph references are rejected even in drafts', () => {
  for (const corrupt of [g => { g.facts[0].subject_ids = ['missing']; }, g => { g.mentions[0].evidence_id = 'missing'; }, g => { g.links[0].from_id = 'missing'; }, g => { g.links[0].to_id = 'missing'; }]) {
    const ws = closedGraph(); ws.graph.status = 'draft'; corrupt(ws.graph);
    assert.throws(() => normalizeGraph(ws.graph, ws), /不存在/);
  }
});

test('duplicate node IDs, duplicate relations and illegal layer directions are rejected', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.graph.facts[0].id = 'p1'; assert.throws(() => normalizeGraph(ws.graph, ws), /ID 重复/);
  const ws2 = closedGraph(); ws2.graph.links.push({ ...ws2.graph.links[0], id: 'copy' });
  assert.throws(() => normalizeGraph(ws2.graph, ws2), /关联重复/);
  const ws3 = closedGraph(); ws3.graph.links[0].type = 'causes';
  assert.throws(() => normalizeGraph(ws3.graph, ws3), /方向或关系/);
});

test('cross-timeline support remains editable in a draft but blocks completion', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.manifest.items.push({ id: 'audio', source_id: 'other', media_type: 'audio' });
  ws.records.audio = { segments: [{ id: 'extra', start_time: 0, end_time: 2, label: 'speech_content' }] };
  ws.graph.links.push(link('extra_link', 'evidence', evidenceKey('audio', 'extra'), 'fact', 'f1', 'supports'));
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  assert.ok(graphIssues(ws).some(issue => issue.message.includes('不同时间轴')));
  ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
});

test('a state requires factual grounding and an event association to close all four layers', () => {
  for (const omitted of ['l3', 'l4']) {
    const ws = closedGraph(); ws.graph.status = 'draft'; ws.graph.links = ws.graph.links.filter(edge => edge.id !== omitted);
    assert.ok(graphIssues(ws).some(issue => issue.severity === 'error' && issue.node_id === 's1'));
    ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
  }
});

test('an ordered same-subject transition can associate both states to a concrete event', () => {
  const ws = transitionGraph();
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  assert.equal(graphIssues(ws).filter(issue => issue.severity === 'error').length, 0);
  const transition = ws.graph.emotion_transitions[0]; transition.subject_id = '';
  assert.ok(graphIssues(ws).some(issue => issue.message.includes('同一主体')));
});

test('transition subject, timeline, ordering and causal-judgment problems remain visible and block completion', () => {
  for (const mutate of [ws => { ws.graph.emotion_states[1].timeline_id = 'other'; }, ws => { ws.graph.emotion_states[1].start_time = 1; }, ws => { ws.graph.emotion_transitions[0].subject_id = ''; }, ws => { ws.graph.links.at(-1).type = 'causes'; }]) {
    const ws = transitionGraph(); ws.graph.status = 'draft'; mutate(ws);
    assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
    assert.ok(graphIssues(ws).some(issue => issue.severity === 'error'));
    ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
  }
});

test('reported speech needs an identified speaker and states retain optional bounded intensity', () => {
  const ws = closedGraph(); ws.graph.status = 'draft'; ws.graph.facts[0].kind = 'reported_speech';
  assert.ok(graphIssues(ws).some(issue => issue.message.includes('说话人')));
  for (const value of [0, 6, 1.5, '3']) {
    ws.graph.emotion_states[0].intensity = value;
    assert.throws(() => normalizeGraph(ws.graph, ws), /情感强度/);
  }
  ws.graph.emotion_states[0].intensity = null; assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
});

test('unconfirmed graph nodes and unbound coreference mentions prevent completion', () => {
  const ws = closedGraph(); ws.graph.status = 'draft'; ws.graph.facts[0].review_status = 'needs_review'; ws.graph.mentions[0].entity_id = '';
  const errors = graphIssues(ws).filter(issue => issue.severity === 'error');
  assert.ok(errors.some(issue => issue.message.includes('人工确认'))); assert.ok(errors.some(issue => issue.message.includes('统一主体')));
  ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
});

test('a subject mentioned elsewhere in a project does not ground its identity in an unrelated fact window', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.records.video.segments.push({ id: 'elsewhere', label: 'visual_observation', start_time: 8, end_time: 10, annotations: {} });
  ws.graph.mentions[0].evidence_id = evidenceKey('video', 'elsewhere');
  ws.graph.facts.push({ ...ws.graph.facts[0], id: 'f2' });
  ws.graph.links.push(link('extra', 'evidence', evidenceKey('video', 'elsewhere'), 'fact', 'f2', 'supports'));
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 'f1' && issue.message.includes('本事实的支持窗')));
  ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
});

test('a reported speaker needs a mention in that fact support and cannot alone ground another subject emotion', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.graph.entities.push({ id: 'p2', name: '第二人物', aliases: [] });
  ws.graph.facts[0].kind = 'reported_speech'; ws.graph.facts[0].speaker_id = 'p2';
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 'f1' && issue.message.includes('说话人在本事实')));
  ws.graph.mentions.push({ id: 'm2', entity_id: 'p2', evidence_id: evidenceKey('video', 'window'), description: '说话人' });
  assert.equal(graphIssues(ws).some(issue => issue.node_id === 'f1' && issue.message.includes('说话人在本事实')), false);
  ws.graph.emotion_states[0].subject_id = 'p2';
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 's1' && issue.message.includes('对应主体的事实')));
});

test('event participants require support from constituent fact subjects or speakers', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.graph.entities.push({ id: 'p2', name: '第二人物', aliases: [] });
  ws.graph.mentions.push({ id: 'm2', entity_id: 'p2', evidence_id: evidenceKey('video', 'window'), description: '另一人物' });
  ws.graph.events[0].subject_ids = ['p2'];
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 'ev1' && issue.message.includes('事件参与者缺少')));
  ws.graph.facts[0].kind = 'reported_speech'; ws.graph.facts[0].speaker_id = 'p2';
  assert.equal(graphIssues(ws).some(issue => issue.node_id === 'ev1' && issue.message.includes('事件参与者缺少')), false);
});

test('an imported observation cannot smuggle a speaker into supported event participants', () => {
  const ws = closedGraph(); ws.graph.status = 'draft';
  ws.graph.entities.push({ id: 'p2', name: '第二人物', aliases: [] });
  ws.graph.mentions.push({ id: 'm2', entity_id: 'p2', evidence_id: evidenceKey('video', 'window'), description: '另一人物' });
  ws.graph.facts[0].speaker_id = 'p2'; ws.graph.events[0].subject_ids = ['p2'];
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 'f1' && issue.message.includes('观察事实不能设置发言者')));
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 'ev1' && issue.message.includes('事件参与者缺少')));
  ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
  ws.graph.status = 'draft'; ws.graph.facts[0].kind = 'reported_speech';
  assert.equal(graphIssues(ws).filter(issue => issue.severity === 'error').length, 0);
});

test('unclassified evidence cannot be hidden behind otherwise complete upper layers', () => {
  const ws = closedGraph(); ws.records.video.segments[0].label = 'unclassified';
  assert.ok(graphIssues(ws).some(issue => issue.node_type === 'evidence' && issue.message.includes('模态归属')));
  assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
});

test('a wholly future event cannot cause an earlier emotion transition, while association makes no causal ordering claim', () => {
  const ws = transitionGraph(); ws.graph.status = 'draft';
  ws.records.video.segments.push({ id: 'future', label: 'visual_observation', start_time: 8, end_time: 10, annotations: {} });
  ws.graph.mentions.push({ id: 'm3', entity_id: 'p1', evidence_id: evidenceKey('video', 'future'), description: '后续事件中的人物' });
  ws.graph.facts.push({ ...ws.graph.facts[0], id: 'f3', text: '后续事实' });
  ws.graph.links.push(link('l9', 'evidence', evidenceKey('video', 'future'), 'fact', 'f3', 'supports'));
  ws.graph.links.find(edge => edge.id === 'l6').from_id = 'f3';
  ws.graph.links.find(edge => edge.id === 'l8').type = 'causes'; ws.graph.emotion_transitions[0].note = '人工因果判断';
  assert.ok(graphIssues(ws).some(issue => issue.node_id === 't1' && issue.message.includes('不能导致')));
  ws.graph.status = 'complete'; assert.throws(() => normalizeGraph(ws.graph, ws), /不能标记完成/);
  ws.graph.status = 'draft'; ws.graph.links.find(edge => edge.id === 'l8').type = 'associated_with';
  assert.equal(graphIssues(ws).some(issue => issue.message.includes('不能导致')), false);
});

test('legacy facts migrate to reviewable graph nodes and unknown subjects never merge by name', () => {
  const ws = workspace(); ws.records.video.segments[0].annotations.subject_id = 'unknown';
  ws.records.video.segments.push({ id: 'second', label: 'speech_content', start_time: 2, end_time: 4, annotations: { subject_id: 'unknown', observation: '人物说了一句话' } });
  const before = structuredClone(ws), graph = migrateLegacyGraph(ws);
  assert.equal(graph.entities.length, 2); assert.notEqual(graph.facts[0].subject_ids[0], graph.facts[1].subject_ids[0]);
  assert.equal(graph.facts.length, 2); assert.ok(graph.facts.every(fact => fact.review_status === 'needs_review'));
  assert.equal(graph.facts[1].kind, 'reported_speech'); assert.equal(graph.events.length, 0); assert.equal(graph.emotion_states.length, 0);
  assert.equal(graph.links[0].from_id, evidenceKey('video', 'window')); assert.deepEqual(ws, before);
});

test('evidence changes transitively invalidate facts, events, states and transitions and revoke graph completion', () => {
  const ws = transitionGraph();
  assert.equal(invalidateEvidence(ws, evidenceKey('video', 'window')), ws.graph);
  assert.equal(ws.graph.status, 'draft'); assert.equal(ws.graph.facts[0].review_status, 'needs_review');
  assert.equal(ws.graph.events[0].review_status, 'needs_review'); assert.equal(ws.graph.emotion_states[0].review_status, 'needs_review');
  assert.equal(ws.graph.emotion_transitions[0].review_status, 'needs_review');
  assert.equal(ws.graph.facts[1].review_status, 'confirmed');
});

test('removing evidence strips only its mentions and edges while retaining upper-level drafts for repair', () => {
  const ws = closedGraph(); removeEvidence(ws, [evidenceKey('video', 'window')]); ws.records.video.segments = [];
  assert.equal(ws.graph.mentions.length, 0); assert.equal(ws.graph.links.some(edge => edge.from_type === 'evidence'), false);
  assert.equal(ws.graph.facts.length, 1); assert.equal(ws.graph.facts[0].review_status, 'needs_review');
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws)); assert.ok(graphIssues(ws).some(issue => issue.message.includes('没有支持证据')));
});

test('removing a fact removes its relations and invalidates dependent event and emotional state', () => {
  const ws = closedGraph(); removeGraphNode(ws, 'facts', 'f1');
  assert.equal(ws.graph.facts.length, 0); assert.equal(ws.graph.links.some(edge => edge.from_id === 'f1' || edge.to_id === 'f1'), false);
  assert.equal(ws.graph.events[0].review_status, 'needs_review'); assert.equal(ws.graph.emotion_states[0].review_status, 'needs_review');
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
});

test('removing a state also removes referencing transitions and their links', () => {
  const ws = transitionGraph(); removeGraphNode(ws, 'emotion_state', 's1');
  assert.equal(ws.graph.emotion_transitions.length, 0);
  assert.equal(ws.graph.links.some(edge => edge.to_id === 't1' || edge.to_id === 's1'), false);
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
});

test('removing an entity leaves explicit unassigned drafts rather than dangling subject references', () => {
  const ws = transitionGraph(); removeGraphNode(ws, 'entity', 'p1');
  assert.equal(ws.graph.entities.length, 0); assert.equal(ws.graph.mentions.length, 0);
  assert.deepEqual(ws.graph.facts[0].subject_ids, []); assert.equal(ws.graph.facts[1].speaker_id, '');
  assert.equal(ws.graph.emotion_states[0].subject_id, ''); assert.equal(ws.graph.emotion_transitions[0].subject_id, '');
  assert.doesNotThrow(() => normalizeGraph(ws.graph, ws)); assert.ok(graphIssues(ws).some(issue => issue.severity === 'error'));
});

test('removing a relation invalidates its target and removing a mention invalidates the affected subject facts', () => {
  const ws = closedGraph(); removeGraphNode(ws, 'link', 'l1');
  assert.equal(ws.graph.links.length, 3); assert.equal(ws.graph.facts[0].review_status, 'needs_review');
  const ws2 = closedGraph(); removeGraphNode(ws2, 'mention', 'm1');
  assert.equal(ws2.graph.mentions.length, 0); assert.equal(ws2.graph.facts[0].review_status, 'needs_review');
});

test('graph imports enforce total node and edge bounds', () => {
  const ws = workspace(), graph = blankGraph();
  graph.entities = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, n) => ({ id: `p_${n}`, name: 'Person', aliases: [] }));
  assert.throws(() => normalizeGraph(graph, ws), /10000/);
  graph.entities = []; graph.links = Array(MAX_GRAPH_LINKS + 1).fill({});
  assert.throws(() => normalizeGraph(graph, ws), /50000/);
});

test('large fan-out and converging dependency paths invalidate every descendant without touching an independent branch or reusing stale indexes', () => {
  const ws = closedGraph(), width = 256;
  ws.records.video.segments.push({ id: 'later', label: 'visual_observation', start_time: 2, end_time: 4, annotations: {} });
  ws.graph.mentions.push({ id: 'later_mention', entity_id: 'p1', evidence_id: evidenceKey('video', 'later'), description: '同一主体的后续提及' });
  for (let n = 0; n < width; n++) {
    const fact = `fan_fact_${n}`, event = `fan_event_${n}`, state = `fan_state_${n}`, transition = `fan_transition_${n}`;
    ws.graph.facts.push({ ...ws.graph.facts[0], id: fact });
    ws.graph.events.push({ ...ws.graph.events[0], id: event });
    ws.graph.emotion_states.push({ ...ws.graph.emotion_states[0], id: state, start_time: 2, end_time: 4 });
    ws.graph.emotion_transitions.push({ id: transition, subject_id: 'p1', from_state_id: 's1', to_state_id: state, note: '', review_status: 'confirmed' });
    ws.graph.links.push(
      link(`fan_root_${n}`, 'evidence', evidenceKey('video', 'window'), 'fact', fact, 'supports'),
      link(`fan_later_${n}`, 'evidence', evidenceKey('video', 'later'), 'fact', fact, 'supports'),
      link(`fan_own_fact_${n}`, 'fact', fact, 'event', event, 'constitutes'),
      link(`fan_shared_fact_${n}`, 'fact', 'f1', 'event', event, 'constitutes'),
      link(`fan_grounds_${n}`, 'fact', fact, 'emotion_state', state, 'grounds'),
      link(`fan_state_context_${n}`, 'event', event, 'emotion_state', state, 'associated_with'),
      link(`fan_transition_context_${n}`, 'event', event, 'emotion_transition', transition, 'associated_with'));
  }
  ws.graph.facts.push({ ...ws.graph.facts[0], id: 'independent_fact' });
  ws.graph.events.push({ ...ws.graph.events[0], id: 'independent_event' });
  ws.graph.emotion_states.push({ ...ws.graph.emotion_states[0], id: 'independent_state', start_time: 2, end_time: 4 });
  ws.graph.links.push(link('independent_support', 'evidence', evidenceKey('video', 'later'), 'fact', 'independent_fact', 'supports'),
    link('independent_constitutes', 'fact', 'independent_fact', 'event', 'independent_event', 'constitutes'),
    link('independent_grounds', 'fact', 'independent_fact', 'emotion_state', 'independent_state', 'grounds'),
    link('independent_context', 'event', 'independent_event', 'emotion_state', 'independent_state', 'associated_with'));
  assert.equal(graphIssues(ws).filter(issue => issue.severity === 'error').length, 0);
  invalidateEvidence(ws, evidenceKey('video', 'window'));
  for (const collection of ['facts', 'events', 'emotion_states', 'emotion_transitions']) {
    for (const node of ws.graph[collection]) assert.equal(node.review_status, node.id.startsWith('independent_') ? 'confirmed' : 'needs_review', `${collection}:${node.id}`);
  }
  // Editing relations between operations must rebuild indexes rather than retain the previous adjacency.
  ws.graph.links = ws.graph.links.filter(edge => !edge.id.startsWith('fan_root_'));
  for (const collection of ['facts', 'events', 'emotion_states', 'emotion_transitions']) for (const node of ws.graph[collection]) node.review_status = 'confirmed';
  assert.equal(graphIssues(ws).filter(issue => issue.severity === 'error').length, 0);
  invalidateEvidence(ws, evidenceKey('video', 'window'));
  assert.ok(ws.graph.facts.filter(node => node.id.startsWith('fan_')).every(node => node.review_status === 'confirmed'));
  assert.ok(ws.graph.events.filter(node => node.id.startsWith('fan_')).every(node => node.review_status === 'needs_review'));
  assert.ok(ws.graph.emotion_transitions.every(node => node.review_status === 'needs_review'));
  assert.equal(ws.graph.emotion_states.find(node => node.id === 'independent_state').review_status, 'confirmed');
});
