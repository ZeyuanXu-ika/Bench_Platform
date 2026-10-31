import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkspace, parseManifest, parseResults, makeItemExport } from '../core.mjs';
import { pairMaterialResults, matchResultMaterial } from '../material-results.mjs';
import { materialGraph, materialWorkspace } from '../material-scope.mjs';
import { nextAnnotationId } from '../graph.mjs';
import { materialResult } from './material-fixture.mjs';
const queue=()=>newWorkspace(parseManifest({batch_id:'pair',assignment_id:'task',annotator_id:'ann',items:['zh01','zh02'].map(id=>({id:`${id}.mp4`,media_path:`${id}.mp4`,duration_s:12.032,timeline_id:'shared_scene'}))}));

test('automatic pairing resolves material number and unique filename, never current selection or time',()=>{
  const ws=queue();assert.equal(matchResultMaterial(ws.manifest.items,materialResult('zh02').items[0]).id,'zh02.mp4');
  assert.throws(()=>matchResultMaterial(ws.manifest.items,materialResult('zh02').items[0],'zh01.mp4'),/不能配对/);
  assert.throws(()=>matchResultMaterial(ws.manifest.items,materialResult('zh03').items[0]),/编号一致/);
  assert.throws(()=>matchResultMaterial([{id:'a',media_path:'x/zh01.mp4'},{id:'b',media_path:'y/zh01.mp4'}],materialResult('zh01').items[0]),/多个同名/);
  assert.throws(()=>matchResultMaterial([{id:'zh01',media_path:'zh02.mp4'}],materialResult('zh01').items[0]),/文件名不一致/);
  assert.equal(matchResultMaterial([{id:'a',media_path:'x/zh01.mp4'},{id:'b',media_path:'y/zh01.mp4'}],{id:'legacy',media_path:'x/zh01.mp4'}).id,'a');
  assert.throws(()=>matchResultMaterial(ws.manifest.items,{id:'zh02',media_path:'zh01.mp4'}),/编号与素材文件名不一致/);
});

test('two files with identical node IDs remain independent after pairing, editing and export',()=>{
  const original=queue(),before=structuredClone(original);
  const first=pairMaterialResults(original,parseResults(materialResult('zh01','A')),'zh01.json');assert.deepEqual(original,before);
  const firstExport=makeItemExport(first,'zh01.mp4');
  const both=pairMaterialResults(first,parseResults(materialResult('zh02','B')),'zh02.json');
  const afterExport=makeItemExport(both,'zh01.mp4');for(const key of ['items','graph','derived'])assert.deepEqual(afterExport[key],firstExport[key]);
  assert.equal(both.manifest.items.length,2);assert.equal(new Set(both.graph.facts.map(node=>node.id)).size,2);
  for(const [id,tag] of [['zh01.mp4','A'],['zh02.mp4','B']]){
    const local=materialWorkspace(both,id),out=makeItemExport(both,id);assert.equal(local.graph.facts.length,1);assert.equal(local.graph.facts[0].text,`${tag} fact`);assert.equal(local.graph.events[0].title,`${tag} event`);assert.equal(local.graph.emotion_states[0].label,`${tag} emotion`);assert.equal(local.graph.entities[0].name,`${tag} person`);
    assert.equal(out.items[0].annotation_source.file_name,id.replace('.mp4','.json'));assert.equal(out.items[0].segments[0].annotations.fact_id,out.graph.facts[0].id);assert.doesNotThrow(()=>parseResults(out));
  }
  const a=materialGraph(both,'zh01.mp4').facts[0];a.text='A edited';assert.equal(materialGraph(both,'zh02.mp4').facts[0].text,'B fact');
});

test('reimport replaces only its own annotations and keeps the other material byte-for-byte',()=>{
  let ws=pairMaterialResults(queue(),parseResults(materialResult('zh01','A')),'zh01.json');ws=pairMaterialResults(ws,parseResults(materialResult('zh02','B')),'zh02.json');
  const beforeRecord=structuredClone(ws.records['zh02.mp4']),beforeGraph=structuredClone(materialGraph(ws,'zh02.mp4'));
  const updated=pairMaterialResults(ws,parseResults(materialResult('zh01','A2')),'zh01_v2.json','zh01.mp4');
  assert.deepEqual(updated.records['zh02.mp4'],beforeRecord);assert.deepEqual(materialGraph(updated,'zh02.mp4'),beforeGraph);assert.equal(updated.graph.facts.length,2);assert.equal(materialGraph(updated,'zh01.mp4').facts[0].text,'A2 fact');assert.equal(updated.id,ws.id);
});

test('failed explicit pairing is atomic and cannot attach a result to the wrong file',()=>{
  const ws=queue(),before=structuredClone(ws);assert.throws(()=>pairMaterialResults(ws,parseResults(materialResult('zh02')),'zh02.json','zh01.mp4'),/不能配对/);assert.deepEqual(ws,before);
  const wrongOwner=materialResult('zh01');wrongOwner.graph.facts[0].item_id='zh02';assert.throws(()=>pairMaterialResults(ws,parseResults(wrongOwner),'zh01.json'),/其他素材编号/);assert.deepEqual(ws,before);
});

test('same timeline and overlapping state ranges never grant another file ownership',()=>{
  const ws=queue();const imported=parseResults(materialResult('zh01','A'));ws.graph=imported.graph;ws.records['zh01.mp4']=imported.records.zh01;
  for(const link of ws.graph.links)if(link.from_type==='evidence')link.from_id=JSON.stringify(['zh01.mp4','W001']);for(const mention of ws.graph.mentions)mention.evidence_id=JSON.stringify(['zh01.mp4','W001']);
  assert.equal(materialGraph(ws,'zh01.mp4').emotion_states.length,1);assert.equal(materialGraph(ws,'zh02.mp4').emotion_states.length,0);assert.equal(materialGraph(ws,'zh02.mp4').facts.length,0);
});

test('disconnected drafts and newly named subjects belong only to their explicitly owning material',()=>{
  const ws=queue();ws.graph.entities.push({id:'P001',name:'New subject',aliases:[],item_id:'zh02.mp4'});ws.graph.facts.push({id:'F001',text:'Draft',subject_ids:['P001'],item_id:'zh02.mp4'});ws.graph.emotion_states.push({id:'S001',subject_id:'P001',label:'Draft emotion',timeline_id:'shared_scene',start_time:1,end_time:2,item_id:'zh02.mp4'});
  assert.equal(materialGraph(ws,'zh01.mp4').entities.length,0);assert.equal(materialGraph(ws,'zh01.mp4').emotion_states.length,0);assert.equal(materialGraph(ws,'zh02.mp4').facts.length,1);
});

test('pairing remaps evidence speakers and preserves imported ID counters and source metadata',()=>{
  const first=pairMaterialResults(queue(),parseResults(materialResult('zh01','A')),'zh01.json');
  const raw=materialResult('zh02','B');raw.id_counters.S=100;raw.graph.facts[0].kind='reported_speech';raw.graph.facts[0].speaker_id='P001';raw.items[0].segments[0].annotations.speaker_id='P001';raw.items[0].segments[0].annotations.observation_kind='reported_speech';
  const both=pairMaterialResults(first,parseResults(raw),'zh02.json'),local=materialGraph(both,'zh02.mp4');
  assert.equal(both.records['zh02.mp4'].segments[0].annotations.speaker_id,local.facts[0].speaker_id);assert.notEqual(local.facts[0].speaker_id,materialGraph(both,'zh01.mp4').facts[0].speaker_id);assert.equal(nextAnnotationId(both,'emotion_state'),'S102');
  const reopened=parseResults(makeItemExport(both,'zh02.mp4'));assert.equal(reopened.records['zh02.mp4'].annotation_source.annotation_id,'zh02');
  const inconsistent=materialResult('zh01');inconsistent.export_scope='item';inconsistent.source_item_id='zh02';assert.throws(()=>parseResults(inconsistent),/source_item_id/);
});
