import { blankGraph, evidenceKey, normalizeGraph, invalidateEvidence, invalidateFactDependents } from './graph.mjs';
import { createSubjectResolver } from './subject-lineage.mjs';

const sameIDs = (left = [], right = []) => { const sorted = [...right].sort(); return left.length === right.length && [...left].sort().every((id, index) => id === sorted[index]); };
function source(ws, itemID, segmentID) {
  const record = ws.records?.[itemID], segment = record?.segments.find(entry => entry.id === segmentID);
  if (!segment || !ws.manifest?.items.some(item => item.id === itemID)) throw new Error('请选择有效的证据时间窗');
  return { record, segment, evidenceID: evidenceKey(itemID, segmentID) };
}
function validateIDs(graph, ids, allowEmpty = false) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id))) throw new Error('请选择有效的证据主体');
  if (new Set(ids).size !== ids.length) throw new Error('证据主体 ID 重复');
  if (!allowEmpty && !ids.length) throw new Error('请至少选择一个主体');
  const entities = new Set(graph.entities.map(entry => entry.id));
  if (ids.some(id => !entities.has(id))) throw new Error('引用了不存在的主体');
  return [...ids];
}
function transaction(ws, action) {
  const draft = structuredClone(ws); if (!draft.graph) draft.graph = blankGraph();
  const before = JSON.stringify({ graph: ws.graph, records: ws.records, manifest: ws.manifest });
  const result = action(draft);
  draft.graph = normalizeGraph(draft.graph, draft);
  const modified = before !== JSON.stringify({ graph: draft.graph, records: draft.records, manifest: draft.manifest });
  if (modified) { ws.graph = draft.graph; ws.records = draft.records; ws.manifest = draft.manifest; }
  return { ...result, modified };
}
export function getEvidenceFact(ws, itemID, segmentID) {
  const { segment, evidenceID } = source(ws, itemID, segmentID), graph = ws.graph || blankGraph();
  if (segment.annotations?.fact_id) {
    const fact = graph.facts.find(fact => fact.id === segment.annotations.fact_id);
    if (!fact || !graph.links.some(link => link.from_type === 'evidence' && link.from_id === evidenceID && link.to_type === 'fact' && link.to_id === fact.id)) throw new Error('证据绑定的事实已失效，请重新导入有效结果');
    return fact;
  }
  const texts = new Set([segment.annotations?.observation, segment.annotations?.local_fact].filter(text => typeof text === 'string' && text.trim()).map(text => text.trim()));
  const candidates = graph.facts.filter(fact => texts.has(fact.text.trim()) && graph.links.some(link => link.from_type === 'evidence' && link.from_id === evidenceID && link.to_type === 'fact' && link.to_id === fact.id) && graph.links.filter(link => link.from_type === 'evidence' && link.to_type === 'fact' && link.to_id === fact.id).length === 1);
  return candidates.length === 1 ? candidates[0] : null;
}
function updateSubjects(draft, itemID, segmentID, ids) {
  const { record, segment, evidenceID } = source(draft, itemID, segmentID), graph = draft.graph;
  let chosen = validateIDs(graph, ids, true); const previous = Object.hasOwn(segment.annotations || {}, 'subject_ids') ? segment.annotations.subject_ids : null;
  const previousIDs = previous || [...new Set(graph.mentions.filter(mention => mention.evidence_id === evidenceID).map(mention => mention.entity_id))];
  const semanticChange = !sameIDs(previousIDs, chosen);
  if (previous && sameIDs(previous, chosen)) chosen = [...previous];
  const item = draft.manifest.items.find(item => item.id === itemID);
  item.subject_ids = [...new Set([...(item.subject_ids || []), ...chosen])];
  const previousRaw = segment.annotations.subject_id || '';
  const legacyClue = previousRaw && !graph.entities.some(entity => entity.id === previousRaw);
  const preserveLegacy = legacyClue && (previous === null || !semanticChange);
  segment.annotations.subject_ids = chosen;
  if (!preserveLegacy) segment.annotations.subject_id = chosen[0] || '';
  graph.mentions = graph.mentions.filter(mention => mention.evidence_id !== evidenceID || chosen.includes(mention.entity_id));
  for (const id of chosen) if (!graph.mentions.some(mention => mention.evidence_id === evidenceID && mention.entity_id === id)) {
    graph.mentions.push({ id: crypto.randomUUID(), entity_id: id, evidence_id: evidenceID, description: '证据标注主体：' + (preserveLegacy && previous === null && chosen.length === 1 ? previousRaw : id) });
  }
  if (semanticChange) { invalidateEvidence(draft, [evidenceID]); record.status = 'draft'; }
  return semanticChange;
}
export function setEvidenceSubjects(ws, itemID, segmentID, ids) {
  return transaction(ws, draft => { updateSubjects(draft, itemID, segmentID, ids); return {}; }).modified;
}
export function saveEvidenceFact(ws, itemID, segmentID, input) {
  const result = transaction(ws, draft => {
    const { record, segment, evidenceID } = source(draft, itemID, segmentID), graph = draft.graph;
    const existing = getEvidenceFact(draft, itemID, segmentID);
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 20000) throw new Error('请填写长度不超过 20000 的事实描述');
    const subjectIDs = validateIDs(graph, input.subject_ids);
    const evidenceSubjectIDs = validateIDs(graph, input.evidence_subject_ids ?? subjectIDs);
    const kind = input.kind ?? existing?.kind ?? 'observation';
    if (!['observation', 'reported_speech'].includes(kind)) throw new Error('事实类型无效');
    const speakerID = kind === 'reported_speech' ? input.speaker_id ?? existing?.speaker_id ?? '' : '';
    if (kind === 'reported_speech' && !graph.entities.some(entity => entity.id === speakerID)) throw new Error('人物陈述必须注明有效发言者');
    const review = input.review_status ?? existing?.review_status ?? 'needs_review';
    if (!['draft', 'confirmed', 'needs_review'].includes(review)) throw new Error('节点复核状态无效');
    const semanticChange = !existing || existing.text !== text || !sameIDs(existing.subject_ids, subjectIDs) || existing.kind !== kind || existing.speaker_id !== speakerID;
    updateSubjects(draft, itemID, segmentID, evidenceSubjectIDs);
    const supports = existing ? graph.links.filter(link => link.from_type === 'evidence' && link.to_type === 'fact' && link.to_id === existing.id).map(link => link.from_id) : [];
    const supportedIDs = new Set(createSubjectResolver(draft).fromEvidence([...new Set([...supports, evidenceID])]).map(candidate => candidate.id));
    if (subjectIDs.some(id => !supportedIDs.has(id))) throw new Error('事实描述的主体必须来自其支持证据中已选的主体');
    if (kind === 'reported_speech' && !supportedIDs.has(speakerID)) throw new Error('发言者必须在事实支持证据的已选主体中');
    const fact = { id: existing?.id || crypto.randomUUID(), text, subject_ids: existing && sameIDs(existing.subject_ids, subjectIDs) ? [...existing.subject_ids] : subjectIDs, kind, speaker_id: speakerID, review_status: review };
    if (existing) graph.facts[graph.facts.findIndex(entry => entry.id === existing.id)] = fact; else graph.facts.push(fact);
    if (!graph.links.some(link => link.from_type === 'evidence' && link.from_id === evidenceID && link.to_type === 'fact' && link.to_id === fact.id)) graph.links.push({ id: crypto.randomUUID(), from_type: 'evidence', from_id: evidenceID, to_type: 'fact', to_id: fact.id, type: 'supports' });
    segment.annotations.observation = text; segment.annotations.fact_id = fact.id;
    for (const item of draft.manifest.items) for (const bound of draft.records[item.id]?.segments || []) if (bound.annotations?.fact_id === fact.id && bound.annotations.observation !== text) {
      bound.annotations.observation = text; draft.records[item.id].status = 'draft';
    }
    if (semanticChange) { invalidateFactDependents(draft, fact.id); graph.status = 'draft'; record.status = 'draft'; }
    else if (existing.review_status !== review) graph.status = 'draft';
    return { factID: fact.id };
  });
  return { fact: ws.graph.facts.find(fact => fact.id === result.factID), modified: result.modified };
}
