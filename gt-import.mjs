import { evidenceKey } from './graph.mjs';

const labels = {
  visual: 'visual_observation', on_screen_text: 'visual_observation',
  speech: 'speech_content', subtitle: 'speech_content', transcript: 'speech_content',
  acoustic: 'acoustic_observation',
};
const lists = ['subjects', 'evidence', 'facts', 'events', 'emotion_states', 'emotion_transitions', 'event_influences'];
const interval = range => ({ start_time: range.start_s, end_time: range.end_s });
const narrative = row => [row.temporal_context?.mode, row.temporal_context?.story_time].filter(Boolean).join(' · ');

export function convertGT(raw) {
  if (raw.schema_version !== 'trace-label/1.0') throw new Error('不支持此四层 GT 版本');
  for (const key of lists) {
    if (!Array.isArray(raw[key]) || raw[key].some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`四层 GT 的 ${key} 列表无效`);
    }
  }
  const item = raw.video?.video_id;
  const duration = raw.video?.duration_s;
  if (typeof item !== 'string' || !item || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('四层 GT 缺少有效的素材编号或时长');
  }
  const audio = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba)$/i.test(item);
  const links = [];
  const add = (from_type, from_id, to_type, to_id, type, fields = {}) => {
    links.push({ id: `GT-link-${links.length + 1}`, from_type, from_id, to_type, to_id, type, ...fields });
  };
  const entities = raw.subjects.map(row => ({ ...row, item_id: item }));
  const mentions = entities.flatMap(row => (row.identity_evidence_ids ?? []).map(window => ({
    id: `GT-mention-${row.id}-${window}`, entity_id: row.id, evidence_id: evidenceKey(item, window),
    description: '原始 GT 主体身份依据',
  })));
  const segments = raw.evidence.map(row => {
    const label = labels[row.modality] ?? 'other';
    return {
      id: row.id, ...interval(row.time_range),
      label: audio && label === 'visual_observation' ? 'other' : label,
      annotations: {
        subject_ids: row.subject_ids, observation: row.content,
        observation_kind: row.modality === 'speech' ? 'reported_speech' : 'observation',
        ...(row.speaker_id ? { speaker_id: row.speaker_id } : {}),
        evidence_role: 'uncertain',
      },
    };
  });

  const facts = raw.facts.map(row => {
    for (const window of row.evidence_ids) add('evidence', evidenceKey(item, window), 'fact', row.id, 'supports');
    return {
      ...row, item_id: item, timeline_id: item,
      kind: row.kind === 'reported_speech' ? row.kind : 'observation',
      time_ranges: row.time_ranges.map(interval), time_note: narrative(row),
    };
  });
  const eventIndex = new Map(raw.events.map(row => [row.id, row]));
  const memberCache = new Map();
  const pending = new Set();
  function members(id) {
    if (memberCache.has(id)) return memberCache.get(id);
    if (!eventIndex.has(id) || pending.has(id)) throw new Error(`无效或循环的子事件引用 ${id}`);
    pending.add(id);
    const row = eventIndex.get(id);
    const ids = new Set([...row.fact_ids, ...row.subevent_ids.flatMap(members)]);
    pending.delete(id);
    memberCache.set(id, [...ids]);
    return memberCache.get(id);
  }
  const events = raw.events.map(row => {
    for (const fact of members(row.id)) add('fact', fact, 'event', row.id, 'constitutes');
    for (const child of row.subevent_ids) add('event', child, 'event', row.id, 'constitutes');
    return { ...row, title: row.description, item_id: item, timeline_id: item };
  });
  const influences = new Map(raw.event_influences.map(row => [JSON.stringify([row.event_id, row.target_id]), row]));
  const note = (relation, ids, basis) => [relation, ids?.join('、'), basis].filter(Boolean).join(' · ');
  const addInfluence = row => {
    const relation = row.relation === 'influences' && row.basis?.trim() ? 'causes' : row.relation;
    add('event', row.event_id, row.target_type, row.target_id, relation, {
      note: note(row.relation, row.fact_ids, row.basis),
    });
  };
  const emotion_states = raw.emotion_states.map(row => {
    for (const fact of row.fact_ids) add('fact', fact, 'emotion_state', row.id, 'grounds');
    for (const support of row.event_supports) {
      const influence = influences.get(JSON.stringify([support.event_id, row.id]));
      if (!influence) {
        add('event', support.event_id, 'emotion_state', row.id, 'associated_with', {
          note: note('状态支撑事实', support.fact_ids, row.basis),
        });
      }
    }
    return { ...row, ...interval(row.time_range), item_id: item, timeline_id: item };
  });
  for (const influence of raw.event_influences) {
    if (influence.target_type === 'emotion_state') addInfluence(influence);
  }
  for (const row of raw.emotion_transitions) {
    const content_refs = raw.event_influences.filter(influence => influence.target_id === row.id)
      .map(influence => ({ node_type: 'event', node_id: influence.event_id,
        relation: influence.relation, note: influence.basis }));
    links.push({
      id: row.id, from_type: 'emotion_state', from_id: row.from_state_id,
      to_type: 'emotion_state', to_id: row.to_state_id, type: 'transitions_to', content_refs,
    });
  }

  return {
    format: 'trace-annotations', schema_version: '2.0',
    batch_id: 'trace-gt',
    items: [{
      id: item, media_path: item, media_type: audio ? 'audio' : 'video',
      duration_s: duration, segments, gt_source: raw,
    }],
    graph: { entities, mentions, facts, events, emotion_states, emotion_transitions: [], links },
  };
}
