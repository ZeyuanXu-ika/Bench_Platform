// Pure graph data and validation. Media windows remain authoritative in ws.records.
export const MAX_GRAPH_NODES = 10000;
export const MAX_GRAPH_LINKS = 50000;
const COLLECTIONS = ['entities', 'mentions', 'facts', 'events', 'emotion_states', 'emotion_transitions'];
const TYPES = { entity: 'entities', mention: 'mentions', fact: 'facts', event: 'events', emotion_state: 'emotion_states', emotion_transition: 'emotion_transitions', link: 'links' };
const REVIEWS = new Set(['draft', 'confirmed', 'needs_review']);
const EDGE_TYPES = new Set(['evidence:fact:supports', 'fact:event:constitutes', 'fact:emotion_state:grounds', 'event:emotion_state:associated_with', 'event:emotion_transition:associated_with', 'event:emotion_transition:causes']);
const uid = () => crypto.randomUUID();
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

export function normalizeGraph(raw, ws) {
  if (raw === undefined || raw === null) return blankGraph();
  object(raw, '图谱');
  const graph = blankGraph();
  graph.status = raw.status ?? 'draft';
  if (!['draft', 'complete'].includes(graph.status)) throw new Error('图谱完成状态无效');
  graph.entities = array(raw.entities, '主体列表').map(node => {
    object(node, '主体');
    return { id: id(node.id, '主体 ID'), name: string(node.name, '主体名称', 500), aliases: [...new Set(array(node.aliases, '主体别名', 100).map(alias => string(alias, '主体别名', 500)))] };
  });
  graph.mentions = array(raw.mentions, '主体提及列表').map(node => {
    object(node, '主体提及');
    return { id: id(node.id, '提及 ID'), entity_id: id(node.entity_id, '提及主体 ID', true), evidence_id: id(node.evidence_id, '提及证据引用', false, 1024), description: string(node.description, '提及描述', 5000) };
  });
  graph.facts = array(raw.facts, '事实列表').map(node => {
    object(node, '事实'); const kind = node.kind ?? 'observation';
    if (!['observation', 'reported_speech'].includes(kind)) throw new Error('事实类型无效');
    return { id: id(node.id, '事实 ID'), text: string(node.text, '事实内容'), subject_ids: subjects(node.subject_ids), kind,
      speaker_id: id(node.speaker_id, '说话人 ID', true), review_status: review(node.review_status) };
  });
  graph.events = array(raw.events, '事件列表').map(node => {
    object(node, '事件');
    return { id: id(node.id, '事件 ID'), title: string(node.title, '事件描述'), subject_ids: subjects(node.subject_ids), timeline_id: id(node.timeline_id, '事件时间轴', true), review_status: review(node.review_status) };
  });
  graph.emotion_states = array(raw.emotion_states, '情感状态列表').map(node => {
    object(node, '情感状态');
    const start = number(node.start_time, '情感起点', 0), end = number(node.end_time, '情感终点', start + .001);
    if (end <= start) throw new Error('情感状态终点必须大于起点');
    const intensity = node.intensity ?? null;
    if (intensity !== null && (!Number.isInteger(intensity) || intensity < 1 || intensity > 5)) throw new Error('情感强度必须为 1–5 的整数或空值');
    return { id: id(node.id, '情感状态 ID'), subject_id: id(node.subject_id, '情感主体 ID', true), label: string(node.label, '情感标签', 500),
      timeline_id: id(node.timeline_id, '情感时间轴', true), start_time: start, end_time: end, intensity, review_status: review(node.review_status) };
  });
  graph.emotion_transitions = array(raw.emotion_transitions, '情感变化列表').map(node => {
    object(node, '情感变化');
    return { id: id(node.id, '情感变化 ID'), subject_id: id(node.subject_id, '变化主体 ID', true), from_state_id: id(node.from_state_id, '起始情感状态', true),
      to_state_id: id(node.to_state_id, '后续情感状态', true), note: string(node.note, '情感变化说明'), review_status: review(node.review_status) };
  });
  graph.links = array(raw.links, '关联边', MAX_GRAPH_LINKS).map(node => {
    object(node, '关联边');
    return { id: id(node.id, '关联边 ID'), from_type: id(node.from_type, '来源节点类型'), from_id: id(node.from_id, '来源节点 ID', false, 1024),
      to_type: id(node.to_type, '目标节点类型'), to_id: id(node.to_id, '目标节点 ID'), type: id(node.type, '关系类型') };
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
    if (!EDGE_TYPES.has(`${link.from_type}:${link.to_type}:${link.type}`)) throw new Error('不支持的图谱关联方向或关系类型');
    if (!nodeIDs[link.from_type]?.has(link.from_id) || !nodeIDs[link.to_type]?.has(link.to_id)) throw new Error('关联边引用了不存在的节点');
    const signature = JSON.stringify([link.from_type, link.from_id, link.to_type, link.to_id, link.type]);
    if (relationships.has(signature)) throw new Error('图谱关联重复');
    relationships.add(signature);
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
  if (!evidence.length) add('尚未创建证据时间窗');
  if (!graph.facts.length) add('尚未建立独立事实节点');
  if (!graph.events.length) add('尚未建立复合事件节点');
  if (!graph.emotion_states.length) add('尚未建立主体情感状态');
  for (const collection of ['facts', 'events', 'emotion_states', 'emotion_transitions']) for (const node of graph[collection]) {
    if (node.review_status !== 'confirmed') add('该节点尚未人工确认或需要重新复核', nodeType(collection), node);
  }
  const mentioned = new Set(graph.mentions.filter(mention => mention.entity_id && evidenceIndex.has(mention.evidence_id)).map(mention => mention.entity_id));
  const mentionsByEntity = new Map();
  for (const mention of graph.mentions) {
    if (!mentionsByEntity.has(mention.entity_id)) mentionsByEntity.set(mention.entity_id, new Set());
    mentionsByEntity.get(mention.entity_id).add(mention.evidence_id);
  }
  const usedEntities = new Set([...graph.facts.flatMap(fact => [...fact.subject_ids, fact.speaker_id]), ...graph.events.flatMap(event => event.subject_ids), ...graph.emotion_states.map(state => state.subject_id)].filter(Boolean));
  for (const entity of graph.entities) {
    if (!entity.name.trim()) add('主体缺少名称', 'entity', entity);
    if (usedEntities.has(entity.id) && !mentioned.has(entity.id)) add('该主体没有可回看的证据提及，共指尚未落地', 'entity', entity);
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
    for (const subjectID of fact.subject_ids) if (!refs.some(ref => mentionsByEntity.get(subjectID)?.has(ref))) add(`事实主体 ${subjectID} 在本事实的支持窗中没有对应提及`, 'fact', fact);
    if (fact.kind === 'reported_speech' && fact.speaker_id && !refs.some(ref => mentionsByEntity.get(fact.speaker_id)?.has(ref))) add('说话人在本事实的支持窗中没有对应提及', 'fact', fact);
  }
  for (const event of graph.events) {
    if (!event.title.trim()) add('事件描述不能为空', 'event', event);
    if (!event.subject_ids.length) add('事件尚未关联参与主体', 'event', event);
    const supportedFacts = eventFacts(event.id);
    if (!supportedFacts.length) add('事件尚未关联组成事实', 'event', event);
    const extent = bounds(refsForFacts(supportedFacts), 'event', event); eventBounds.set(event.id, extent);
    if (!event.timeline_id || (extent && event.timeline_id !== extent.timeline_id)) add('事件时间轴与支持事实不一致或尚未设置', 'event', event);
    const groundedSubjects = new Set(supportedFacts.flatMap(key => {
      const fact = facts.get(key);
      return [...(fact?.subject_ids || []), fact?.kind === 'reported_speech' ? fact.speaker_id : ''].filter(Boolean);
    }));
    if (event.subject_ids.some(key => !groundedSubjects.has(key))) add('事件参与者缺少对应事实支持', 'event', event);
  }
  for (const state of graph.emotion_states) {
    if (!state.subject_id) add('情感状态尚未关联主体', 'emotion_state', state);
    if (!state.label.trim()) add('情感状态缺少标签', 'emotion_state', state);
    const supportedFacts = incoming('emotion_state', state.id, 'fact').map(link => link.from_id);
    if (!supportedFacts.length) add('情感状态没有事实依据', 'emotion_state', state);
    const extent = bounds(refsForFacts(supportedFacts), 'emotion_state', state);
    if (!state.timeline_id || (extent && state.timeline_id !== extent.timeline_id)) add('情感状态时间轴与依据不一致或尚未设置', 'emotion_state', state);
    if (extent && (state.end_time <= extent.start_time || state.start_time >= extent.end_time)) add('情感状态区间与事实证据不相交', 'emotion_state', state);
    const subjectSupported = supportedFacts.some(key => facts.get(key)?.subject_ids.includes(state.subject_id));
    if (state.subject_id && !subjectSupported) add('该主体的情感状态缺少对应主体的事实支持', 'emotion_state', state);
    const direct = incoming('emotion_state', state.id, 'event').map(link => link.from_id);
    const viaTransitions = (index.transitionsByState.get(state.id) || EMPTY).flatMap(t => incoming('emotion_transition', t.id, 'event').map(link => link.from_id));
    const associated = [...new Set([...direct, ...viaTransitions])];
    if (!associated.length) add('情感状态尚未关联复合事件，四层关系未闭合', 'emotion_state', state);
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
  if (graph.emotion_states.length && !graph.emotion_transitions.length) add('当前只有情感状态记录，未标注状态迁移；稳定情绪可保留此状态', '', null, 'warning');
  return issues;
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
export function removeEvidence(ws, refs) {
  const removed = keys(refs), graph = invalidateEvidence(ws, [...removed]);
  graph.mentions = graph.mentions.filter(mention => !removed.has(mention.evidence_id));
  graph.links = graph.links.filter(link => link.from_type !== 'evidence' || !removed.has(link.from_id));
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
  graph.emotion_transitions = graph.emotion_transitions.filter(value => !removedTransitions.has(value.id));
  graph.links = graph.links.filter(link => !(link.from_type === type && link.from_id === nodeID) && !(link.to_type === type && link.to_id === nodeID) && !(link.to_type === 'emotion_transition' && removedTransitions.has(link.to_id)));
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
      entity = { id: uid(), name: unknown ? `未知主体 ${++unknownCount}` : legacyName, aliases: [] };
      graph.entities.push(entity); if (!unknown) known.set(legacyName, entity);
    }
    const evidenceID = evidenceKey(item.id, segment.id);
    graph.mentions.push({ id: uid(), entity_id: entity.id, evidence_id: evidenceID, description: legacyName || '旧标注迁移的待确认主体提及' });
    if (content) {
      const fact = { id: uid(), text: content, subject_ids: [entity.id], kind: segment.label === 'speech_content' ? 'reported_speech' : 'observation', speaker_id: segment.label === 'speech_content' ? entity.id : '', review_status: 'needs_review' };
      graph.facts.push(fact);
      graph.links.push({ id: uid(), from_type: 'evidence', from_id: evidenceID, to_type: 'fact', to_id: fact.id, type: 'supports' });
    }
  }
  return normalizeGraph(graph, ws);
}
