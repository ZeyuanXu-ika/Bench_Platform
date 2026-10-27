import { blankGraph, evidenceKey, MAX_GRAPH_NODES } from './graph.mjs';

// Subject choices follow saved evidence and relations. Derivation never writes a draft.
const unknown = value => /^(unknown|未知|未知主体|不明|待确认)$/i.test(value);
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const identity = (itemID, raw, evidenceID) => JSON.stringify(unknown(raw) ? ['unknown', evidenceID] : ['item', itemID, raw]);
const AUTO_MENTION_PREFIX = '证据标注主体：';

export function createSubjectResolver(ws) {
  const planned = new Map();
  const graph = () => ws.graph || blankGraph();
  function context() {
    const current = graph(), entities = new Map(current.entities.map(entry => [entry.id, entry]));
    const evidence = new Map(), mentions = new Map(), sameClue = new Map(), staleAutoMentions = new Set(), manualMentions = new Map();
    for (const item of ws.manifest?.items || []) for (const segment of ws.records?.[item.id]?.segments || []) {
      const id = evidenceKey(item.id, segment.id), raw = String(segment.annotations?.subject_id || '').trim();
      evidence.set(id, { id, item_id: item.id, raw, canonical: Object.hasOwn(segment.annotations || {}, 'subject_ids') ? segment.annotations.subject_ids : null });
    }
    for (const mention of current.mentions) {
      if (!evidence.has(mention.evidence_id) || !entities.has(mention.entity_id) || mention.description?.startsWith(AUTO_MENTION_PREFIX)) continue;
      if (!manualMentions.has(mention.evidence_id)) manualMentions.set(mention.evidence_id, new Set());
      manualMentions.get(mention.evidence_id).add(mention.entity_id);
    }
    for (const mention of current.mentions) {
      const source = evidence.get(mention.evidence_id);
      if (!source || !entities.has(mention.entity_id)) continue;
      if (mention.description?.startsWith(AUTO_MENTION_PREFIX)) {
        const manual = manualMentions.get(source.id);
        if (source.canonical ? !source.canonical.includes(mention.entity_id) : mention.description !== AUTO_MENTION_PREFIX + source.raw || manual && !manual.has(mention.entity_id)) staleAutoMentions.add(mention.id);
        if (staleAutoMentions.has(mention.id) || manual) continue;
      }
      if (!mentions.has(source.id)) mentions.set(source.id, new Set());
      mentions.get(source.id).add(mention.entity_id);
      if (!source.raw || unknown(source.raw)) continue;
      if (source.canonical !== null && mention.description?.startsWith(AUTO_MENTION_PREFIX) && mention.description !== AUTO_MENTION_PREFIX + source.raw) continue;
      const key = identity(source.item_id, source.raw, source.id);
      if (!sameClue.has(key)) sameClue.set(key, new Set());
      sameClue.get(key).add(mention.entity_id);
    }
    const occupied = new Set(Object.values(current).filter(Array.isArray).flatMap(entries => entries.map(entry => entry.id)));
    const used = new Set(occupied);
    for (const candidate of planned.values()) used.add(candidate.id);
    return { current, entities, evidence, mentions, sameClue, staleAutoMentions, occupied, used };
  }
  function freshID(used) {
    let id;
    do { id = crypto.randomUUID(); } while (used.has(id));
    used.add(id); return id;
  }
  function merge(candidates) {
    const merged = new Map();
    for (const candidate of candidates) {
      const previous = merged.get(candidate.id);
      if (previous) previous.evidence_ids = [...new Set([...previous.evidence_ids, ...candidate.evidence_ids])];
      else merged.set(candidate.id, { ...candidate, aliases: [...candidate.aliases], evidence_ids: [...candidate.evidence_ids] });
    }
    return [...merged.values()];
  }
  function existing(entity, evidenceIDs = []) {
    return { id: entity.id, name: entity.name, aliases: [...(entity.aliases || [])], evidence_ids: evidenceIDs, pending: false };
  }
  function resolveEvidence(evidenceIDs, state) {
    const candidates = [];
    for (const id of new Set(list(evidenceIDs))) {
      const source = state.evidence.get(id); if (!source) continue;
      if (source.canonical !== null) {
        for (const subjectID of source.canonical) { const entity = state.entities.get(subjectID); if (entity) candidates.push(existing(entity, [id])); }
        continue;
      }
      const explicit = state.mentions.get(id);
      if (explicit?.size) {
        for (const entityID of explicit) candidates.push(existing(state.entities.get(entityID), [id]));
        continue;
      }
      if (!source.raw) continue;
      // An explicitly entered canonical ID is authoritative; names and aliases are not.
      const exact = state.entities.get(source.raw);
      if (exact && !unknown(source.raw)) { candidates.push(existing(exact, [id])); continue; }
      const key = identity(source.item_id, source.raw, id), mapped = state.sameClue.get(key);
      if (mapped?.size === 1) { candidates.push(existing(state.entities.get([...mapped][0]), [id])); continue; }
      let candidate = planned.get(key);
      if (!candidate || state.occupied.has(candidate.id)) {
        candidate = { id: freshID(state.used), name: source.raw, aliases: [] };
        planned.set(key, candidate);
      }
      candidates.push({ ...candidate, evidence_ids: [id], pending: true });
    }
    return merge(candidates);
  }
  function fromEvidence(evidenceIDs) { return resolveEvidence(evidenceIDs, context()); }
  function fromFacts(factIDs) {
    const state = context(), ids = new Set(list(factIDs)), candidates = [];
    for (const fact of state.current.facts.filter(entry => ids.has(entry.id))) {
      const saved = new Set([...fact.subject_ids, ...(fact.kind === 'reported_speech' && fact.speaker_id ? [fact.speaker_id] : [])]);
      for (const subjectID of saved) {
        const entity = state.entities.get(subjectID); if (entity) candidates.push(existing(entity));
      }
      const refs = state.current.links.filter(link => link.to_type === 'fact' && link.to_id === fact.id && link.from_type === 'evidence').map(link => link.from_id);
      // A fact may describe only one of the people visible in its evidence.
      // Supporting windows enrich those saved subjects; they do not expand them.
      candidates.push(...resolveEvidence(refs, state).filter(candidate => !fact.subject_ids.length || saved.has(candidate.id)));
    }
    return merge(candidates);
  }
  function fromEvents(eventIDs) {
    const state = context(), ids = new Set(list(eventIDs)), candidates = [];
    for (const event of state.current.events.filter(entry => ids.has(entry.id))) {
      const saved = new Set(event.subject_ids);
      for (const subjectID of saved) { const entity = state.entities.get(subjectID); if (entity) candidates.push(existing(entity)); }
      const refs = state.current.links.filter(link => link.to_type === 'event' && link.to_id === event.id && link.from_type === 'fact').map(link => link.from_id);
      candidates.push(...fromFacts(refs).filter(candidate => !saved.size || saved.has(candidate.id)));
    }
    return merge(candidates);
  }
  function forItem(itemID) {
    const state = context();
    return resolveEvidence([...state.evidence.values()].filter(entry => entry.item_id === itemID).map(entry => entry.id), state);
  }
  function commit(candidates) {
    const state = context(), additions = [], mentions = [], chosen = merge(list(candidates));
    const chosenEvidence = new Set(chosen.flatMap(candidate => candidate.evidence_ids));
    const removed = new Set(state.current.mentions.filter(mention => state.staleAutoMentions.has(mention.id) && chosenEvidence.has(mention.evidence_id)).map(mention => mention.id));
    for (const candidate of chosen) {
      if (!state.entities.has(candidate.id)) {
        const plan = [...planned.values()].find(entry => entry.id === candidate.id);
        if (!candidate.pending || !plan || !candidate.evidence_ids.length) throw new Error('主体依据已变化，请重新选择证据');
        additions.push({ id: plan.id, name: plan.name, aliases: [...plan.aliases] });
      }
      for (const evidenceID of candidate.evidence_ids) {
        const current = resolveEvidence([evidenceID], state);
        if (!current.some(entry => entry.id === candidate.id)) throw new Error('证据主体已变化，请重新选择依据');
        if (state.current.mentions.some(entry => !removed.has(entry.id) && entry.entity_id === candidate.id && entry.evidence_id === evidenceID)) continue;
        const source = state.evidence.get(evidenceID);
        mentions.push({ id: freshID(state.used), entity_id: candidate.id, evidence_id: evidenceID, description: AUTO_MENTION_PREFIX + (source.raw || candidate.name) });
      }
    }
    const count = ['entities', 'mentions', 'facts', 'events', 'emotion_states', 'emotion_transitions'].reduce((sum, collection) => sum + state.current[collection].length, 0);
    if (count - removed.size + additions.length + mentions.length > MAX_GRAPH_NODES) throw new Error('图谱节点总数超过 10000，请拆分项目');
    if (!additions.length && !mentions.length && !removed.size) return false;
    if (!ws.graph) ws.graph = blankGraph();
    if (removed.size) ws.graph.mentions = ws.graph.mentions.filter(mention => !removed.has(mention.id));
    ws.graph.entities.push(...additions); ws.graph.mentions.push(...mentions); return true;
  }
  return { fromEvidence, fromFacts, fromEvents, forItem, commit };
}
