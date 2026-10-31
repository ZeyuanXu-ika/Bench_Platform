import { blankGraph, evidenceKey } from './graph.mjs';

// Material identity, never timeline identity or overlapping timestamps, owns annotations.
export function materialGraph(ws, itemID) {
  const graph=ws.graph||blankGraph(),items=ws.manifest.items,owners=new Map();
  const key=(type,id)=>JSON.stringify([type,id]);
  const incoming=new Map();for(const link of graph.links){const target=key(link.to_type,link.to_id);if(!incoming.has(target))incoming.set(target,[]);incoming.get(target).push(link);}
  for(const item of items)for(const segment of ws.records[item.id]?.segments||[])owners.set(key('evidence',evidenceKey(item.id,segment.id)),item.id);
  const assign=(type,entries,parents)=>{
    for(const entry of entries){
      let owner=entry.item_id;
      if(!owner){const sources=(incoming.get(key(type,entry.id))||[]).filter(link=>parents.includes(link.from_type)).map(link=>owners.get(key(link.from_type,link.from_id))).filter(Boolean);owner=sources[0];}
      if(!owner&&items.length===1)owner=items[0].id;
      if(!owner&&entry.timeline_id){const candidates=items.filter(item=>(item.timeline_id||item.source_id||item.id)===entry.timeline_id);if(candidates.length===1)owner=candidates[0].id;}
      if(owner)owners.set(key(type,entry.id),owner);
    }
  };
  assign('fact',graph.facts,['evidence']);assign('event',graph.events,['fact']);assign('emotion_state',graph.emotion_states,['fact','event']);
  for(const transition of graph.emotion_transitions){const owner=transition.item_id||owners.get(key('emotion_state',transition.from_state_id));if(owner)owners.set(key('emotion_transition',transition.id),owner);}
  const owns=(type,id)=>owners.get(key(type,id))===itemID;
  const local={...graph,facts:graph.facts.filter(node=>owns('fact',node.id)),events:graph.events.filter(node=>owns('event',node.id)),emotion_states:graph.emotion_states.filter(node=>owns('emotion_state',node.id)),emotion_transitions:graph.emotion_transitions.filter(node=>owns('emotion_transition',node.id)&&owns('emotion_state',node.to_state_id)),mentions:graph.mentions.filter(node=>owns('evidence',node.evidence_id))};
  local.links=graph.links.filter(link=>owns(link.from_type,link.from_id)&&owns(link.to_type,link.to_id));
  const entityIDs=new Set([...local.mentions.map(node=>node.entity_id),...local.facts.flatMap(node=>[...node.subject_ids,node.speaker_id]),...local.events.flatMap(node=>node.subject_ids),...local.emotion_states.map(node=>node.subject_id),...(items.find(item=>item.id===itemID)?.subject_ids||[])]);
  for(const segment of ws.records[itemID]?.segments||[])for(const id of segment.annotations?.subject_ids||[])entityIDs.add(id);
  local.entities=graph.entities.filter(node=>node.item_id===itemID||entityIDs.has(node.id)||(!node.item_id&&items.length===1));
  return local;
}

export function materialWorkspace(ws,itemID=ws.manifest.items[ws.index||0]?.id){
  const item=ws.manifest.items.find(item=>item.id===itemID);if(!item)throw new Error('请选择有效素材');
  const graph=materialGraph(ws,itemID),facts=new Set(graph.facts.map(node=>node.id)),record=ws.records[itemID];
  const allowed={evidence:new Set(record.segments.map(segment=>evidenceKey(itemID,segment.id))),fact:new Set(graph.facts.map(node=>node.id)),event:new Set(graph.events.map(node=>node.id)),emotion_state:new Set(graph.emotion_states.map(node=>node.id))};
  graph.links=graph.links.map(link=>link.content_refs?{...link,content_refs:link.content_refs.filter(ref=>allowed[ref.node_type]?.has(ref.node_id))}:link);
  const segments=record.segments.map(segment=>segment.annotations?.fact_id&&!facts.has(segment.annotations.fact_id)?{...segment,annotations:{...segment.annotations,fact_id:undefined}}:segment);
  return {...ws,index:0,manifest:{...ws.manifest,items:[item]},records:{[itemID]:{...record,segments}},graph};
}
