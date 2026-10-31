import { evidenceKey, MAX_GRAPH_NODES } from './graph.mjs';
import { createSubjectResolver } from './subject-lineage.mjs';
import { nextAnnotationId } from './graph.mjs';
import { getEvidenceFact, saveEvidenceFact, setEvidenceSubjects } from './evidence-fact.mjs';

const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const sameIDs = (left, right) => left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
const reviews = new Set(['draft', 'needs_review', 'confirmed']);

// The media player stays mounted. This controller updates only the selected evidence form.
export function mountEvidenceEditor({ getWorkspace, getItem, getSegment, changed, persist, notify, onSaved, validateSave }) {
  const $ = id => document.getElementById(id), drafts = new Map(), inventories = new Map();
  let resolverWorkspace = null, resolver = null, renderedKey = '';
  let autoTimer=null;
  function scheduleAuto(){clearTimeout(autoTimer);const current=workspace(),item=getItem(),segment=getSegment();if(!current||!item||!segment)return;const itemID=item.id,segmentID=segment.id;
    autoTimer=setTimeout(async()=>{if(workspace()!==current)return;const target=current.records[itemID]?.segments.find(s=>s.id===segmentID);if(!target)return;const before=snapshot(current);
      try{if(target.annotations.observation?.trim() && selectedIDs(itemID,segmentID).length){const result=saveOne(itemID,segmentID);if(result.modified)changed(false);}await persist();if(isCurrent(current,itemID,segmentID))report('已自动保存');}
      catch(error){restore(current,before);await persist();if(isCurrent(current,itemID,segmentID))report(error.code==='TEMPORAL_ORDER'?error.message:'已保留草稿',error.code==='TEMPORAL_ORDER'?'error':'pending');}
    },650);
  }
  function workspace() {
    const ws = getWorkspace();
    if (ws && ws !== resolverWorkspace) { drafts.clear();inventories.clear();renderedKey='';resolverWorkspace = ws; resolver = createSubjectResolver(ws); }
    return ws;
  }
  const key = (itemID, segmentID) => JSON.stringify([workspace()?.id, itemID, segmentID]);
  const isCurrent = (ws, itemID, segmentID) => getWorkspace() === ws && getItem()?.id === itemID && getSegment()?.id === segmentID;
  function evidenceSubjects(itemID, segmentID) { return resolver.fromEvidence([evidenceKey(itemID, segmentID)]); }
  function selectedIDs(itemID, segmentID) {
    const ws = workspace(), segment = ws.records[itemID].segments.find(entry => entry.id === segmentID);
    return Object.hasOwn(segment.annotations, 'subject_ids') ? [...segment.annotations.subject_ids] : evidenceSubjects(itemID, segmentID).map(entry => entry.id);
  }
  function description(segment, fact) {
    if (segment.annotations.fact_id) return segment.annotations.observation || '';
    return segment.annotations.observation || fact?.text || segment.annotations.local_fact || '';
  }
  function draftFor(itemID, segmentID) {
    const ws = workspace(), fact = getEvidenceFact(ws, itemID, segmentID), draftKey = key(itemID, segmentID);
    const source=ws.records[itemID].segments.find(segment=>segment.id===segmentID).annotations;
    const baseline = JSON.stringify([source.observation_kind || fact?.kind || 'observation',source.speaker_id ?? fact?.speaker_id ?? '',fact?.review_status || 'needs_review']);
    let draft = drafts.get(draftKey);
    if (!draft || (!draft.dirty && draft.baseline !== baseline)) {
      draft = { kind: source.observation_kind || fact?.kind || 'observation', speaker_id: source.speaker_id ?? fact?.speaker_id ?? '', review_status: fact?.review_status || 'needs_review', baseline, dirty: false, subjectsChanged: false };
      drafts.set(draftKey, draft);
    }
    return draft;
  }
  function inventory(itemID, segmentID) {
    const ws = workspace(), item = ws.manifest.items.find(entry => entry.id === itemID), cacheKey = JSON.stringify([ws.id, itemID]);
    if (!inventories.has(cacheKey)) inventories.set(cacheKey, new Map());
    const cache = inventories.get(cacheKey), candidates = [...resolver.forItem(itemID), ...evidenceSubjects(itemID, segmentID)];
    for (const id of item.subject_ids || []) {
      const entity = ws.graph.entities.find(entry => entry.id === id);
      if (entity) candidates.push({ ...entity, evidence_ids: [], pending: false });
    }
    for (const candidate of candidates) cache.set(candidate.id, candidate);
    const selected = new Set(selectedIDs(itemID, segmentID)), entities = new Set(ws.graph.entities.map(entry => entry.id));
    return [...cache.values()].filter(candidate => entities.has(candidate.id) || candidate.pending && selected.has(candidate.id));
  }
  function registerSelected(itemID, segmentID, ids) {
    const candidates = evidenceSubjects(itemID, segmentID);
    return resolver.commit(candidates.filter(candidate => ids.includes(candidate.id)));
  }
  function snapshot(ws) { return structuredClone({ graph: ws.graph, records: ws.records, manifest: ws.manifest }); }
  function restore(ws, before) { Object.assign(ws, before); }
  function report(text, state = '') {
    const status = $('evidence-fact-status'); status.textContent = text; status.className = state;
  }
  function syncSpeaker(itemID, segmentID, draft) {
    const ws = workspace(), ids = selectedIDs(itemID, segmentID), select = $('evidence-fact-speaker');
    const fact = getEvidenceFact(ws, itemID, segmentID);
    if (!draft.subjectsChanged && fact?.speaker_id && draft.speaker_id === fact.speaker_id && !ids.includes(fact.speaker_id)) ids.push(fact.speaker_id);
    select.replaceChildren();
    const placeholder = node('option', '', ids.length ? '请选择发言者' : '请先选择主体'); placeholder.value = ''; select.append(placeholder);
    for (const id of ids) {
      const entity = ws.graph.entities.find(entry => entry.id === id) || evidenceSubjects(itemID, segmentID).find(entry => entry.id === id);
      const option = node('option', '', entity?.name || id); option.value = id; select.append(option);
    }
    if (!ids.includes(draft.speaker_id)) draft.speaker_id = ids.length === 1 ? ids[0] : '';
    select.value = draft.speaker_id;
    $('evidence-fact-speaker-field').hidden = draft.kind !== 'reported_speech';
  }
  function renderStatus(itemID, segmentID) {
    const ws = workspace(), segment = ws.records[itemID].segments.find(entry => entry.id === segmentID), fact = getEvidenceFact(ws, itemID, segmentID), draft = draftFor(itemID, segmentID);
    if (!fact) { report('草稿', 'pending'); return; }
    const ids = selectedIDs(itemID, segmentID);
    report(draft.dirty ? '草稿' : '已保存', draft.dirty ? 'pending' : '');
  }

  function markPending(itemID, segmentID, subjectsChanged = false) {
    const draft = draftFor(itemID, segmentID); draft.dirty = true; draft.review_status = 'needs_review';
    if (subjectsChanged) draft.subjectsChanged = true;
    $('evidence-fact-review').value = 'needs_review';
    scheduleAuto();
  }
  function renderSubjects(itemID, segmentID) {
    const subjects = inventory(itemID, segmentID), selected = new Set(selectedIDs(itemID, segmentID)), container = $('evidence-subjects');
    container.replaceChildren(); $('evidence-subject-count').textContent = `已选 ${selected.size}`;
    const names = new Map(); for (const subject of subjects) names.set(subject.name, (names.get(subject.name) || 0) + 1);
    for (const subject of subjects) {
      const label = node('label', 'evidence-subject-choice' + (selected.has(subject.id) ? ' selected' : '')), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.value = subject.id; checkbox.checked = selected.has(subject.id); checkbox.setAttribute('aria-label', subject.name);
      const description = node('span'); description.append(node('strong', '', subject.name));
      if (names.get(subject.name) > 1) description.append(node('small', '', `独立主体 · ${subject.id.slice(0, 8)}`));
      label.append(checkbox, description); container.append(label);
      checkbox.addEventListener('change', async () => {
        const ws = workspace(), before = snapshot(ws);
        try {
          const ids = selectedIDs(itemID, segmentID).filter(id => id !== subject.id); if (checkbox.checked) ids.push(subject.id);
          registerSelected(itemID, segmentID, ids);
          if (setEvidenceSubjects(ws, itemID, segmentID, ids)) { markPending(itemID, segmentID, true); changed(false); await persist(); }
          if (isCurrent(ws, itemID, segmentID)) { renderSubjects(itemID, segmentID); syncSpeaker(itemID, segmentID, draftFor(itemID, segmentID)); renderStatus(itemID, segmentID); }
        } catch (error) { restore(ws, before); render(); notify(error.message, true); }
      });
    }
    if (!subjects.length) container.append(node('p', 'evidence-subject-empty', '暂无主体'));
  }
  function render() {
    const ws = workspace(), item = getItem(), segment = getSegment(); if (!ws || !item || !segment) return;
    const nextKey = key(item.id, segment.id); if (nextKey !== renderedKey) { $('evidence-new-subject-name').value = ''; renderedKey = nextKey; }
    const fact = getEvidenceFact(ws, item.id, segment.id), draft = draftFor(item.id, segment.id);
    $('observation').value = description(segment, fact);
    $('evidence-fact-kind').value = draft.kind; $('evidence-fact-review').value = draft.review_status;
    renderSubjects(item.id, segment.id); syncSpeaker(item.id, segment.id, draft);
    const legacy = segment.annotations.local_fact || '';
    $('evidence-legacy-fact').hidden = !legacy || legacy === $('observation').value;
    $('evidence-legacy-fact-text').textContent = legacy;
    renderStatus(item.id, segment.id);
  }
  function saveOne(itemID, segmentID) {
    validateSave?.(itemID, segmentID);
    const ws = workspace(), segment = ws.records[itemID].segments.find(entry => entry.id === segmentID), fact = getEvidenceFact(ws, itemID, segmentID), draft = draftFor(itemID, segmentID), ids = selectedIDs(itemID, segmentID);
    registerSelected(itemID, segmentID, ids);
    const factSubjects = fact && !draft.subjectsChanged ? fact.subject_ids : ids;
    const result = saveEvidenceFact(ws, itemID, segmentID, { text: description(segment, fact), subject_ids: factSubjects, evidence_subject_ids: ids, kind: draft.kind, speaker_id: draft.speaker_id, review_status: reviews.has(draft.review_status) ? draft.review_status : 'needs_review' });
    drafts.delete(key(itemID, segmentID)); return result;
  }
  async function saveCurrent() {
    const ws = workspace(), item = getItem(), segment = getSegment(); if (!ws || !item || !segment) throw new Error('请先选择一个证据时间窗');
    const before = snapshot(ws);
    try {
      const result = saveOne(item.id, segment.id);
      if (result.modified || JSON.stringify(before.graph) !== JSON.stringify(ws.graph)) changed(false);
      await persist();
      if (isCurrent(ws, item.id, segment.id)) { render(); onSaved?.(); report('证据已保存，可继续标注本页或整理复合事件。'); }
      notify('证据已保存'); return result;
    } catch (error) { restore(ws, before); report(error.message, 'error'); throw error; }
  }
  function saveAll(itemID) {
    const ws = workspace(), before = snapshot(ws), draftBackup = new Map([...drafts].map(([id, entry]) => [id, { ...entry }]));
    try {
      let modified = false;
      for (const segment of [...ws.records[itemID].segments]) modified = saveOne(itemID, segment.id).modified || modified;
      return modified;
    } catch (error) { restore(ws, before); drafts.clear(); for (const [id, entry] of draftBackup) drafts.set(id, entry); throw error; }
  }
  $('evidence-add-subject').addEventListener('click', async () => {
    const ws = workspace(), item = getItem(), segment = getSegment(); if (!ws || !item || !segment) return notify('请先选择一个证据时间窗', true);
    const name = $('evidence-new-subject-name').value.trim();
    if (!name || name.length > 500) return notify('请填写长度不超过 500 的主体名称', true);
    const count = ['entities', 'mentions', 'facts', 'events', 'emotion_states', 'emotion_transitions'].reduce((total, collection) => total + ws.graph[collection].length, 0);
    if (count >= MAX_GRAPH_NODES) return notify('主体及图谱节点过多，请拆分项目', true);
    const before = snapshot(ws);
    try {
      const ids = selectedIDs(item.id, segment.id); registerSelected(item.id, segment.id, ids);
      const entity = { id: nextAnnotationId(ws, 'entity'), name, aliases: [], item_id:item.id }; ws.graph.entities.push(entity);
      setEvidenceSubjects(ws, item.id, segment.id, [...ids, entity.id]);
      $('evidence-new-subject-name').value = ''; markPending(item.id, segment.id, true); changed(false); await persist(); render();
    } catch (error) { restore(ws, before); render(); notify(error.message, true); }
  });
  $('evidence-new-subject-name').addEventListener('keydown', event => {if(event.isComposing)return;if(event.key === 'Enter') { event.preventDefault(); $('evidence-add-subject').click(); }else if(event.key==='Backspace'&&!event.currentTarget.value){event.preventDefault();const item=getItem(),segment=getSegment();if(!item||!segment)return;setEvidenceSubjects(workspace(),item.id,segment.id,selectedIDs(item.id,segment.id).slice(0,-1));changed(false);persist();render();} });
  $('observation').addEventListener('input', () => {
    const segment = getSegment(), item = getItem(); if (!segment || !item || segment.annotations.observation === $('observation').value) return;
    segment.annotations.observation = $('observation').value; markPending(item.id, segment.id); changed(); onSaved?.(); renderStatus(item.id, segment.id);
  });
  $('observation').addEventListener('change', () => persist());
  for (const id of ['evidence-fact-kind', 'evidence-fact-speaker', 'evidence-fact-review']) $(id).addEventListener('change', () => {
    const item = getItem(), segment = getSegment(); if (!item || !segment) return;
    const draft = draftFor(item.id, segment.id);
    if (id === 'evidence-fact-kind') { draft.kind = $(id).value; markPending(item.id, segment.id); }
    else if (id === 'evidence-fact-speaker') { draft.speaker_id = $(id).value; markPending(item.id, segment.id); }
    else { draft.review_status = $(id).value; draft.dirty = true; }
    segment.annotations.observation_kind=draft.kind;segment.annotations.speaker_id=draft.speaker_id;persist();scheduleAuto();
    syncSpeaker(item.id, segment.id, draft); renderStatus(item.id, segment.id);
  });
  return { render, saveCurrent, saveAll, resetCurrent() { const item = getItem(), segment = getSegment(); if (item && segment) drafts.delete(key(item.id, segment.id)); }, hasUnsavedChanges() {
    const ws = getWorkspace();
    return [...drafts].some(([id, draft]) => { const [workspaceID, itemID, segmentID] = JSON.parse(id); return workspaceID === ws?.id && draft.dirty && ws.records[itemID]?.segments.some(segment => segment.id === segmentID); });
  } };
}
