import { newWorkspace, parseManifest, makeExport } from '../core.mjs';
import { evidenceKey } from '../graph.mjs';
export function materialResult(id,tag=id){
  const ws=newWorkspace(parseManifest({batch_id:'pair',assignment_id:'task',annotator_id:'ann',items:[{id,media_path:`${id}.mp4`,title:`${tag} video`,duration_s:12.032,timeline_id:'shared_scene'}]}));
  ws.records[id].segments=[{id:'W001',start_time:1,end_time:3,label:'visual_observation',annotations:{observation:`${tag} evidence`,subject_ids:['P001'],fact_id:'F001',fact_seeded:true}}];
  ws.graph.entities=[{id:'P001',name:`${tag} person`,aliases:[]}];ws.graph.mentions=[{id:'M001',entity_id:'P001',evidence_id:evidenceKey(id,'W001'),description:'Visible person'}];
  ws.graph.facts=[{id:'F001',text:`${tag} fact`,subject_ids:['P001'],kind:'observation',speaker_id:''}];
  ws.graph.events=[{id:'E001',title:`${tag} event`,subject_ids:['P001'],timeline_id:'shared_scene'}];
  ws.graph.emotion_states=[{id:'S001',subject_id:'P001',label:`${tag} emotion`,timeline_id:'shared_scene',start_time:2,end_time:4}];
  ws.graph.links=[{id:'R001',from_type:'evidence',from_id:evidenceKey(id,'W001'),to_type:'fact',to_id:'F001',type:'supports'},{id:'R002',from_type:'fact',from_id:'F001',to_type:'event',to_id:'E001',type:'constitutes'},{id:'R003',from_type:'event',from_id:'E001',to_type:'emotion_state',to_id:'S001',type:'associated_with'}];
  return makeExport(ws);
}
