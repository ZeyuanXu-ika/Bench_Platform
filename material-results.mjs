import { evidenceKey, nextAnnotationId, annotationIdCounters, normalizeGraph, assertTemporalOrder } from './graph.mjs';
import { materialGraph, materialWorkspace } from './material-scope.mjs';

const collections={entities:'entity',mentions:'mention',facts:'fact',events:'event',emotion_states:'emotion_state',emotion_transitions:'emotion_transition',links:'link'};
const name=value=>String(value||'').replaceAll('\\','/').split('/').pop().toLocaleLowerCase().replace(/\.(mp4|webm|mov|m4v|wav|mp3|m4a|aac|ogg|flac|json)$/,'');
const pathName=value=>String(value||'').replaceAll('\\','/').toLocaleLowerCase();
export function matchResultMaterial(items, incoming, expectedID) {
  let matches=items.filter(item=>item.id===incoming.id);
  if(matches.length&&name(matches[0].media_path)!==name(incoming.media_path))throw new Error(`素材编号 ${incoming.id} 相同，但文件名不一致，不能配对`);
  if(!matches.length){matches=items.filter(item=>name(item.id)===name(incoming.id));if(matches.some(item=>name(item.media_path)!==name(incoming.media_path)))throw new Error(`标注 ${incoming.id} 的编号与素材文件名不一致，不能配对`);}
  if(!matches.length)matches=items.filter(item=>pathName(item.media_path)===pathName(incoming.media_path));
  if(!matches.length)matches=items.filter(item=>name(item.media_path)===name(incoming.media_path));
  if(matches.length!==1)throw new Error(matches.length?`标注 ${incoming.id} 匹配到多个同名素材，请明确素材编号`:`没有与标注 ${incoming.id} 对应的素材，请先导入编号一致的音视频`);
  if(expectedID&&matches[0].id!==expectedID)throw new Error(`标注属于 ${matches[0].id}，不能配对到 ${expectedID}`);
  return matches[0];
}

// All work is done on a copy. A mismatch never changes the queue or any annotation.
export function pairMaterialResults(ws, incoming, fileName, expectedID) {
  if(expectedID&&incoming.manifest.items.length!==1)throw new Error('单条素材配对请选择只包含该素材的标注 JSON');
  const targets=incoming.manifest.items.map(item=>({source:item,target:matchResultMaterial(ws.manifest.items,item,expectedID)}));
  if(new Set(targets.map(pair=>pair.target.id)).size!==targets.length)throw new Error('多条标注匹配到同一素材，已取消导入');
  const scopes=targets.map(({source})=>materialGraph(incoming,source.id));
  for(const key of ['facts','events','emotion_states','emotion_transitions']){const covered=new Set(scopes.flatMap(graph=>graph[key].map(node=>node.id)));if(incoming.graph[key].some(node=>!covered.has(node.id)))throw new Error('标注节点声明了其他素材编号或无法确定归属，请选择该素材的独立标注 JSON');}
  const draft=structuredClone(ws),oldID=draft.id;draft.graph.status='draft';
  for(const key of ['batch_id','assignment_id','annotator_id'])if(!draft.manifest[key])draft.manifest[key]=incoming.manifest[key];
  const counters={...annotationIdCounters(draft)};for(const [key,value] of Object.entries(annotationIdCounters(incoming)))counters[key]=Math.max(counters[key]||0,value);draft.id_counters=counters;
  for(const {source,target} of targets){
    const itemID=target.id,local=materialWorkspace(incoming,source.id),owned=materialGraph(draft,itemID);
    const removed=new Set(Object.entries(collections).filter(([key])=>key!=='entities').flatMap(([key])=>owned[key].map(node=>node.id)));
    for(const key of Object.keys(collections))if(key!=='entities'&&key!=='links')draft.graph[key]=draft.graph[key].filter(node=>!removed.has(node.id));
    draft.graph.links=draft.graph.links.filter(link=>!removed.has(link.id)&&!removed.has(link.from_id)&&!removed.has(link.to_id)&&!(link.from_type==='evidence'&&JSON.parse(link.from_id)[0]===itemID));
    const usedEntities=new Set([...draft.graph.facts.flatMap(node=>[...node.subject_ids,node.speaker_id]),...draft.graph.events.flatMap(node=>node.subject_ids),...draft.graph.emotion_states.map(node=>node.subject_id),...draft.graph.mentions.map(node=>node.entity_id)]);
    for(const item of draft.manifest.items)if(item.id!==itemID){for(const id of item.subject_ids||[])usedEntities.add(id);for(const segment of draft.records[item.id]?.segments||[])for(const id of segment.annotations?.subject_ids||[])usedEntities.add(id);}
    const localEntities=new Set(owned.entities.map(node=>node.id));draft.graph.entities=draft.graph.entities.filter(node=>!localEntities.has(node.id)||usedEntities.has(node.id));
    const occupied=new Set(Object.keys(collections).flatMap(key=>draft.graph[key].map(node=>node.id))),ids=new Map();
    for(const [key,type] of Object.entries(collections))for(const node of local.graph[key]){const id=occupied.has(node.id)?nextAnnotationId(draft,type,occupied):node.id;occupied.add(id);ids.set(node.id,id);}
    const remap=id=>ids.get(id)||id;
    const evidence=id=>{const [material,segment]=JSON.parse(id);if(material!==source.id)throw new Error('标注包含其他素材的证据，不能交叉配对');return evidenceKey(itemID,segment);};
    const nodes=new Map();
    for(const [key] of Object.entries(collections))nodes.set(key,local.graph[key].map(original=>{
      const node=structuredClone(original);node.id=remap(node.id);
      if(key==='entities'||['facts','events','emotion_states','emotion_transitions'].includes(key))node.item_id=itemID;
      if(node.timeline_id)node.timeline_id=itemID;
      if(node.subject_ids)node.subject_ids=node.subject_ids.map(remap);
      for(const field of ['subject_id','speaker_id','entity_id','from_state_id','to_state_id'])if(node[field])node[field]=remap(node[field]);
      if(node.evidence_id)node.evidence_id=evidence(node.evidence_id);
      if(key==='links'){node.from_id=node.from_type==='evidence'?evidence(node.from_id):remap(node.from_id);node.to_id=remap(node.to_id);if(node.content_refs)node.content_refs=node.content_refs.map(ref=>({...ref,node_id:ref.node_type==='evidence'?evidence(ref.node_id):remap(ref.node_id)}));}
      return node;
    }));
    const record=structuredClone(local.records[source.id]),previous=draft.records[itemID];
    if(previous.media?.size&&record.media?.size&&previous.media.size!==record.media.size)throw new Error(`${itemID} 的素材文件大小与标注记录不一致，不能配对`);
    record.id=itemID;record.annotation_source={file_name:fileName,material_id:itemID,annotation_id:source.id};
    if(previous.media)record.media=previous.media;
    for(const segment of record.segments){const annotation=segment.annotations;if(annotation?.fact_id)annotation.fact_id=remap(annotation.fact_id);if(annotation?.subject_ids)annotation.subject_ids=annotation.subject_ids.map(remap);if(annotation?.subject_id)annotation.subject_id=remap(annotation.subject_id);if(annotation?.speaker_id)annotation.speaker_id=remap(annotation.speaker_id);}
    const updated={...target,...source,id:itemID,media_path:target.media_path,timeline_id:itemID,source_id:itemID};
    if(updated.subject_ids)updated.subject_ids=updated.subject_ids.map(remap);
    draft.manifest.items[draft.manifest.items.findIndex(item=>item.id===itemID)]=updated;draft.records[itemID]=record;
    for(const [key,entries] of nodes)draft.graph[key].push(...entries);
    draft.graph=normalizeGraph(draft.graph,draft);assertTemporalOrder(materialWorkspace(draft,itemID));
  }
  draft.id_counters=annotationIdCounters(draft);
  const targetIDs=new Set(targets.map(pair=>pair.target.id));
  draft.ui_form_drafts=(draft.ui_form_drafts||[]).filter(([key])=>!targetIDs.has(JSON.parse(key)[3])).map(([key,...rest])=>{const context=JSON.parse(key);if(context[0]===oldID)context[0]=draft.id;return [JSON.stringify(context),...rest];});
  draft.ui_temporal_conflicts=(draft.ui_temporal_conflicts||[]).filter(([,entry])=>!targetIDs.has(entry.itemID));draft.index=draft.manifest.items.findIndex(item=>item.id===targets[0].target.id);
  draft.revision=(draft.revision||0)+1;draft.exported_revision=-1;return draft;
}
