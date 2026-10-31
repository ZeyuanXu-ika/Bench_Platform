import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkspace, parseManifest, makeExport, makeItemExport, makeItemExportFiles } from '../core.mjs';
import { blankGraph, evidenceKey, assertTemporalOrder, temporalOrderIssues, assertEvidenceTimeChange, eventTimeRanges } from '../graph.mjs';
import { applyAnnotationTimePlan } from '../annotation-timeline.mjs';

function fixture() {
  const ws=newWorkspace(parseManifest({batch_id:'time',assignment_id:'task',annotator_id:'ann',items:[{id:'v',media_path:'v.mp4',duration_s:30,timeline_id:'scene'}]}));
  ws.graph=blankGraph();ws.graph.entities=[{id:'P001',name:'A',aliases:[]}];
  ws.records.v.segments=[[1,3],[5,7],[8,10]].map(([start_time,end_time],index)=>({id:`W00${index+1}`,start_time,end_time,label:'visual_observation',annotations:{observation:'Evidence',subject_ids:['P001']}}));
  ws.graph.facts=[{id:'F001',text:'Fact',subject_ids:['P001'],timeline_id:'scene',time_ranges:[{start_time:2,end_time:8}]},{id:'F002',text:'Other fact',subject_ids:['P001']}];
  ws.graph.events=[{id:'E001',title:'Event',subject_ids:['P001'],timeline_id:'scene'}];
  ws.graph.emotion_states=[{id:'S001',subject_id:'P001',label:'State',timeline_id:'scene',start_time:4,end_time:9},{id:'S002',subject_id:'P001',label:'Next',timeline_id:'scene',start_time:10,end_time:15}];
  const edge=(id,from_type,from_id,to_type,to_id,type)=>({id,from_type,from_id,to_type,to_id,type});
  ws.graph.links=[edge('R001','evidence',evidenceKey('v','W001'),'fact','F001','supports'),edge('R002','evidence',evidenceKey('v','W002'),'fact','F001','supports'),edge('R003','evidence',evidenceKey('v','W003'),'fact','F002','supports'),edge('R004','fact','F001','event','E001','constitutes'),edge('R005','event','E001','emotion_state','S001','associated_with'),edge('R006','fact','F001','emotion_state','S001','grounds')];
  return ws;
}

test('end constraint allows earlier starts, overlap, exact equality and disjoint unions',()=>{
  const ws=fixture();assert.doesNotThrow(()=>assertTemporalOrder(ws));
  ws.graph.facts[0].time_ranges=[{start_time:0,end_time:4},{start_time:6,end_time:7}];
  ws.graph.emotion_states[0].start_time=6.5;ws.graph.emotion_states[0].end_time=7;
  assert.doesNotThrow(()=>assertTemporalOrder(ws));assert.equal(temporalOrderIssues(ws).length,0);
});

test('all evidence sources are checked, including the last of several windows',()=>{
  const ws=fixture();ws.graph.facts[0].time_ranges=[{start_time:2,end_time:6}];
  const issues=temporalOrderIssues(ws);assert.equal(issues.length,1);assert.equal(issues[0].from_id,evidenceKey('v','W002'));assert.equal(issues[0].target_end,6);
  assert.throws(()=>assertTemporalOrder(ws),error=>error.code==='TEMPORAL_ORDER'&&/W002/.test(error.message)&&/F001/.test(error.message));
});

test('fact edits propagate through event unions and validate every downstream relation',()=>{
  const ws=fixture();ws.graph.facts[0].time_ranges=[{start_time:2,end_time:11}];
  assert.equal(eventTimeRanges(ws).E001.time_ranges.at(-1).end_time,11);
  const issues=temporalOrderIssues(ws);assert.ok(issues.some(issue=>issue.from_type==='event'));assert.ok(issues.some(issue=>issue.from_type==='fact'&&issue.to_type==='emotion_state'));
});

test('new constituent links cannot move a derived event past an existing emotion',()=>{
  const ws=fixture();ws.graph.links.push({id:'R007',from_type:'fact',from_id:'F002',to_type:'event',to_id:'E001',type:'constitutes'});
  assert.equal(eventTimeRanges(ws).E001.time_ranges.at(-1).end_time,10);assert.throws(()=>assertTemporalOrder(ws),/E001.*S001/);
});

test('shortening an emotion validates both direct facts and compound events',()=>{
  const ws=fixture();ws.graph.emotion_states[0].end_time=7.5;
  assert.equal(temporalOrderIssues(ws).filter(issue=>issue.to_id==='S001').length,2);
});

test('comparisons use aligned seconds and reject distinct timeline identities',()=>{
  const ws=fixture();ws.manifest.items[0].time_offset_s=100;
  ws.graph.facts[0].time_ranges=[{start_time:100,end_time:108}];for(const state of ws.graph.emotion_states){state.start_time+=100;state.end_time+=100;}
  assert.doesNotThrow(()=>assertTemporalOrder(ws));ws.graph.facts[0].time_ranges[0].end_time=106;
  assert.throws(()=>assertTemporalOrder(ws),/107s.*106s/);
  ws.graph.facts[0].timeline_id='other';assert.throws(()=>assertTemporalOrder(ws),/不在同一时间轴/);
});

test('transition content references and state movement use the same end bound',()=>{
  const ws=fixture();ws.graph.links.push({id:'R007',from_type:'emotion_state',from_id:'S001',to_type:'emotion_state',to_id:'S002',type:'transitions_to',content_refs:[{node_type:'evidence',node_id:evidenceKey('v','W003'),relation:'associated_with',note:''}]});
  assert.doesNotThrow(()=>assertTemporalOrder(ws));ws.graph.emotion_states[1].end_time=9.5;
  assert.throws(()=>assertTemporalOrder(ws),/W003.*S002/);ws.graph.emotion_states[0].end_time=12;
  assert.ok(temporalOrderIssues(ws).some(issue=>issue.from_id==='S001'&&issue.to_id==='S002'));
});

test('rejected fact and emotion drag plans make no partial writes',()=>{
  for(const plan of [
    {evidence_updates:[],fact_updates:[{id:'F001',timeline_id:'scene',time_ranges:[{start_time:2,end_time:6}]}],state_updates:[]},
    {evidence_updates:[],fact_updates:[],state_updates:[{id:'S001',start_time:4,end_time:7}]},
    {evidence_updates:[{item_id:'v',segment_id:'W001',start_time:1,end_time:2}],fact_updates:[],state_updates:[{id:'S001',start_time:4,end_time:7}]}
    ,{evidence_updates:[{item_id:'v',segment_id:'W001',start_time:1,end_time:2},{item_id:'v',segment_id:'W001',start_time:1,end_time:12}],fact_updates:[],state_updates:[]}
  ]){const ws=fixture(),before=structuredClone(ws);assert.throws(()=>applyAnnotationTimePlan(ws,plan),error=>error.code==='TEMPORAL_ORDER');assert.deepEqual(ws,before);}
});

test('evidence edits validate derived downstream nodes without mutating source records',()=>{
  const ws=fixture(),before=structuredClone(ws);assert.throws(()=>assertEvidenceTimeChange(ws,'v',{...ws.records.v.segments[0],end_time:12}),/W001.*F001/);assert.deepEqual(ws,before);
  delete ws.graph.facts[0].time_ranges;assert.throws(()=>assertEvidenceTimeChange(ws,'v',{...ws.records.v.segments[0],end_time:12}),/S001/);assert.deepEqual(ws.records,before.records);
});

test('project, per-video and batch exports refuse a temporal conflict',()=>{
  const ws=fixture();assert.doesNotThrow(()=>makeItemExport(ws,'v'));ws.graph.emotion_states[0].end_time=7;
  for(const exportFn of [()=>makeExport(ws),()=>makeItemExport(ws,'v'),()=>makeItemExportFiles(ws)])assert.throws(exportFn,error=>error.code==='TEMPORAL_ORDER');
});

test('per-video export checks its own graph while batch export checks all videos',()=>{
  const ws=fixture();ws.manifest.items.push({id:'other',media_path:'other.mp4',media_type:'video',timeline_id:'other',duration_s:30});ws.records.other={segments:[],status:'draft'};
  ws.graph.emotion_states[0].end_time=7;assert.doesNotThrow(()=>makeItemExport(ws,'other'));assert.throws(()=>makeItemExportFiles(ws),/S001/);
});
