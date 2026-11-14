import { convertGT } from './gt-import.mjs';

const range = (start_s, end_s) => ({ start_s, end_s });
const unique = values => [...new Set(values)];
const byID = rows => new Map(rows.map(row => [row.id, row]));
const channel = { visual_observation: 'visual', speech_content: 'speech', acoustic_observation: 'acoustic' };
const evidenceID = key => JSON.parse(key)[1];
const keyOf = (type, id) => JSON.stringify([type, id]);
function originalOrder(rows, original, key) {
  const positions = new Map(original.map((row, index) => [key(row), index]));
  return rows.sort((a, b) => (positions.get(key(a)) ?? Infinity) - (positions.get(key(b)) ?? Infinity));
}

export function exportGT(payload) {
  const [item] = payload.items;
  const graph = payload.graph;
  const source = item.gt_source;
  const original = source ? convertGT(source) : undefined;
  const ids = new Map();
  const collections = [
    ['P', graph.entities], ['W', item.segments], ['F', graph.facts], ['E', graph.events],
    ['S', graph.emotion_states], ['T', graph.emotion_transitions],
  ];
  const stateChanges = graph.links.filter(link => link.type === 'transitions_to');
  const transitionPairs = new Set(graph.emotion_transitions.map(row => keyOf(row.from_state_id, row.to_state_id)));
  const addedTransitions = stateChanges.filter(link => !transitionPairs.has(keyOf(link.from_id, link.to_id)));
  collections.at(-1)[1] = [...graph.emotion_transitions, ...addedTransitions];
  const requireText = (value, label) => {
    if (!value?.trim()) throw new Error(`${label} 不能为空，请补全后导出 GT`);
    return value;
  };
  const requireRows = (rows, label) => {
    if (!rows.length) throw new Error(`${label} 至少需要一项，请补全后导出 GT`);
    return rows;
  };
  for (const [prefix, rows] of collections) {
    const valid = new RegExp(`^${prefix}[0-9]{3,}$`);
    const taken = new Set();
    for (const row of rows) {
      const preferred = item.gt_node_ids?.[row.id] ?? row.id;
      if (valid.test(preferred) && !taken.has(preferred)) {
        ids.set(row.id, preferred);
        taken.add(preferred);
      }
    }
    let number = 1;
    for (const row of rows) {
      if (ids.has(row.id)) continue;
      let id;
      do { id = prefix + String(number++).padStart(3, '0'); } while (taken.has(id));
      ids.set(row.id, id);
      taken.add(id);
    }
  }
  const availableIDs = new Set(ids.values());
  const mapped = values => unique(values.map(id => ids.get(id)).filter(Boolean));
  const oldRefs = values => (values ?? []).filter(id => availableIDs.has(id));
  const incoming = new Map();
  for (const link of graph.links) {
    const key = keyOf(link.to_type, link.to_id);
    if (!incoming.has(key)) incoming.set(key, []);
    incoming.get(key).push(link);
  }
  const edges = (type, id) => incoming.get(keyOf(type, id)) ?? [];
  const originalSubject = byID(source?.subjects ?? []);
  const originalEvidence = byID(source?.evidence ?? []);
  const originalFacts = byID(source?.facts ?? []);
  const originalEvents = byID(source?.events ?? []);
  const originalStates = byID(source?.emotion_states ?? []);
  const originalLinks = new Map((original?.graph.links ?? []).map(link => [
    JSON.stringify([link.from_id, link.to_id, link.type]), link,
  ]));
  const originalInfluences = new Map((source?.event_influences ?? []).map(row => [keyOf(row.event_id, row.target_id), row]));

  const subjects = graph.entities.map(row => ({
    ...originalSubject.get(ids.get(row.id)), id: ids.get(row.id),
    name: requireText(row.name, '主体名称'), aliases: row.aliases,
    identity_evidence_ids: mapped(graph.mentions.filter(mention => mention.entity_id === row.id)
      .map(mention => evidenceID(mention.evidence_id))),
  }));
  const evidence = item.segments.map(row => {
    const id = ids.get(row.id);
    const old = originalEvidence.get(id);
    const oldSegment = original?.items[0].segments.find(segment => segment.id === id);
    const annotation = row.annotations;
    const modality = old && oldSegment?.label === row.label ? old.modality : channel[row.label];
    if (!modality) throw new Error(`证据 ${id} 需要选择视觉、言语或声学类别后才能导出 GT`);
    const result = {
      ...old, id, time_range: range(row.start_time, row.end_time), modality,
      subject_ids: mapped(annotation.subject_ids ?? [annotation.subject_id]),
      content: requireText(annotation.observation || annotation.local_fact, `证据 ${id} 的内容`),
    };
    delete result.speaker_id;
    if (ids.has(annotation.speaker_id)) result.speaker_id = ids.get(annotation.speaker_id);
    if (old?.mentioned_subject_ids) result.mentioned_subject_ids = oldRefs(old.mentioned_subject_ids);
    return result;
  });
  const facts = graph.facts.map(row => {
    const id = ids.get(row.id);
    const old = originalFacts.get(id);
    const times = requireRows(payload.derived.fact_temporal[row.id]?.occurrence?.time_ranges ?? [], `事实 ${id} 的时间窗`);
    const result = {
      ...old, id, time_ranges: times.map(time => range(time.start_time - item.time_offset_s, time.end_time - item.time_offset_s)),
      subject_ids: mapped(row.subject_ids), kind: row.kind, text: requireText(row.text, `事实 ${id} 的内容`),
      evidence_ids: requireRows(mapped(edges('fact', row.id).map(link => evidenceID(link.from_id))), `事实 ${id} 的证据`),
    };
    delete result.speaker_id;
    if (ids.has(row.speaker_id)) result.speaker_id = ids.get(row.speaker_id);
    if (old?.mentioned_subject_ids) result.mentioned_subject_ids = oldRefs(old.mentioned_subject_ids);
    const timeNote = row.time_note?.trim();
    const originalNote = [old?.temporal_context?.mode, old?.temporal_context?.story_time].filter(Boolean).join(' · ');
    if ((timeNote ?? '') !== originalNote) {
      delete result.temporal_context;
      if (timeNote) {
        const [mode, ...story] = timeNote.split(' · ');
        result.temporal_context = ['current','flashback','recounted','hypothetical'].includes(mode)
          ? { mode, ...(story.length ? { story_time: story.join(' · ') } : {}) }
          : { mode: old?.temporal_context?.mode ?? 'current', story_time: timeNote };
      }
    }
    return result;
  });
  const members = eventID => mapped(edges('event', eventID).filter(link => link.from_type === 'fact').map(link => link.from_id));
  const events = graph.events.map(row => {
    const id = ids.get(row.id);
    const old = originalEvents.get(id);
    const subevents = edges('event', row.id).filter(link => link.from_type === 'event').map(link => link.from_id);
    const inherited = new Set(subevents.flatMap(members));
    return {
      ...old, id, description: requireText(row.title, `事件 ${id} 的描述`), subject_ids: mapped(row.subject_ids),
      fact_ids: members(row.id).filter(fact => !inherited.has(fact) || old?.fact_ids.includes(fact)),
      subevent_ids: mapped(subevents),
    };
  });
  const emotion_states = graph.emotion_states.map(row => {
    const id = ids.get(row.id);
    const old = originalStates.get(id);
    const stateLinks = edges('emotion_state', row.id);
    const event_supports = [];
    for (const link of stateLinks.filter(link => link.from_type === 'event')) {
      const event_id = ids.get(link.from_id);
      const support = old?.event_supports.find(entry => entry.event_id === event_id);
      const wasInfluence = originalInfluences.has(keyOf(event_id, id));
      if (!support && (wasInfluence || link.type !== 'associated_with')) continue;
      const candidates = members(link.from_id);
      const fact_ids = support ? support.fact_ids.filter(fact => candidates.includes(fact)) : candidates;
      if (fact_ids.length && !event_supports.some(entry => entry.event_id === event_id)) event_supports.push({ event_id, fact_ids });
    }
    const result = {
      ...old, id, subject_id: requireText(ids.get(row.subject_id), `状态 ${id} 的主体`),
      label: requireText(row.label, `状态 ${id} 的标签`),
      time_range: range(row.start_time - item.time_offset_s, row.end_time - item.time_offset_s),
      fact_ids: mapped(stateLinks.filter(link => link.from_type === 'fact').map(link => link.from_id)),
      event_supports: originalOrder(event_supports, old?.event_supports ?? [], row => row.event_id),
    };
    delete result.intensity;
    if (row.intensity !== null) result.intensity = row.intensity;
    if (!result.fact_ids.length && !event_supports.length) throw new Error(`状态 ${id} 缺少事实或事件支持`);
    return result;
  });
  const stateIndex = byID(graph.emotion_states);
  const emotion_transitions = [
    ...graph.emotion_transitions.map(row => ({
      id: ids.get(row.id), subject_id: requireText(ids.get(row.subject_id), `转折 ${ids.get(row.id)} 的主体`),
      from_state_id: requireText(ids.get(row.from_state_id), '前态'), to_state_id: requireText(ids.get(row.to_state_id), '后态'),
    })),
    ...addedTransitions.map(link => ({
      id: ids.get(link.id), subject_id: requireText(ids.get(stateIndex.get(link.from_id)?.subject_id), '转折主体'),
      from_state_id: ids.get(link.from_id), to_state_id: ids.get(link.to_id),
    })),
  ];
  const influences = new Map();
  function addInfluence(event, target, type, relation, basis, facts) {
    const event_id = ids.get(event), target_id = ids.get(target);
    const key = keyOf(event_id, target_id);
    if (influences.has(key)) return;
    const old = originalInfluences.get(key);
    const candidates = members(event);
    const fact_ids = old ? old.fact_ids.filter(id => candidates.includes(id)) : facts ?? candidates;
    influences.set(key, {
      event_id, target_type: type, target_id,
      relation: relation === 'causes' ? 'influences' : relation,
      fact_ids: requireRows(fact_ids, `关系 ${event_id} → ${target_id} 的支撑事实`),
      basis: requireText(basis, `关系 ${event_id} → ${target_id} 的判断依据`),
    });
  }
  for (const link of graph.links) {
    if (link.from_type !== 'event' || !['emotion_state', 'emotion_transition'].includes(link.to_type)) continue;
    const event = ids.get(link.from_id), target = ids.get(link.to_id);
    const old = originalInfluences.get(keyOf(event, target));
    const oldLink = originalLinks.get(JSON.stringify([event, target, link.type]));
    const support = originalStates.get(target)?.event_supports.some(entry => entry.event_id === event);
    if (link.type === 'associated_with' && support && old?.relation !== 'associated_with') continue;
    const basis = old && oldLink?.note === link.note ? old.basis : link.note;
    if (link.type === 'associated_with' && !basis?.trim() && link.to_type === 'emotion_state') continue;
    addInfluence(link.from_id, link.to_id, link.to_type, link.type, basis);
  }
  const transitionByPair = new Map([...graph.emotion_transitions.map(row => [keyOf(row.from_state_id, row.to_state_id), row.id]),
    ...addedTransitions.map(link => [keyOf(link.from_id, link.to_id), link.id])]);
  for (const link of stateChanges) {
    const target = transitionByPair.get(keyOf(link.from_id, link.to_id));
    for (const ref of link.content_refs ?? []) {
      if (ref.node_type !== 'event') throw new Error('GT 的转折影响关系需要引用复合事件，请将直接证据或事实归入事件后导出');
      addInfluence(ref.node_id, target, 'emotion_transition', ref.relation, ref.note || link.note);
    }
  }

  const duration_s = item.duration_s ?? item.media?.duration_s;
  if (!Number.isFinite(duration_s) || duration_s <= 0) throw new Error('请选择本地音视频以确认素材时长');
  const video = source ? { ...source.video } : {
    video_id: item.media_path.replaceAll('\\', '/').split('/').pop(), duration_s,
    coverage: [range(0, duration_s)],
    available_channels: unique(evidence.map(row => row.modality)),
    annotation_language: 'zh',
  };
  requireRows(video.available_channels, '素材通道');
  if (source) video.available_channels = unique([...source.video.available_channels, ...evidence.map(row => row.modality)]);
  const result = {
    schema_version: 'trace-label/1.0', video, subjects, evidence, facts, events, emotion_states, emotion_transitions,
    event_influences: originalOrder([...influences.values()], source?.event_influences ?? [], row => keyOf(row.event_id, row.target_id)),
  };
  if (source?.ambiguities) result.ambiguities = source.ambiguities
    .map(row => ({ ...row, node_ids: oldRefs(row.node_ids) })).filter(row => row.node_ids.length);
  return result;
}
