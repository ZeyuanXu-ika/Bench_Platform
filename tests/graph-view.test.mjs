import test from 'node:test';
import assert from 'node:assert/strict';
import { graphViewLinks, projectGraphView, serializeFullGraphSVG } from '../graph-view.mjs';
import { FACT_COLORS, LAYER_COLORS } from '../graph-view.mjs';

function fixture(count = 201) {
  const evidence = Array.from({ length: count }, (_, n) => ({ type: 'evidence', entry: { id: `w${n}`, global_start_time: n, global_end_time: n + 1 } }));
  const facts = Array.from({ length: count }, (_, n) => ({ type: 'fact', entry: { id: `f${n}`, text: `Fact ${n}`, review_status: 'confirmed' } }));
  const events = [{ type: 'event', entry: { id: 'e1', review_status: 'confirmed' } }];
  const links = evidence.flatMap((node, n) => [
    { id: `supports_${n}`, from_type: 'evidence', from_id: node.entry.id, to_type: 'fact', to_id: facts[n].entry.id, type: 'supports' },
    { id: `constitutes_${n}`, from_type: 'fact', from_id: facts[n].entry.id, to_type: 'event', to_id: 'e1', type: 'constitutes' }
  ]);
  return { data: [['证据', evidence], ['事实', facts], ['事件', events], ['情感', []]], links };
}

test('graph pages reach the final records and keep small-layer context visible', () => {
  const { data, links } = fixture();
  const first = projectGraphView(data, links), last = projectGraphView(data, links, null, { page: 99 });
  assert.equal(first.pageCount, 5); assert.equal(first.data[0][1].length, 50);
  assert.equal(last.page, 4); assert.equal(last.data[1][1][0].entry.id, 'f200');
  assert.equal(last.data[2][1][0].entry.id, 'e1');
  assert.ok(last.links.some(edge => edge.from_id === 'f200' && edge.to_id === 'e1'));
  assert.equal(data[0][1].length, 201);
});

test('focusing a late node includes its actual ancestors and descendants instead of the first fifty', () => {
  const { data, links } = fixture();
  const focused = projectGraphView(data, links, { type: 'fact', id: 'f200' });
  assert.equal(focused.mode, 'focus'); assert.equal(focused.scopeTotal, 3);
  assert.deepEqual(focused.data[0][1].map(node => node.entry.id), ['w200']);
  assert.deepEqual(focused.data[1][1].map(node => node.entry.id), ['f200']);
  assert.equal(focused.links.length, 2);
});

test('a high-fanout focus remains pinned on every page and does not erase its shared context', () => {
  const { data, links } = fixture();
  for (const page of [0, 1, 4]) {
    const view = projectGraphView(data, links, { type: 'event', id: 'e1' }, { page });
    assert.equal(view.data[2][1][0].entry.id, 'e1'); assert.ok(view.shown > 1);
  }
  assert.equal(projectGraphView(data, links, { type: 'fact', id: 'deleted' }).mode, 'all');
});

test('full SVG contains every record and edge, escapes text and declares its complete scope', () => {
  const { data, links } = fixture();
  const svg = serializeFullGraphSVG(data, links, { labelFor: (_type, id) => `<script>${id} & "text"</script>` });
  assert.ok(svg.includes('data-export-scope="full"'));
  assert.ok(svg.includes('data-node-id="f200"')); assert.ok(svg.includes('data-node-id="w200"'));
  assert.equal((svg.match(/data-node-id=/g) || []).length, 403);
  assert.equal((svg.match(/data-edge-id=/g) || []).length, 402);
  assert.ok(svg.includes('&lt;script&gt;')); assert.ok(!svg.includes('<script>'));
});

test('virtual emotion sequence links are included without changing stored graph relations', () => {
  const graph = { links: [], emotion_transitions: [{ id: 't', from_state_id: 's1', to_state_id: 's2' }] };
  const edges = graphViewLinks(graph);
  assert.equal(edges.length, 2); assert.equal(graph.links.length, 0);
  const svg = serializeFullGraphSVG([['证据', []], ['事实', []], ['事件', []], ['情感', []]], edges);
  assert.ok(svg.includes('height="260"')); assert.equal((svg.match(/data-edge-id=/g) || []).length, 0);
});
import { fourLayerTimeline, serializeTimelineSVG, annotationNodePresentation } from '../graph-view.mjs';
import { blankGraph, evidenceKey } from '../graph.mjs';

function timelineFixture() {
  const graph=blankGraph(), ws={manifest:{items:[{id:'clip',title:'private-media-name',timeline_id:'scene',duration_s:1200,time_offset_s:100}]},records:{clip:{segments:[{id:'W001',start_time:10,end_time:20,label:'visual_observation',annotations:{subject_ids:['P001'],observation:'Visible action'}},{id:'W002',start_time:80,end_time:90,label:'speech_content',annotations:{subject_ids:['P001'],observation:'Spoken reply'}}]}},graph};
  graph.entities.push({id:'P001',name:'Alice'});
  graph.facts.push({id:'F001',text:'Observed action',subject_ids:['P001'],kind:'observation'},{id:'F002',text:'Unresolved draft',subject_ids:[]});
  graph.events.push({id:'E001',title:'Composite event',subject_ids:['P001']});
  graph.emotion_states.push({id:'S001',subject_id:'P001',label:'Relieved',timeline_id:'scene',start_time:190,end_time:210},{id:'S002',subject_id:'P001',label:'Unrelated',timeline_id:'scene',start_time:300,end_time:320});
  graph.links.push(...['W001','W002'].map((id,i)=>({id:`R00${i+1}`,from_type:'evidence',from_id:evidenceKey('clip',id),to_type:'fact',to_id:'F001',type:'supports'})),{id:'R003',from_type:'fact',from_id:'F001',to_type:'event',to_id:'E001',type:'constitutes'},{id:'R004',from_type:'event',from_id:'E001',to_type:'emotion_state',to_id:'S001',type:'causes',note:'Observed reaction'});
  return ws;
}

test('four-layer graph keeps true source offsets and disjoint event intervals without inventing draft times',()=>{
  const ws=timelineFixture(),before=structuredClone(ws), model=fourLayerTimeline(ws);
  assert.equal(model.tracks.length,4);assert.equal(model.high,1300);assert.ok(fourLayerTimeline(ws,{range:'annotations'}).high<400);assert.equal(model.unresolved,1);
  assert.deepEqual(model.nodes.find(n=>n.type==='event').ranges,[{start_time:110,end_time:120},{start_time:180,end_time:190}]);
  assert.equal(model.nodes.some(n=>n.id==='F002'),false);assert.deepEqual(ws,before);
  assert.ok(model.height<600,'small annotation graph uses a compact canvas');
  for(const type of ['evidence','fact','event','emotion_state']) assert.equal(new Set(model.nodes.filter(n=>n.type===type).map(n=>n.y)).size>=1,true,'nodes stay in their layer');
});

test('emotion focus highlights every ancestor layer while keeping unrelated nodes and stable positions',()=>{
  const ws=timelineFixture(),all=fourLayerTimeline(ws),focused=fourLayerTimeline(ws,{focus:{type:'emotion_state',id:'S001'}});
  assert.deepEqual(focused.nodes.map(n=>[n.id,n.x,n.y]),all.nodes.map(n=>[n.id,n.x,n.y]));
  assert.ok(focused.nodes.filter(n=>n.id!=='S002').every(n=>n.related));assert.equal(focused.nodes.find(n=>n.id==='S002').related,false);assert.equal(focused.relatedEdges.size,4);
  assert.deepEqual(focused.upstream.map(n=>n.id),['W001','W002','F001','E001']);
  assert.deepEqual(fourLayerTimeline(ws,{focus:{type:'event',id:'E001'}}).upstream.map(n=>n.id),['W001','W002','F001'],'upstream summary excludes downstream emotion states');
});

test('structured evidence labels omit media names and SVG exports escaped annotation text',()=>{
  const ws=timelineFixture(),model=fourLayerTimeline(ws),evidence=model.nodes.find(n=>n.type==='evidence'),display=annotationNodePresentation(ws,'evidence',evidence.entry);
  assert.equal(display.heading,'W001_Alice');assert.equal(display.cardHeading,'W001_110s–120s');assert.equal(display.tag,'视觉观察');
  ws.graph.emotion_states[0].label='<script>alert(1)</script>';
  const svg=serializeTimelineSVG(fourLayerTimeline(ws));assert.ok(!svg.includes('private-media-name'));assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));assert.equal((svg.match(/data-timeline-layer=/g)||[]).length,4);
});

test('graph separates independent source axes and switches to the focused node source',()=>{
  const ws=timelineFixture();ws.manifest.items.push({id:'other',timeline_id:'other',duration_s:900});ws.graph.emotion_states.push({id:'S003',subject_id:'P001',label:'Other source',timeline_id:'other',start_time:400,end_time:410});
  const model=fourLayerTimeline(ws,{timeline:'scene',focus:{type:'emotion_state',id:'S003'}});assert.equal(model.timeline,'other');assert.equal(model.nodes.length,1);assert.equal(model.nodes[0].id,'S003');
});

test('selection preserves the full time range and fixed four-track height with overlapping nodes',()=>{
  const ws=timelineFixture();for(let i=0;i<100;i++)ws.graph.emotion_states.push({...ws.graph.emotion_states[0],id:`S${i+100}`});
  const full=fourLayerTimeline(ws),focused=fourLayerTimeline(ws,{focus:{type:'emotion_state',id:'S001'}});
  assert.equal(full.height,focused.height);assert.ok(full.height<600);assert.equal(focused.high,full.high);assert.equal(focused.low,full.low);assert.equal(new Set(focused.nodes.filter(n=>n.type==='emotion_state').map(n=>n.y)).size,1);
  assert.ok(focused.nodes.filter(n=>n.type==='emotion_state').every(n=>Math.abs(n.y-full.tracks.find(t=>t.type==='emotion_state').top-70)<=26));
});

test('state selection ignores emotion change propagation; selecting its edge highlights only its state endpoints',()=>{
  const ws=timelineFixture();ws.graph.links.push({id:'change',from_type:'emotion_state',from_id:'S001',to_type:'emotion_state',to_id:'S002',type:'transitions_to'});
  const state=fourLayerTimeline(ws,{focus:{type:'emotion_state',id:'S001'}});assert.equal(state.nodes.find(n=>n.id==='S002').related,false);
  const edge=fourLayerTimeline(ws,{focus:{type:'link',id:'change'}});assert.deepEqual(edge.nodes.filter(n=>n.related).map(n=>n.id),['S001','S002']);assert.deepEqual(edge.upstream,[]);assert.equal(edge.low,state.low);assert.equal(edge.high,state.high);
  assert.ok(serializeTimelineSVG(edge).includes('data-edge-hit="change"'));
});

test('cross-layer mapping lines remain visible and follow node focus while only state changes are selectable',()=>{
  const ws=timelineFixture();ws.graph.links.push({id:'change',from_type:'emotion_state',from_id:'S001',to_type:'emotion_state',to_id:'S002',type:'transitions_to'});
  const path=(svg,id)=>svg.match(new RegExp(`<path data-edge-id="${id}"[^>]+>`))?.[0];
  const full=serializeTimelineSVG(fourLayerTimeline(ws));
  for(const id of ['R001','R002','R003','R004']){assert.match(path(full,id),/opacity="0.7"/);assert.ok(!path(full,id).includes('role="button"'));assert.ok(!full.includes(`data-edge-hit="${id}"`));}
  const node=serializeTimelineSVG(fourLayerTimeline(ws,{focus:{type:'emotion_state',id:'S001'}}));
  for(const id of ['R001','R002','R003','R004'])assert.match(path(node,id),/opacity="0.95"/);
  const edge=serializeTimelineSVG(fourLayerTimeline(ws,{focus:{type:'link',id:'change'}}));
  assert.match(path(edge,'change'),/aria-pressed="true"/);for(const id of ['R001','R002','R003','R004'])assert.equal(path(edge,id),path(full,id),'selecting a state change leaves cross-layer mappings unchanged');
});

test('fact types have distinct colors and selected state changes display both endpoint labels with layer-colored arrows',()=>{
  const ws=timelineFixture();ws.graph.facts.push({id:'F003',text:'A spoken claim',kind:'reported_speech',subject_ids:['P001']});ws.graph.links.push({id:'change',from_type:'emotion_state',from_id:'S001',to_type:'emotion_state',to_id:'S002',type:'transitions_to'});
  assert.notEqual(FACT_COLORS.observation,FACT_COLORS.reported_speech);
  assert.equal(annotationNodePresentation(ws,'fact',ws.graph.facts[0]).color,FACT_COLORS.observation);assert.equal(annotationNodePresentation(ws,'fact',ws.graph.facts.at(-1)).color,FACT_COLORS.reported_speech);
  const svg=serializeTimelineSVG(fourLayerTimeline(ws,{focus:{type:'link',id:'change'}}));assert.equal((svg.match(/data-state-label="content"/g)||[]).length,2);assert.ok(svg.includes(`stop-color="${LAYER_COLORS.event}"`));assert.ok(svg.includes(`stop-color="${LAYER_COLORS.emotion_state}"`));
  assert.match(svg.match(/<path data-edge-id="change"[^>]+>/)[0],new RegExp(`stroke="${LAYER_COLORS.emotion_state}"`));
});

test('local timeline span and panning clamp to full bounds without changing node selection or annotations',()=>{
  const ws=timelineFixture(),before=structuredClone(ws),focus={type:'emotion_state',id:'S001'};
  const local=fourLayerTimeline(ws,{range:'local',windowStart:100,windowSpan:30,focus});assert.equal(local.low,100);assert.equal(local.high,130);assert.equal(local.fullHigh,1300);
  const end=fourLayerTimeline(ws,{range:'local',windowStart:9999,windowSpan:30,focus});assert.equal(end.low,1270);assert.equal(end.high,1300);
  const start=fourLayerTimeline(ws,{range:'local',windowStart:-9999,windowSpan:30,focus});assert.equal(start.low,0);assert.equal(start.high,30);assert.deepEqual(ws,before);
});
