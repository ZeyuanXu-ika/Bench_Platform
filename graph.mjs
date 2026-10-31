// Pure graph data and validation. Media windows remain authoritative in ws.records.
export const MAX_GRAPH_NODES = 10000;
export const MAX_GRAPH_LINKS = 50000;
const COLLECTIONS = ['entities', 'mentions', 'facts', 'events', 'emotion_states', 'emotion_transitions'];
const TYPES = { entity: 'entities', mention: 'mentions', fact: 'facts', event: 'events', emotion_state: 'emotion_states', emotion_transition: 'emotion_transitions', link: 'links' };
const REVIEWS = new Set(['draft', 'confirmed', 'needs_review']);
const EDGE_TYPES = new Set(['evidence:fact:supports', 'fact:event:constitutes', 'fact:emotion_state:grounds', 'event:emotion_state:associated_with', 'event:emotion_state:causes', 'emotion_state:emotion_state:transitions_to', 'event:emotion_transition:associated_with', 'event:emotion_transition:causes']);
const ID_PREFIXES = { entity: 'P', mention: 'M', fact: 'F', event: 'E', emotion_state: 'S', emotion_transition: 'T', link: 'R', evidence: 'W' };
const allocatedIDs = new WeakMap();
export function annotationIdCounters(ws) {
  const counters = {}, stored = ws.id_counters || {}, pending = allocatedIDs.get(ws) || {};
  for (const prefix of Object.values(ID_PREFIXES)) {
    const value = stored[prefix] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('标注 ID 计数无效');
    counters[prefix] = Math.max(value, pending[prefix] || 0);
  }
  return counters;
}
export function nextAnnotationId(ws, type, reserved = new Set()) {
  const prefix = ID_PREFIXES[type]; if (!prefix) throw new Error('未知标注 ID 类型');
  const used = new Set(reserved);
  for (const entries of Object.values(ws.graph || {})) if (Array.isArray(entries)) for (const entry of entries) used.add(entry.id);
  for (const item of ws.manifest?.items || []) {
    used.add(item.id);
    for (const segment of ws.records?.[item.id]?.segments || []) used.add(segment.id);
  }
  const counters = annotationIdCounters(ws);
  for (const id of used) {
    const match = typeof id === 'string' && id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (match && Number.isSafeInteger(Number(match[1]))) counters[prefix] = Math.max(counters[prefix], Number(match[1]));
  }
  let id;
  do {
    if (counters[prefix] >= Number.MAX_SAFE_INTEGER - 1) throw new Error('标注 ID 编号已达上限');
    id = prefix + String(++counters[prefix]).padStart(3, '0');
  } while (used.has(id));
  allocatedIDs.set(ws, counters); return id;
}
const typed = (type, id) => `${type}\u0000${id}`;
const nodeType = collection => Object.keys(TYPES).find(type => TYPES[type] === collection);
const EMPTY = Object.freeze([]);
// Rebuilt per operation: no indexes survive edits or retain an older workspace.
function indexGraph(graph) {
  const incoming = new Map(), outgoing = new Map(), transitionsByState = new Map(), nodesByType = new Map();
  for (const collection of COLLECTIONS) nodesByType.set(nodeType(collection), new Map(graph[collection].map(node => [node.id, node])));
  for (const link of graph.links) {
    const target = typed(link.to_type, link.to_id), source = typed(link.from_type, link.from_id);
    if (!incoming.has(target)) incoming.set(target, { all: [], byType: new Map() });
    const bucket = incoming.get(target); bucket.all.push(link);
    if (!bucket.byType.has(link.from_type)) bucket.byType.set(link.from_type, []);
    bucket.byType.get(link.from_type).push(link);
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(link);
  }
  for (const transition of graph.emotion_transitions) for (const stateID of new Set([transition.from_state_id, transition.to_state_id])) {
    if (!transitionsByState.has(stateID)) transitionsByState.set(stateID, []);
    transitionsByState.get(stateID).push(transition);
  }
  return { incoming, outgoing, transitionsByState, nodesByType };
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value;
}
function string(value, name, max = 20000, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} 必须是长度不超过 ${max} 的文本`);
  return value;
}
function id(value, name, optional = false, max = 200) {
  const result = string(value, name, max).trim();
  if ((!optional && !result) || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${name} 无效`);
  return result;
}
function array(value, name, max = MAX_GRAPH_NODES) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} 必须是最多 ${max} 项的列表`);
  return value;
}
function number(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数字`);
  return value;
}
function review(value) {
  const result = value ?? 'draft';
  if (!REVIEWS.has(result)) throw new Error('节点复核状态无效');
  return result;
}
function subjects(value) { return [...new Set(array(value, '主体引用', 100).map(x => id(x, '主体 ID')))]; }
function keys(value) { return new Set(Array.isArray(value) ? value : value ? [value] : []); }
export function blankGraph() {
  return { status: 'draft', entities: [], mentions: [], facts: [], events: [], emotion_states: [], emotion_transitions: [], links: [] };
}
export function evidenceKey(itemId, segmentId) { return JSON.stringify([itemId, segmentId]); }
export function evidenceNodes(ws) {
  const nodes = [], seen = new Set();
  for (const item of ws?.manifest?.items || []) {
    const offset = number(item.time_offset_s ?? item.clip_start_s ?? 0, '素材时间偏移');
    for (const segment of ws?.records?.[item.id]?.segments || []) {
      const key = evidenceKey(item.id, segment.id);
      if (seen.has(key)) throw new Error('证据时间窗 ID 重复');
      if (key.length > 1024) throw new Error('证据时间窗引用过长');
      seen.add(key);
      nodes.push({ id: key, item_id: item.id, segment_id: segment.id, title: item.title || item.id,
        modality: segment.label, media_type: item.media_type, timeline_id: item.timeline_id || item.source_id || item.id,
        start_time: segment.start_time, end_time: segment.end_time, time_offset_s: offset,
        global_start_time: segment.start_time + offset, global_end_time: segment.end_time + offset });
      if (nodes.length > 50000) throw new Error('证据时间窗总数超过 50000，请拆分项目');
    }
  }
  return nodes;
}
function boundsFromIndex(index, refs) {
  if (!refs.length) return null;
  const nodes = refs.map(ref => {
    const node = index.get(ref);
    if (!node) throw new Error('引用了不存在的证据时间窗');
    return node;
  });
  const timelines = new Set(nodes.map(node => node.timeline_id));
  if (timelines.size !== 1) throw new Error('证据来自不同时间轴，请先确认素材同步与共同时间轴');
  return { timeline_id: nodes[0].timeline_id, start_time: Math.min(...nodes.map(n => n.global_start_time)), end_time: Math.max(...nodes.map(n => n.global_end_time)) };
}
export function evidenceBounds(ws, refs) { return boundsFromIndex(new Map(evidenceNodes(ws).map(node => [node.id, node])), [...keys(refs)]); }

function rangesFromIndex(index, refs) {
  const unique = [...keys(refs)], bounds = boundsFromIndex(index, unique);
  if (!bounds) return null;
  const windows = unique.map(ref => index.get(ref)).map(node => ({ start_time: node.global_start_time, end_time: node.global_end_time }))
    .sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time);
  const time_ranges = [];
  for (const window of windows) {
    const last = time_ranges.at(-1);
    if (last && window.start_time <= last.end_time) last.end_time = Math.max(last.end_time, window.end_time);
    else time_ranges.push({ ...window });
  }
  return { timeline_id: bounds.timeline_id, time_ranges };
}
// Union of actual evidence windows, never the envelope of each fact.
export function evidenceTimeRanges(ws, refs) {
  return rangesFromIndex(new Map(evidenceNodes(ws).map(node => [node.id, node])), refs);
}
export function factTimeRanges(ws, graph = ws.graph || blankGraph()) {
  const index = new Map(evidenceNodes(ws).map(node => [node.id, node])), supports = new Map();
  for (const link of graph.links) if (link.from_type === 'evidence' && link.to_type === 'fact' && link.type === 'supports') {
    if (!supports.has(link.to_id)) supports.set(link.to_id, []);
    supports.get(link.to_id).push(link.from_id);
  }
  return Object.fromEntries(graph.facts.map(fact => {
    try {
      if (fact.time_ranges?.length) return [fact.id, { status:'annotated', timeline_id:fact.timeline_id, time_ranges:structuredClone(fact.time_ranges) }];
      const ranges = rangesFromIndex(index, supports.get(fact.id) || []);
      if (!ranges) throw new Error('尚未关联支持证据');
      return [fact.id, { status: 'derived', ...ranges }];
    } catch (error) { return [fact.id, { status: 'unresolved', timeline_id: null, time_ranges: [], reason: error.message }]; }
  }));
}
export function eventTimeRanges(ws, graph = ws.graph || blankGraph()) {
  const factTimes=factTimeRanges(ws,graph);
  const constituents = new Map();
  for (const link of graph.links) {
    if (link.from_type === 'fact' && link.to_type === 'event' && link.type === 'constitutes') {
      if (!constituents.has(link.to_id)) constituents.set(link.to_id, []);
      constituents.get(link.to_id).push(link.from_id);
    }
  }
  return Object.fromEntries(graph.events.map(event => {
    try {
      const facts = constituents.get(event.id) || [];
      if (!facts.length || facts.some(id => !factTimes[id]?.time_ranges.length)) throw new Error('构成事实的时间尚未完整标注');
      const timeline_id=factTimes[facts[0]].timeline_id;
      if(facts.some(id=>factTimes[id].timeline_id!==timeline_id)) throw new Error('构成事实属于不同时间轴');
      const ranges=facts.flatMap(id=>factTimes[id].time_ranges).map(r=>({...r})).sort((a,b)=>a.start_time-b.start_time), time_ranges=[];
      for(const range of ranges){const last=time_ranges.at(-1);if(last && range.start_time<=last.end_time)last.end_time=Math.max(last.end_time,range.end_time);else time_ranges.push(range);}
      return [event.id, { status:'derived',timeline_id,time_ranges }];
    } catch (error) {
      return [event.id, { status: 'unresolved', timeline_id: null, time_ranges: [], reason: error.message }];
    }
  }));
}

// Compare every connected upstream end with its downstream end on aligned time.
// Drafts without a resolved window are handled by the separate completeness checks.
export function temporalOrderIssues(ws, graph = ws.graph || blankGraph()) {
  const facts = factTimeRanges(ws, graph), events = eventTimeRanges(ws, graph);
  const windows = new Map(), names = { evidence: '证据', fact: '事实', event: '复合事件', emotion_state: '情感状态' };
  const put = (type, id, timeline, ranges, label = id) => {
    if (!timeline || !ranges?.length || ranges.some(range => !Number.isFinite(range.end_time))) return;
    windows.set(typed(type, id), { timeline, end: Math.max(...ranges.map(range => range.end_time)), label: `${names[type]} ${label}` });
  };
  for (const evidence of evidenceNodes(ws)) put('evidence', evidence.id, evidence.timeline_id, [{ end_time: evidence.global_end_time }], evidence.segment_id);
  for (const [id, time] of Object.entries(facts)) put('fact', id, time.timeline_id, time.time_ranges);
  for (const [id, time] of Object.entries(events)) put('event', id, time.timeline_id, time.time_ranges);
  for (const state of graph.emotion_states) put('emotion_state', state.id, state.timeline_id, [state]);
  const issues = [], seen = new Set();
  const check = (fromType, fromID, toType, toID, linkID) => {
    const source = windows.get(typed(fromType, fromID)), target = windows.get(typed(toType, toID));
    if (!source || !target) return;
    const key = JSON.stringify([fromType, fromID, toType, toID, linkID]);
    if (seen.has(key)) return; seen.add(key);
    const mismatch = source.timeline !== target.timeline;
    if (!mismatch && source.end <= target.end + 1e-6) return;
    issues.push({ code: 'TEMPORAL_ORDER', severity: 'error', node_type: 'link', node_id: linkID,
      from_type: fromType, from_id: fromID, to_type: toType, to_id: toID, source_end: source.end, target_end: target.end,
      message: mismatch ? `${source.label}与${target.label}不在同一时间轴，无法建立时间关联`
        : `${source.label}结束于 ${Number(source.end.toFixed(3))}s，晚于${target.label}的 ${Number(target.end.toFixed(3))}s；上游结束时间不能晚于下游` });
  };
  const transitions = new Map(graph.emotion_transitions.map(entry => [entry.id, entry]));
  for (const link of graph.links) {
    if (link.to_type === 'emotion_transition') {
      const transition = transitions.get(link.to_id);
      if (transition) check(link.from_type, link.from_id, 'emotion_state', transition.to_state_id, link.id);
    } else check(link.from_type, link.from_id, link.to_type, link.to_id, link.id);
    if (link.type === 'transitions_to') for (const ref of link.content_refs || []) {
      check(ref.node_type, ref.node_id, 'emotion_state', link.to_id, link.id);
    }
  }
  for (const transition of graph.emotion_transitions) check('emotion_state', transition.from_state_id, 'emotion_state', transition.to_state_id, transition.id);
  return issues;
}

export function assertTemporalOrder(ws, graph = ws.graph || blankGraph()) {
  const issues = temporalOrderIssues(ws, graph);
  if (issues.length) {
    const error = new Error(issues.slice(0, 3).map(issue => issue.message).join('；'));
    error.code = 'TEMPORAL_ORDER'; error.issues = issues; throw error;
  }
}

export function assertEvidenceTimeChange(ws, itemID, next) {
  const record = ws.records[itemID];
  assertTemporalOrder({ ...ws, records: { ...ws.records, [itemID]: { ...record,
    segments: record.segments.map(segment => segment.id === next.id ? next : segment) } } });
}

// Evidence windows locate presentation; independent fact windows locate occurrence.
export function factTemporalDetails(ws, graph = ws.graph || blankGraph()) {
  const times=factTimeRanges(ws,graph),index=new Map(evidenceNodes(ws).map(entry=>[entry.id,entry])),supports=new Map();
  for(const link of graph.links)if(link.from_type==='evidence'&&link.to_type==='fact'&&link.type==='supports'){if(!supports.has(link.to_id))supports.set(link.to_id,[]);supports.get(link.to_id).push(link.from_id);}
  return Object.fromEntries(graph.facts.map(fact=>{const refs=(supports.get(fact.id)||[]).map(id=>index.get(id)).filter(Boolean),time=times[fact.id];let evidence_time=null;
    try{evidence_time=rangesFromIndex(index,refs.map(ref=>ref.id));}catch{}
    const disjoint=refs.filter(ref=>time?.time_ranges.length&&ref.timeline_id===time.timeline_id&&!time.time_ranges.some(range=>range.start_time<ref.global_end_time&&range.end_time>ref.global_start_time));
    return [fact.id,{occurrence:time,evidence_presentation:evidence_time,disjoint_evidence_ids:disjoint.map(ref=>ref.id)}];
  }));
}

export function normalizeGraph(raw, ws) {
  if (raw === undefined || raw === null) return blankGraph();
  object(raw, '图谱');
  const graph = blankGraph();
  graph.status = raw.status ?? 'draft';
  if (!['draft', 'complete'].includes(graph.status)) throw new Error('图谱完成状态无效');
  graph.entities = array(raw.entities, '主体列表').map(node => {
    object(node, '主体');
    return { id: id(node.id, '主体 ID'), name: string(node.name, '主体名称', 500), aliases: [...new Set(array(node.aliases, '主体别名', 100).map(alias => string(alias, '主体别名', 500)))], ...(node.item_id?{item_id:id(node.item_id,'所属素材 ID')}:{}) };
  });
  graph.mentions = array(raw.mentions, '主体提及列表').map(node => {
    object(node, '主体提及');
    return { id: id(node.id, '提及 ID'), entity_id: id(node.entity_id, '提及主体 ID', true), evidence_id: id(node.evidence_id, '提及证据引用', false, 1024), description: string(node.description, '提及描述', 5000) };
  });
  graph.facts = array(raw.facts, '事实列表').map(node => {
    object(node, '事实'); const kind = node.kind ?? 'observation';
    if (!['observation', 'reported_speech'].includes(kind)) throw new Error('事实类型无效');
    return { id: id(node.id, '事实 ID'), text: string(node.text, '事实内容'), subject_ids: subjects(node.subject_ids), kind,
      speaker_id: id(node.speaker_id, '说话人 ID', true), review_status: review(node.review_status), ...(node.item_id === undefined ? {} : { item_id: id(node.item_id, '所属素材 ID') }),
      ...(node.time_note===undefined?{}:{time_note:string(node.time_note,'事实发生时间说明')}),
      ...(node.time_ranges===undefined?{}:{timeline_id:id(node.timeline_id,'事实时间轴'),time_ranges:array(node.time_ranges,'事实时间窗').map(range=>{object(range,'事实时间窗');const start=number(range.start_time,'事实起点'),end=number(range.end_time,'事实终点');if(end<=start)throw new Error('事实终点必须大于起点');return {start_time:start,end_time:end};})}) };
  });
  graph.events = array(raw.events, '事件列表').map(node => {
    object(node, '事件');
    return { id: id(node.id, '事件 ID'), title: string(node.title, '事件描述'), subject_ids: subjects(node.subject_ids), timeline_id: id(node.timeline_id, '事件时间轴', true), review_status: review(node.review_status), ...(node.item_id === undefined ? {} : { item_id: id(node.item_id, '所属素材 ID') }) };
  });
  graph.emotion_states = array(raw.emotion_states, '情感状态列表').map(node => {
    object(node, '情感状态');
    const start = number(node.start_time, '情感起点', 0), end = number(node.end_time, '情感终点', start + .001);
    if (end <= start) throw new Error('情感状态终点必须大于起点');
    const intensity = node.intensity ?? null;
    if (intensity !== null && (!Number.isInteger(intensity) || intensity < 1 || intensity > 5)) throw new Error('情感强度必须为 1–5 的整数或空值');
    return { id: id(node.id, '情感状态 ID'), subject_id: id(node.subject_id, '情感主体 ID', true), label: string(node.label, '情感标签', 500),
      timeline_id: id(node.timeline_id, '情感时间轴', true), start_time: start, end_time: end, intensity, review_status: review(node.review_status), ...(node.item_id === undefined ? {} : { item_id: id(node.item_id, '所属素材 ID') }) };
  });
  graph.emotion_transitions = array(raw.emotion_transitions, '情感变化列表').map(node => {
    object(node, '情感变化');
    return { id: id(node.id, '情感变化 ID'), subject_id: id(node.subject_id, '变化主体 ID', true), from_state_id: id(node.from_state_id, '起始情感状态', true),
      to_state_id: id(node.to_state_id, '后续情感状态', true), note: string(node.note, '情感变化说明'), review_status: review(node.review_status) };
  });
  graph.links = array(raw.links, '关联边', MAX_GRAPH_LINKS).map(node => {
    object(node, '关联边');
    if(node.content_influence!==undefined && (node.type!=='transitions_to' || !['yes','no','insufficient_evidence'].includes(node.content_influence)))throw new Error('情感变化的内容影响标记无效');
    return { id: id(node.id, '关联边 ID'), from_type: id(node.from_type, '来源节点类型'), from_id: id(node.from_id, '来源节点 ID', false, 1024),
      to_type: id(node.to_type, '目标节点类型'), to_id: id(node.to_id, '目标节点 ID'), type: id(node.type, '关系类型'),
      ...(node.note === undefined ? {} : { note: string(node.note, '逐关系判断依据') }),...(node.content_influence===undefined?{}:{content_influence:node.content_influence}),
      ...(node.content_refs===undefined?{}:{content_refs:array(node.content_refs,'情感变化内容依据').map(ref=>{
        object(ref,'情感变化内容依据');
        if(node.type!=='transitions_to'||!['evidence','fact','event'].includes(ref.node_type)||!['associated_with','influences','unrelated','insufficient_evidence'].includes(ref.relation))throw new Error('情感变化内容依据类型或关系无效');
        return {node_type:ref.node_type,node_id:id(ref.node_id,'情感变化依据 ID',false,1024),relation:ref.relation,note:string(ref.note??'','情感变化逐项依据')};
      })}) };
  });
  if (COLLECTIONS.reduce((total, name) => total + graph[name].length, 0) > MAX_GRAPH_NODES) throw new Error('图谱节点总数超过 10000，请拆分项目');
  const all = new Set();
  for (const name of [...COLLECTIONS, 'links']) for (const node of graph[name]) {
    if (all.has(node.id)) throw new Error('图谱节点或关联边 ID 重复');
    all.add(node.id);
  }
  const entityIDs = new Set(graph.entities.map(node => node.id));
  const stateIDs = new Set(graph.emotion_states.map(node => node.id));
  const evidenceIDs = new Set(evidenceNodes(ws).map(node => node.id));
  const checkEntity = value => { if (value && !entityIDs.has(value)) throw new Error('引用了不存在的主体'); };
  for (const mention of graph.mentions) {
    checkEntity(mention.entity_id);
    if (!evidenceIDs.has(mention.evidence_id)) throw new Error('主体提及引用了不存在的证据时间窗');
  }
  for (const fact of graph.facts) { fact.subject_ids.forEach(checkEntity); checkEntity(fact.speaker_id); }
  for (const event of graph.events) event.subject_ids.forEach(checkEntity);
  for (const state of graph.emotion_states) checkEntity(state.subject_id);
  for (const transition of graph.emotion_transitions) {
    checkEntity(transition.subject_id);
    if ((transition.from_state_id && !stateIDs.has(transition.from_state_id)) || (transition.to_state_id && !stateIDs.has(transition.to_state_id))) throw new Error('情感变化引用了不存在的状态');
  }
  const nodeIDs = { evidence: evidenceIDs, fact: new Set(graph.facts.map(n => n.id)), event: new Set(graph.events.map(n => n.id)),
    emotion_state: stateIDs, emotion_transition: new Set(graph.emotion_transitions.map(n => n.id)) };
  const relationships = new Set();
  for (const link of graph.links) {
    const refKeys=new Set();
    for(const ref of link.content_refs||[]){
      if(!nodeIDs[ref.node_type]?.has(ref.node_id))throw new Error('情感变化内容依据引用了不存在的节点');
      const key=JSON.stringify([ref.node_type,ref.node_id]);if(refKeys.has(key))throw new Error('情感变化内容依据重复');refKeys.add(key);
    }
    if (!EDGE_TYPES.has(`${link.from_type}:${link.to_type}:${link.type}`)) throw new Error('不支持的图谱关联方向或关系类型');
    if (!nodeIDs[link.from_type]?.has(link.from_id) || !nodeIDs[link.to_type]?.has(link.to_id)) throw new Error('关联边引用了不存在的节点');
    const signature = JSON.stringify([link.from_type, link.from_id, link.to_type, link.to_id, link.type]);
    if (relationships.has(signature)) throw new Error('图谱关联重复');
    relationships.add(signature);
  }
  const supportingPairs = new Set(graph.links.filter(link => link.from_type === 'evidence' && link.to_type === 'fact').map(link => JSON.stringify([link.from_id, link.to_id])));
  for (const item of ws?.manifest?.items || []) {
    if (Object.hasOwn(item, 'subject_ids')) {
      const ids = array(item.subject_ids, '任务主体', 100).map(value => id(value, '任务主体 ID'));
      if (new Set(ids).size !== ids.length) throw new Error('任务主体 ID 重复');
      ids.forEach(checkEntity);
    }
    for (const segment of ws?.records?.[item.id]?.segments || []) {
      const annotation = segment.annotations || {};
      if (Object.hasOwn(annotation, 'subject_ids')) {
        const ids = array(annotation.subject_ids, '证据主体', 100).map(value => id(value, '证据主体 ID'));
        if (new Set(ids).size !== ids.length) throw new Error('证据主体 ID 重复');
        ids.forEach(checkEntity);
      }
      if (annotation.fact_id) {
        const factID = id(annotation.fact_id, '证据事实 ID');
        if (!nodeIDs.fact.has(factID) || !supportingPairs.has(JSON.stringify([evidenceKey(item.id, segment.id), factID]))) throw new Error('证据绑定了不存在或缺少支持关系的事实');
      }
    }
  }
  if (graph.status === 'complete') {
    const errors = graphIssues({ ...ws, graph }).filter(issue => issue.severity === 'error');
    if (errors.length) throw new Error(`图谱尚不能标记完成：${errors.slice(0, 3).map(issue => issue.message).join('；')}`);
  }
  return graph;
}

export function graphIssues(ws) {
  const graph = ws?.graph || blankGraph(), issues = [];
  const add = (message, type, node, severity = 'error') => issues.push({ message, severity, ...(type ? { node_type: type, node_id: node?.id || '' } : {}) });
  let evidence;
  try { evidence = evidenceNodes(ws); } catch (error) { add(error.message); return issues; }
  const evidenceIndex = new Map(evidence.map(node => [node.id, node]));
  const index = indexGraph(graph);
  const facts = index.nodesByType.get('fact'), events = index.nodesByType.get('event'), states = index.nodesByType.get('emotion_state');
  const incoming = (type, nodeID, fromType) => {
    const bucket = index.incoming.get(typed(type, nodeID));
    return (fromType ? bucket?.byType.get(fromType) : bucket?.all) || EMPTY;
  };
  const factRefCache = new Map(), eventFactCache = new Map();
  const factRefs = factID => {
    if (!factRefCache.has(factID)) factRefCache.set(factID, incoming('fact', factID, 'evidence').map(link => link.from_id));
    return factRefCache.get(factID);
  };
  const eventFacts = eventID => {
    if (!eventFactCache.has(eventID)) eventFactCache.set(eventID, incoming('event', eventID, 'fact').map(link => link.from_id));
    return eventFactCache.get(eventID);
  };
  const refsForFacts = factIDs => [...new Set(factIDs.flatMap(factRefs))];
  const bounds = (refs, type, node) => { try { return boundsFromIndex(evidenceIndex, refs); } catch (error) { add(error.message, type, node); return null; } };
  const eventBounds = new Map();
  const factTemporal=factTemporalDetails(ws,graph),eventTimes=eventTimeRanges(ws,graph);
  if (!evidence.length) add('尚未创建证据时间窗');
  if (!graph.facts.length) add('尚未建立独立事实节点');
  if (!graph.events.length) add('尚未建立复合事件节点');
  if (!graph.emotion_states.length) add('尚未建立主体情感状态');
  const mentioned = new Set(graph.mentions.filter(mention => mention.entity_id && evidenceIndex.has(mention.evidence_id)).map(mention => mention.entity_id));
  const mentionsByEntity = new Map();
  for (const mention of graph.mentions) {
    if (!mentionsByEntity.has(mention.entity_id)) mentionsByEntity.set(mention.entity_id, new Set());
    mentionsByEntity.get(mention.entity_id).add(mention.evidence_id);
  }
  const usedEntities = new Set([...graph.facts.flatMap(fact => [...fact.subject_ids, fact.speaker_id]), ...graph.events.flatMap(event => event.subject_ids), ...graph.emotion_states.map(state => state.subject_id)].filter(Boolean));
  for (const entity of graph.entities) {
    if (!entity.name.trim()) add('主体缺少名称', 'entity', entity);
    if (usedEntities.has(entity.id) && !mentioned.has(entity.id)) add('该主体没有可回看的证据提及，共指尚未落地', 'entity', entity, 'warning');
  }
  for (const mention of graph.mentions) if (!mention.entity_id) add('主体提及尚未指向统一主体', 'mention', mention);
  for (const window of evidence) {
    if (window.modality === 'unclassified') add('证据时间窗尚未选择模态归属类别', 'evidence', window);
    if (!index.outgoing.has(typed('evidence', window.id))) add('证据时间窗尚未关联事实', 'evidence', window);
  }
  for (const fact of graph.facts) {
    if (!fact.text.trim()) add('事实内容不能为空', 'fact', fact);
    if (!fact.subject_ids.length) add('事实尚未关联主体', 'fact', fact);
    if (fact.kind === 'reported_speech' && !fact.speaker_id) add('转述类事实需要注明说话人', 'fact', fact);
    if (fact.kind === 'observation' && fact.speaker_id) add('观察事实不能设置发言者；人物陈述请使用转述类事实', 'fact', fact);
    const refs = factRefs(fact.id);
    if (!refs.length) add('事实没有支持证据', 'fact', fact); else bounds(refs, 'fact', fact);
    const temporal=factTemporal[fact.id];
    if(temporal.disjoint_evidence_ids.length&&!fact.time_note?.trim())add('事实发生时间与部分证据呈现时间不相交，请填写时间说明（如回述、回忆或前提证据）；允许保存', 'fact',fact,'warning');
    if(temporal.evidence_presentation&&temporal.occurrence.timeline_id!==temporal.evidence_presentation.timeline_id)add('事实发生时间与支持证据不在同一时间轴','fact',fact);
    for (const subjectID of fact.subject_ids) if (!refs.some(ref => mentionsByEntity.get(subjectID)?.has(ref))) add(`事实主体 ${subjectID} 在本事实的支持窗中没有对应提及`, 'fact', fact, 'warning');
    if (fact.kind === 'reported_speech' && fact.speaker_id && !refs.some(ref => mentionsByEntity.get(fact.speaker_id)?.has(ref))) add('说话人在本事实的支持窗中没有对应提及', 'fact', fact);
  }
  for (const event of graph.events) {
    if (!event.title.trim()) add('事件描述不能为空', 'event', event);
    if (!event.subject_ids.length) add('事件尚未关联参与主体', 'event', event);
    const supportedFacts = eventFacts(event.id);
    if (!supportedFacts.length) add('事件尚未关联组成事实', 'event', event);
    const eventTime=eventTimes[event.id],extent=eventTime?.time_ranges.length?{timeline_id:eventTime.timeline_id,start_time:eventTime.time_ranges[0].start_time,end_time:eventTime.time_ranges.at(-1).end_time}:null;eventBounds.set(event.id, extent);
    if (!event.timeline_id || (extent && event.timeline_id !== extent.timeline_id)) add('事件时间轴与支持事实不一致或尚未设置', 'event', event);
    const groundedSubjects = new Set(supportedFacts.flatMap(key => {
      const fact = facts.get(key);
      return [...(fact?.subject_ids || []), fact?.kind === 'reported_speech' ? fact.speaker_id : ''].filter(Boolean);
    }));
    if (event.subject_ids.some(key => !groundedSubjects.has(key))) add('事件参与者缺少对应事实支持', 'event', event, 'warning');
  }
  for (const state of graph.emotion_states) {
    if (!state.subject_id) add('情感状态尚未关联主体', 'emotion_state', state);
    if (!state.label.trim()) add('情感状态缺少标签', 'emotion_state', state);
    const directLinks = incoming('emotion_state', state.id, 'event');
    const explicitFacts = incoming('emotion_state', state.id, 'fact').map(link => link.from_id);
    // Direct fact links are an explicit subset, never expand them on validation.
    // Event-only states can still trace their support through event constituents.
    const supportedFacts = explicitFacts.length ? explicitFacts : [...new Set(directLinks.flatMap(link => eventFacts(link.from_id)))];
    if (!explicitFacts.length && !directLinks.length) add('情感状态至少需要一条事实或一个复合事件作为依据', 'emotion_state', state);
    const extent = bounds(refsForFacts(supportedFacts), 'emotion_state', state);
    if (!state.timeline_id || (extent && state.timeline_id !== extent.timeline_id)) add('情感状态时间轴与依据不一致或尚未设置', 'emotion_state', state);
    if (extent && (state.end_time <= extent.start_time || state.start_time >= extent.end_time)) add('情感观测时间与依据呈现时间不相交，请核对是否属于后续回述或跨时依据；不据此否定事件影响', 'emotion_state', state,'warning');
    const subjectSupported = supportedFacts.some(key => facts.get(key)?.subject_ids.includes(state.subject_id));
    if (state.subject_id && !subjectSupported) add('该主体的情感状态缺少对应主体的事实支持', 'emotion_state', state, 'warning');
    const direct = directLinks.map(link => link.from_id);
    for (const link of directLinks) {
      if (link.type === 'causes' && !link.note?.trim()) add('状态的因果关系需要填写逐事件人工判断依据', 'emotion_state', state);
      if (link.type === 'causes' && eventBounds.get(link.from_id)?.start_time > state.end_time + .001) add('完全发生在情感状态结束之后的事件不能导致该状态', 'emotion_state', state);
    }
    const viaTransitions = (index.transitionsByState.get(state.id) || EMPTY).flatMap(t => incoming('emotion_transition', t.id, 'event').map(link => link.from_id));
    const associated = [...new Set([...direct, ...viaTransitions])];
    for (const eventID of associated) if (eventBounds.get(eventID) && eventBounds.get(eventID).timeline_id !== state.timeline_id) add('关联事件与情感状态不在共同时间轴', 'emotion_state', state);
  }
  for (const transition of graph.emotion_transitions) {
    const from = states.get(transition.from_state_id), to = states.get(transition.to_state_id);
    if (!from || !to) { add('情感变化缺少前后状态', 'emotion_transition', transition); continue; }
    if (from.id === to.id || !transition.subject_id || from.subject_id !== transition.subject_id || to.subject_id !== transition.subject_id) add('情感变化必须连接同一主体的两个不同状态', 'emotion_transition', transition);
    if (!from.timeline_id || from.timeline_id !== to.timeline_id) add('情感变化不能跨越不同时间轴', 'emotion_transition', transition);
    if (to.start_time < from.end_time - .001) add('情感变化的前后状态时间倒置或重叠', 'emotion_transition', transition);
    const associated = incoming('emotion_transition', transition.id, 'event');
    if (!associated.length) add('情感变化尚未关联具体事件', 'emotion_transition', transition);
    for (const link of associated) {
      const event = events.get(link.from_id);
      if (event?.timeline_id && event.timeline_id !== from.timeline_id) add('情感变化的关联事件与主体状态不在共同时间轴', 'emotion_transition', transition);
      if (link.type === 'causes' && !transition.note.trim()) add('因果关系需要填写人工判断依据，不能仅由先后顺序得出', 'emotion_transition', transition);
      if (link.type === 'causes' && eventBounds.get(link.from_id)?.start_time > to.end_time + .001) add('完全发生在后续情感状态结束之后的事件不能导致该变化', 'emotion_transition', transition);
    }
  }
  const stateChanges = graph.links.filter(link => link.type === 'transitions_to' && link.from_type === 'emotion_state' && link.to_type === 'emotion_state');
  for (const link of stateChanges) {
    const from = states.get(link.from_id), to = states.get(link.to_id);
    if (!from || !to) continue;
    if (from.id === to.id || !from.subject_id || from.subject_id !== to.subject_id) add('情感变化边必须连接同一主体的两个不同状态', 'emotion_state', to);
    if (!from.timeline_id || from.timeline_id !== to.timeline_id) add('情感变化边不能跨越不同时间轴', 'emotion_state', to);
    if (to.start_time < from.end_time - .001) add('情感变化边的前后状态时间倒置或重叠', 'emotion_state', to);
    for(const ref of link.content_refs||[]){
      if(ref.node_type!=='event'||ref.relation!=='influences')continue;
      const extent=eventBounds.get(ref.node_id);
      if(extent&&extent.timeline_id!==to.timeline_id)add('影响情感变化的事件与状态不在同一时间轴','link',link);
      if(extent&&extent.start_time>to.end_time+.001)add('完全发生在后续情感状态结束之后的事件不能影响本次变化；请核对事件发生时间','link',link);
      if(!ref.note?.trim())add('请说明该复合事件如何影响本次情感变化','link',link,'warning');
    }
  }
  if (graph.emotion_states.length && !graph.emotion_transitions.length && !stateChanges.length) add('当前只有情感状态记录，未标注状态迁移；稳定情绪可保留此状态', '', null, 'warning');
  return issues.concat(temporalOrderIssues(ws, graph));
}

function invalidateNodes(ws, seeds) {
  const graph = ws.graph || (ws.graph = blankGraph()); graph.status = 'draft';
  const index = indexGraph(graph);
  const queue = [...seeds], seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const [type, nodeID] = queue[i]; const key = typed(type, nodeID);
    if (seen.has(key)) continue; seen.add(key);
    const node = index.nodesByType.get(type)?.get(nodeID);
    if (node && Object.hasOwn(node, 'review_status')) node.review_status = 'needs_review';
    for (const link of index.outgoing.get(key) || EMPTY) queue.push([link.to_type, link.to_id]);
    if (type === 'emotion_state') for (const transition of index.transitionsByState.get(nodeID) || EMPTY) queue.push(['emotion_transition', transition.id]);
  }
  return graph;
}
export function invalidateEvidence(ws, refs) { return invalidateNodes(ws, [...keys(refs)].map(key => ['evidence', key])); }
export function connectEmotionStates(ws, fromID, toID) {
  const graph = ws.graph, from = graph.emotion_states.find(state => state.id === fromID), to = graph.emotion_states.find(state => state.id === toID);
  if (!from || !to || from.id === to.id || !from.subject_id || from.subject_id !== to.subject_id) throw new Error('请选择同一主体的两个不同情感状态');
  if (!from.timeline_id || from.timeline_id !== to.timeline_id) throw new Error('两个状态必须在同一时间轴');
  if (to.start_time < from.end_time - .001) throw new Error('变化后的状态不能早于或重叠于变化前的状态');
  const existing = graph.links.find(link => link.from_type === 'emotion_state' && link.to_type === 'emotion_state' && link.from_id === fromID && link.to_id === toID && link.type === 'transitions_to');
  if (existing) return existing;
  const link = { id: nextAnnotationId(ws, 'link'), from_type: 'emotion_state', from_id: fromID, to_type: 'emotion_state', to_id: toID, type: 'transitions_to' };
  graph.links.push(link); graph.status = 'draft'; return link;
}
export function connectEmotionStateSelection(ws, ids) {
  const chosen = [...new Set(ids)].map(id => ws.graph.emotion_states.find(state => state.id === id));
  if (chosen.length < 2 || chosen.some(state => !state)) throw new Error('请勾选至少两个已保存的情感状态');
  const first = chosen[0];
  if (!first.subject_id || chosen.some(state => state.subject_id !== first.subject_id)) throw new Error('一次只能连接同一主体的情感状态');
  if (!first.timeline_id || chosen.some(state => state.timeline_id !== first.timeline_id)) throw new Error('所选状态必须位于同一共同时间轴');
  chosen.sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time || a.id.localeCompare(b.id));
  for (let n = 1; n < chosen.length; n++) if (chosen[n].start_time < chosen[n - 1].end_time - .001) throw new Error('所选状态存在时间重叠，请先调整区间');
  // Validate the complete chain before the first write.
  return chosen.slice(1).map((state, n) => connectEmotionStates(ws, chosen[n].id, state.id));
}
export function invalidateFactDependents(ws, factID) {
  const seeds = (ws.graph?.links || []).filter(link => link.from_type === 'fact' && link.from_id === factID).map(link => [link.to_type, link.to_id]);
  return invalidateNodes(ws, seeds);
}
export function invalidateEventDependents(ws,eventID){const seeds=(ws.graph?.links||[]).filter(link=>link.from_type==='event'&&link.from_id===eventID).map(link=>[link.to_type,link.to_id]);return invalidateNodes(ws,seeds);}
function cleanEvidenceBindings(ws, graph) {
  const facts = new Set(graph.facts.map(fact => fact.id));
  const supports = new Set(graph.links.filter(link => link.from_type === 'evidence' && link.to_type === 'fact').map(link => JSON.stringify([link.from_id, link.to_id])));
  for (const item of ws?.manifest?.items || []) for (const segment of ws?.records?.[item.id]?.segments || []) {
    if (segment.annotations?.fact_id && (!facts.has(segment.annotations.fact_id) || !supports.has(JSON.stringify([evidenceKey(item.id, segment.id), segment.annotations.fact_id])))) delete segment.annotations.fact_id;
  }
}
export function removeEvidence(ws, refs) {
  const removed = keys(refs), graph = invalidateEvidence(ws, [...removed]);
  graph.mentions = graph.mentions.filter(mention => !removed.has(mention.evidence_id));
  graph.links = graph.links.filter(link => link.from_type !== 'evidence' || !removed.has(link.from_id));
  for(const link of graph.links)if(link.content_refs)link.content_refs=link.content_refs.filter(ref=>ref.node_type!=='evidence'||!removed.has(ref.node_id));
  cleanEvidenceBindings(ws, graph);
  return graph;
}
export function removeGraphNode(ws, collection, nodeID) {
  const name = TYPES[collection] || collection, graph = ws.graph || (ws.graph = blankGraph());
  if (![...COLLECTIONS, 'links'].includes(name)) throw new Error('未知的图谱节点集合');
  const node = graph[name].find(value => value.id === nodeID);
  if (!node) return graph;
  const type = nodeType(name), seeds = [[type, nodeID]];
  if (name === 'links') seeds.push([node.to_type, node.to_id]);
  if (name === 'mentions' && node.entity_id) for (const fact of graph.facts) if (fact.subject_ids.includes(node.entity_id) || fact.speaker_id === node.entity_id) seeds.push(['fact', fact.id]);
  if (name === 'entities') {
    for (const item of ws?.manifest?.items || []) if (item.subject_ids) item.subject_ids = item.subject_ids.filter(key => key !== nodeID);
    for (const record of Object.values(ws.records || {})) for (const segment of record.segments || []) if (segment.annotations?.subject_ids?.includes(nodeID)) {
      segment.annotations.subject_ids = segment.annotations.subject_ids.filter(key => key !== nodeID);
      segment.annotations.subject_id = segment.annotations.subject_ids[0] || '';
      record.status = 'draft';
    }
    graph.mentions = graph.mentions.filter(mention => mention.entity_id !== nodeID);
    for (const fact of graph.facts) if (fact.subject_ids.includes(nodeID) || fact.speaker_id === nodeID) {
      fact.subject_ids = fact.subject_ids.filter(key => key !== nodeID); if (fact.speaker_id === nodeID) fact.speaker_id = ''; seeds.push(['fact', fact.id]);
    }
    for (const event of graph.events) if (event.subject_ids.includes(nodeID)) { event.subject_ids = event.subject_ids.filter(key => key !== nodeID); seeds.push(['event', event.id]); }
    for (const state of graph.emotion_states) if (state.subject_id === nodeID) { state.subject_id = ''; seeds.push(['emotion_state', state.id]); }
    for (const transition of graph.emotion_transitions) if (transition.subject_id === nodeID) { transition.subject_id = ''; seeds.push(['emotion_transition', transition.id]); }
  }
  const removedTransitions = new Set();
  if (name === 'emotion_states') for (const transition of graph.emotion_transitions) if (transition.from_state_id === nodeID || transition.to_state_id === nodeID) removedTransitions.add(transition.id);
  if (name === 'emotion_transitions') for (const key of [node.from_state_id, node.to_state_id]) if (key) seeds.push(['emotion_state', key]);
  invalidateNodes(ws, seeds);
  graph[name] = graph[name].filter(value => value.id !== nodeID);
  if (name === 'mentions' && !graph.mentions.some(mention => mention.entity_id === node.entity_id && mention.evidence_id === node.evidence_id)) {
    for (const item of ws?.manifest?.items || []) for (const segment of ws?.records?.[item.id]?.segments || []) {
      if (evidenceKey(item.id, segment.id) !== node.evidence_id || !segment.annotations?.subject_ids) continue;
      segment.annotations.subject_ids = segment.annotations.subject_ids.filter(key => key !== node.entity_id);
      segment.annotations.subject_id = segment.annotations.subject_ids[0] || '';
      ws.records[item.id].status = 'draft';
    }
  }
  graph.emotion_transitions = graph.emotion_transitions.filter(value => !removedTransitions.has(value.id));
  graph.links = graph.links.filter(link => !(link.from_type === type && link.from_id === nodeID) && !(link.to_type === type && link.to_id === nodeID) && !(link.to_type === 'emotion_transition' && removedTransitions.has(link.to_id)));
  for(const link of graph.links)if(link.content_refs)link.content_refs=link.content_refs.filter(ref=>ref.node_type!==type||ref.node_id!==nodeID);
  cleanEvidenceBindings(ws, graph);
  return graph;
}
export function migrateLegacyGraph(ws) {
  const graph = blankGraph(), known = new Map(); let unknownCount = 0;
  for (const item of ws?.manifest?.items || []) for (const segment of ws?.records?.[item.id]?.segments || []) {
    const annotation = segment.annotations || {}, content = (annotation.local_fact || '').trim() || (annotation.observation || '').trim();
    const legacyName = (annotation.subject_id || '').trim();
    if (!content && !legacyName) continue;
    const unknown = !legacyName || /^(unknown|unk|未知|不明|匿名|待确认|n\/a)$/i.test(legacyName);
    let entity = unknown ? null : known.get(legacyName);
    if (!entity) {
      entity = { id: nextAnnotationId(ws, 'entity'), name: unknown ? `未知主体 ${++unknownCount}` : legacyName, aliases: [] };
      graph.entities.push(entity); if (!unknown) known.set(legacyName, entity);
    }
    const evidenceID = evidenceKey(item.id, segment.id);
    graph.mentions.push({ id: nextAnnotationId(ws, 'mention'), entity_id: entity.id, evidence_id: evidenceID, description: legacyName || '旧标注迁移的主体提及' });
    if (content) {
      const fact = { id: nextAnnotationId(ws, 'fact'), text: content, subject_ids: [entity.id], kind: segment.label === 'speech_content' ? 'reported_speech' : 'observation', speaker_id: segment.label === 'speech_content' ? entity.id : '', review_status: 'needs_review' };
      graph.facts.push(fact);
      graph.links.push({ id: nextAnnotationId(ws, 'link'), from_type: 'evidence', from_id: evidenceID, to_type: 'fact', to_id: fact.id, type: 'supports' });
    }
  }
  return normalizeGraph(graph, ws);
}
