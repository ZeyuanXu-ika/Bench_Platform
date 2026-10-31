import test from 'node:test';
import assert from 'node:assert/strict';
import { blankGraph, evidenceKey, normalizeGraph, eventTimeRanges, factTimeRanges } from '../graph.mjs';
import { annotationTimelineData, planAnnotationTimeEdit, applyAnnotationTimePlan, createAnnotationDraft } from '../annotation-timeline.mjs';
import { packTimelineRows } from '../annotation-timeline.mjs';

function workspace() {
  const ws = { index: 0, manifest: { items: [{ id: 'clip', media_type: 'video', timeline_id: 'scene', time_offset_s: 100, duration_s: 1200 }] },
    records: { clip: { segments: [{ id: 'a', start_time: 10, end_time: 20 }, { id: 'b', start_time: 100, end_time: 110 }] } }, graph: blankGraph() };
  ws.graph.entities.push({ id: 'p', name: '人物甲' });
  ws.graph.facts.push({ id: 'f', text: '同一事实的两段依据', subject_ids: ['p'], review_status: 'confirmed' });
  ws.graph.events.push({ id: 'e', title: '跨时事件', subject_ids: ['p'], review_status: 'confirmed' });
  ws.graph.links.push(...['a', 'b'].map(segment => ({ from_type: 'evidence', from_id: evidenceKey('clip', segment), to_type: 'fact', to_id: 'f', type: 'supports' })),
    { from_type: 'fact', from_id: 'f', to_type: 'event', to_id: 'e', type: 'constitutes' });
  for (const segment of ws.records.clip.segments) { segment.label = 'visual_observation'; segment.annotations = {}; }
  return ws;
}

test('non-overlapping annotations share lanes and overlapping windows get another lane',()=>{
  const rows=[{id:'a',type:'fact',time_ranges:[{start_time:1,end_time:2},{start_time:5,end_time:6}]},{id:'b',type:'fact',time_ranges:[{start_time:3,end_time:4}]},{id:'c',type:'fact',time_ranges:[{start_time:1.5,end_time:3.5}]}],before=structuredClone(rows),lanes=packTimelineRows(rows);
  assert.equal(lanes.length,2);assert.deepEqual(lanes[0].rows.map(row=>row.id),['a','b']);assert.deepEqual(rows,before);
});

test('emotion lanes group by canonical subject even when states overlap, while changes stay as connections',()=>{
  const ws=workspace();ws.graph.entities.push({id:'q',name:'人物甲'});
  ws.graph.emotion_states.push({id:'p1',subject_id:'p',timeline_id:'scene',label:'状态一',start_time:110,end_time:130},{id:'p2',subject_id:'p',timeline_id:'scene',label:'状态二',start_time:120,end_time:140},{id:'q1',subject_id:'q',timeline_id:'scene',label:'另一人物',start_time:110,end_time:140});
  ws.graph.links.push({id:'change',from_type:'emotion_state',from_id:'p1',to_type:'emotion_state',to_id:'p2',type:'transitions_to'});
  const group=annotationTimelineData(ws,'emotions').groups[0],lanes=packTimelineRows(group.rows,{groupBySubject:true});
  assert.equal(group.rows.length,3);assert.equal(group.connections.length,1);assert.equal(lanes.length,2);assert.deepEqual(lanes.find(lane=>lane.subject_id==='p').rows.map(row=>row.id),['p1','p2']);assert.equal(lanes.find(lane=>lane.subject_id==='q').rows[0].id,'q1');
});

test('fact and event tracks share full source extent and preserve aligned disjoint evidence windows', () => {
  const ws = workspace(), before = structuredClone(ws);
  for (const stage of ['facts', 'events']) {
    const { groups, unresolved } = annotationTimelineData(ws, stage);
    assert.equal(groups.length, 1); assert.deepEqual(unresolved, []);
    assert.equal(groups[0].start_time, 100); assert.equal(groups[0].end_time, 1300);
    assert.deepEqual(groups[0].rows[0].time_ranges, [{ start_time: 110, end_time: 120 }, { start_time: 200, end_time: 210 }]);
    assert.equal(groups[0].rows[0].subjects, '人物甲');
  }
  assert.deepEqual(ws, before);
});

test('moving a fact band changes only its independent time and never source evidence', () => {
  const ws = workspace(); ws.graph.facts.push({ id: 'shared', text: '共用证据', subject_ids: [], review_status: 'confirmed' });
  ws.graph.links.push({ from_type: 'evidence', from_id: evidenceKey('clip', 'a'), to_type: 'fact', to_id: 'shared', type: 'supports' });
  const before = structuredClone(ws), request = { type: 'fact', id: 'f', mode: 'move', delta: 5 };
  const plan = planAnnotationTimeEdit(ws, request);
  assert.deepEqual(ws, before, 'preview must not mutate annotations');
  applyAnnotationTimePlan(ws, plan);
  assert.equal(ws.records.clip.segments[0].start_time, 10); assert.equal(ws.records.clip.segments[0].end_time, 20);
  assert.equal(ws.records.clip.segments[1].start_time, 100);
  assert.equal(ws.graph.facts.find(fact=>fact.id==='f').review_status,'needs_review');
  assert.deepEqual(ws.records,before.records);
  assert.equal(ws.graph.events[0].review_status, 'needs_review');
  assert.deepEqual(annotationTimelineData(ws, 'events').groups[0].rows[0].time_ranges, [{ start_time: 115, end_time: 125 }, { start_time: 200, end_time: 210 }]);
});

test('events are read-only unions and rejected edits never change facts or evidence',()=>{
  const ws=workspace(),before=structuredClone(ws);
  for(const mode of ['move','start','end'])assert.throws(()=>planAnnotationTimeEdit(ws,{type:'event',id:'e',mode,delta:50}));
  assert.throws(()=>applyAnnotationTimePlan(ws,{evidence_updates:[],fact_updates:[],state_updates:[],event_updates:[{id:'e',timeline_id:'scene',time_ranges:[{start_time:0,end_time:1}]}]}));assert.deepEqual(ws,before);
});

test('nested facts keep independent content and event union follows fact occurrence',()=>{
  const ws=workspace();Object.assign(ws.graph.facts[0],{timeline_id:'scene',time_ranges:[{start_time:110,end_time:140}]});
  ws.graph.links=ws.graph.links.filter(link=>link.from_id!==evidenceKey('clip','b'));
  ws.graph.facts.push({id:'f2',text:'nested fact content',subject_ids:['p'],kind:'observation',speaker_id:'',review_status:'confirmed',timeline_id:'scene',time_ranges:[{start_time:120,end_time:125}]});
  ws.graph.links.push({from_type:'fact',from_id:'f2',to_type:'event',to_id:'e',type:'constitutes'});
  const records=structuredClone(ws.records),links=structuredClone(ws.graph.links);assert.deepEqual(eventTimeRanges(ws).e.time_ranges,[{start_time:110,end_time:140}]);
  applyAnnotationTimePlan(ws,planAnnotationTimeEdit(ws,{type:'fact',id:'f2',mode:'move',delta:50}));assert.deepEqual(eventTimeRanges(ws).e.time_ranges,[{start_time:110,end_time:140},{start_time:170,end_time:175}]);assert.deepEqual(ws.records,records);assert.deepEqual(ws.graph.links,links);assert.equal(ws.graph.facts[1].text,'nested fact content');assert.equal(ws.graph.facts.length,2);
});

test('no-op edits preserve review while invalid multi-target plans cannot partially write evidence', () => {
  const ws = workspace(); ws.graph.status = 'complete';
  assert.equal(applyAnnotationTimePlan(ws, planAnnotationTimeEdit(ws, { type: 'fact', id: 'f', mode: 'move', delta: 0 })), 0);
  assert.equal(ws.graph.status, 'complete'); assert.equal(ws.graph.facts[0].review_status, 'confirmed');
  const plan = planAnnotationTimeEdit(ws, { type: 'fact', id: 'f', mode: 'move', delta: 2 }), before = structuredClone(ws);
  plan.state_updates.push({ id: 'missing', start_time: 0, end_time: 1 });
  assert.throws(() => applyAnnotationTimePlan(ws, plan), /情感状态/); assert.deepEqual(ws, before);
});

test('independent fact windows roundtrip and event union follows them instead of rewriting evidence',()=>{
  const ws=workspace(),records=structuredClone(ws.records);ws.graph.links.forEach((link,index)=>link.id=`L${index}`);applyAnnotationTimePlan(ws,planAnnotationTimeEdit(ws,{type:'fact',id:'f',mode:'move',delta:10}));
  ws.graph=normalizeGraph(ws.graph,ws);assert.deepEqual(ws.records,records);assert.deepEqual(ws.graph.facts[0].time_ranges,[{start_time:120,end_time:130},{start_time:200,end_time:210}]);
  assert.deepEqual(annotationTimelineData(ws,'events').groups[0].rows[0].time_ranges,ws.graph.facts[0].time_ranges);
});

test('dragging a transition endpoint edits its actual state and marks the transition for review', () => {
  const ws = workspace(), evidence = structuredClone(ws.records);
  ws.graph.emotion_states.push({ id: 's1', subject_id: 'p', timeline_id: 'scene', label: '平静', start_time: 110, end_time: 120, review_status: 'confirmed' },
    { id: 's2', subject_id: 'p', timeline_id: 'scene', label: '激动', start_time: 200, end_time: 210, review_status: 'confirmed' });
  ws.graph.emotion_transitions.push({ id: 't', subject_id: 'p', from_state_id: 's1', to_state_id: 's2', review_status: 'confirmed' });
  applyAnnotationTimePlan(ws, planAnnotationTimeEdit(ws, { type: 'emotion_transition', id: 't', range_index: 1, mode: 'move', delta: 4 }));
  assert.equal(ws.graph.emotion_states[1].start_time, 204); assert.equal(ws.graph.emotion_states[0].start_time, 110);
  assert.equal(ws.graph.emotion_transitions[0].review_status, 'needs_review'); assert.deepEqual(ws.records, evidence);
});

test('drawing creates linked empty drafts without inventing subjects or factual claims', () => {
  for (const stage of ['facts', 'events', 'emotions']) {
    const ws = workspace(); ws.graph.links.forEach((link, n) => { link.id = `L${n}`; });
    const initial = ws.records.clip.segments.length;
    const entry = createAnnotationDraft(ws, stage, 'scene', 130, 140);
    assert.equal(entry.type, stage === 'facts' ? 'fact' : stage === 'events' ? 'event' : 'emotion_state');
    assert.doesNotThrow(() => normalizeGraph(ws.graph, ws));
    const row = annotationTimelineData(ws, stage).groups[0].rows.find(row => row.id === entry.id);
    assert.deepEqual(row.time_ranges, [{ start_time: 130, end_time: 140 }]);
    assert.equal(ws.records.clip.segments.length, initial);

  }
  const ws = workspace(), before = structuredClone(ws);
  assert.throws(() => createAnnotationDraft(ws, 'facts', 'scene', 0, 10), /没有完整覆盖/); assert.deepEqual(ws, before);
});

test('edits and removed support are reflected without a cached or fabricated timeline position', () => {
  const ws = workspace();
  ws.records.clip.segments[1].start_time = 20;
  assert.deepEqual(annotationTimelineData(ws, 'events').groups[0].rows[0].time_ranges, [{ start_time: 110, end_time: 210 }]);
  ws.graph.links = ws.graph.links.filter(link => link.type !== 'supports');
  for (const stage of ['facts', 'events']) {
    const data = annotationTimelineData(ws, stage);
    assert.equal(data.groups[0].rows.length, 0); assert.equal(data.unresolved.length, 1);
  }
});

test('different source timelines remain separate and mixed evidence is explicitly unresolved', () => {
  const ws = workspace();
  ws.manifest.items.push({ id: 'other', timeline_id: 'other', duration_s: 200 });
  ws.records.other = { segments: [{ id: 'c', start_time: 1, end_time: 2 }] };
  ws.graph.links.push({ from_type: 'evidence', from_id: evidenceKey('other', 'c'), to_type: 'fact', to_id: 'f', type: 'supports' });
  const data = annotationTimelineData(ws, 'facts');
  assert.equal(data.groups.length, 2); assert.equal(data.unresolved.length, 1);
  assert.match(data.unresolved[0].reason, /不同时间轴/);
  assert.ok(data.groups.every(group => group.rows.length === 0));
});

test('emotion changes connect states without creating duplicate endpoint rows', () => {
  const ws = workspace();
  ws.graph.emotion_states.push({ id: 's1', subject_id: 'p', timeline_id: 'scene', label: '平静', start_time: 110, end_time: 120 },
    { id: 's2', subject_id: 'p', timeline_id: 'scene', label: '激动', start_time: 200, end_time: 210 });
  ws.graph.emotion_transitions.push({ id: 't', subject_id: 'p', from_state_id: 's1', to_state_id: 's2' });
  const rows = annotationTimelineData(ws, 'emotions').groups[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.id === 's1').time_ranges, [{ start_time: 110, end_time: 120 }]);
  assert.deepEqual(annotationTimelineData(ws,'emotions').groups[0].connections.map(link=>[link.id,link.from_state_id,link.to_state_id]),[['t','s1','s2']]);
  ws.graph.emotion_states[1].timeline_id = 'elsewhere';
  assert.equal(annotationTimelineData(ws, 'emotions').unresolved[0].id, 't');
});

test('legacy clips without duration still show evidence extent with source offsets', () => {
  const ws = workspace(); delete ws.manifest.items[0].duration_s; delete ws.manifest.items[0].time_offset_s;
  ws.manifest.items[0].clip_start_s = 500;
  const group = annotationTimelineData(ws, 'facts').groups[0];
  assert.equal(group.start_time, 510); assert.equal(group.end_time, 610);
});

test('all emotion subjects share one axis while state and transition ownership keeps canonical IDs', () => {
  const ws = workspace(); ws.graph.entities.push({ id: 'q', name: '人物甲' });
  for (const subject of ['p', 'q']) {
    ws.graph.emotion_states.push({ id: `${subject}1`, subject_id: subject, timeline_id: 'scene', label: '状态一', start_time: 110, end_time: 120 },
      { id: `${subject}2`, subject_id: subject, timeline_id: 'scene', label: '状态二', start_time: 200, end_time: 210 });
    ws.graph.emotion_transitions.push({ id: `${subject}t`, subject_id: subject, from_state_id: `${subject}1`, to_state_id: `${subject}2` });
  }
  assert.equal(annotationTimelineData(ws, 'emotions').groups[0].rows.length, 4);
  const rows = annotationTimelineData(ws, 'emotions').groups[0].rows;
  assert.equal(rows.length, 4);assert.equal(annotationTimelineData(ws,'emotions').groups[0].connections.length,2);
  assert.deepEqual(new Set(rows.filter(row => row.subject_id === 'q').map(row => row.id)), new Set(['q1', 'q2']));
  assert.deepEqual(new Set(rows.filter(row => row.subject_id === 'p').map(row => row.id)), new Set(['p1', 'p2']));
});
