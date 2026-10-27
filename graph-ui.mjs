import { blankGraph, evidenceNodes, evidenceBounds, normalizeGraph, graphIssues, invalidateEvidence, removeGraphNode } from './graph.mjs';
import { graphViewLinks, projectGraphView, serializeFullGraphSVG } from './graph-view.mjs';
import { createSubjectResolver } from './subject-lineage.mjs';
import { setEvidenceSubjects } from './evidence-fact.mjs';

const STAGES = [['evidence', '证据与事实'], ['facts', '事实汇总'], ['events', '复合事件'], ['emotions', '情感脉络'], ['graph', '关联图谱']];
const COLLECTION = { entity: 'entities', mention: 'mentions', fact: 'facts', event: 'events', emotion_state: 'emotion_states', emotion_transition: 'emotion_transitions' };
const TYPE_NAME = { evidence: '证据', entity: '主体', mention: '提及', fact: '事实', event: '复合事件', emotion_state: '情感状态', emotion_transition: '情感变化' };
const RELATION_NAME = { supports: '支持', constitutes: '构成', grounds: '情感判断依据', associated_with: '关联', causes: '导致（人工判断）' };
const REVIEW_NAME = { draft: '草稿', needs_review: '待复核', confirmed: '已人工确认' };
const node = (tag, className, content) => { const value = document.createElement(tag); if (className) value.className = className; if (content !== undefined) value.textContent = content; return value; };
const button = (text, action, className = 'g-button') => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; };
const short = (text, length = 55) => String(text || '').length > length ? String(text).slice(0, length) + '…' : String(text || '');
const numberText = value => Number.isFinite(value) ? `${Math.round(value * 1000) / 1000}s` : '—';
const rangeText = value => value ? `${numberText(value.start_time)} → ${numberText(value.end_time)}` : '尚未关联时间范围';

export function mountGraphWorkbench(root, { getWorkspace, changed, navigateEvidence, onFactSaved }) {
  root.classList.add('graph-workbench');
  let activeStage = 'evidence';
  let graphFit = true;
  let graphPage = 0;
  const selected = { entity: '', mention: '', fact: '', event: '', emotion_state: '', emotion_transition: '' };
  let factSeed = null, graphFocus = null, showManagement = false;
  let subjectWorkspace = null, subjects = null;
  const fieldDrafts = new Map(), fieldBaselines = new Map(), dirtyFields = new Set(); let renderedContext = null, savingContext = null;
  const controlSignature = element => JSON.stringify(element.multiple ? [...element.selectedOptions].map(option => option.value) : element.value);
  function draftKey(element, context) {
    const prefix = element.id.startsWith('g-fact-') ? 'fact' : element.id.startsWith('g-event-') ? 'event' : element.id.startsWith('g-state-') ? 'emotion_state' : element.id.startsWith('g-transition-') ? 'emotion_transition' : element.id.startsWith('g-entity-') ? 'entity' : element.id.startsWith('g-mention-') ? 'mention' : 'alignment';
    return JSON.stringify([context.workspace, prefix, context.selected[prefix] || '', element.dataset.itemId || (!context.selected[prefix] && ['fact', 'event', 'emotion_state', 'emotion_transition'].includes(prefix) ? context.itemID || '' : ''), element.id]);
  }
  function captureFields() {
    if (!renderedContext) return;
    for (const element of body.querySelectorAll('input[id],select[id],textarea[id]')) {
      const key = draftKey(element, renderedContext), current = element.multiple ? [...element.selectedOptions].map(option => option.value) : element.value;
      fieldDrafts.set(key, current);
      if (element.dataset.graphFilter || !fieldBaselines.has(key)) continue;
      if (JSON.stringify(current) === JSON.stringify(fieldBaselines.get(key))) dirtyFields.delete(key); else dirtyFields.add(key);
    }
  }
  function clearFormContext(type, id = '', itemID) {
    if (!id && itemID === undefined && ['fact', 'event', 'emotion_state', 'emotion_transition'].includes(type)) itemID = currentItemID();
    for (const key of fieldDrafts.keys()) { const context = JSON.parse(key); if (context[0] === ws()?.id && context[1] === type && context[2] === id && (itemID === undefined || context[3] === itemID)) { fieldDrafts.delete(key); fieldBaselines.delete(key); dirtyFields.delete(key); } }
  }
  function pruneRemovedContexts() {
    for (const key of fieldDrafts.keys()) { const [, type, id, itemID] = JSON.parse(key); if ((id && COLLECTION[type] && !graph()[COLLECTION[type]].some(entry => entry.id === id)) || (type === 'alignment' && itemID && !ws().manifest.items.some(item => item.id === itemID))) { fieldDrafts.delete(key); fieldBaselines.delete(key); dirtyFields.delete(key); } }
  }
  function recordBaselines(context) {
    for (const element of body.querySelectorAll('input[id],select[id],textarea[id]')) {
      if (element.dataset.graphFilter) continue;
      const key = draftKey(element, context);
      let baseline = element.multiple ? [...element.selectedOptions].map(option => option.value) : element.value;
      if (factSeed && !selected.fact) {
        if (element.id === 'g-fact-text') baseline = '';
        if (element.id === 'g-fact-subjects' || element.id === 'g-fact-evidence') baseline = [];
      }
      const previous = fieldBaselines.get(key);
      if (element.id.endsWith('-review') && previous !== undefined && previous !== baseline && baseline === 'needs_review') { fieldDrafts.delete(key); dirtyFields.delete(key); }
      fieldBaselines.set(key, baseline);
      if (dirtyFields.has(key) && JSON.stringify(fieldDrafts.get(key)) === JSON.stringify(baseline)) dirtyFields.delete(key);
    }
  }
  function updateUnsavedNote() {
    const dirty = dirtyFields.size > 0;
    root.dataset.unsavedChanges = String(dirty); unsavedNote.hidden = !dirty;
    return dirty;
  }
  function restoreFields(context) {
    for (const element of body.querySelectorAll('input[id],select[id],textarea[id]')) {
      const key = draftKey(element, context); let saved = fieldDrafts.get(key);
      if (saved === undefined || (!element.dataset.graphFilter && !dirtyFields.has(key))) continue;
      if (element.matches('select') && element.closest('.g-subject-lineage')) {
        const allowed = [...element.options].map(option => option.value).filter(Boolean);
        if (element.multiple) {
          saved = saved.filter(id => allowed.includes(id));
          if (!saved.length && allowed.length === 1) saved = [allowed[0]];
        } else if (!allowed.includes(saved)) saved = allowed.length === 1 ? allowed[0] : '';
      }
      if (element.multiple) { for (const option of element.options) option.selected = saved.includes(option.value); element.dispatchEvent(new Event('graph:sync-options')); }
      else { const previous = element.value; element.value = saved; if (element.id === 'g-transition-subject' && previous !== saved) element.dispatchEvent(new Event('change', { bubbles: true })); }
      if (element.dataset.graphFilter) element.dispatchEvent(new Event('graph:sync-filter'));
      if (element.dataset.graphTracked !== undefined) element.dataset.graphTracked = controlSignature(element);
    }
  }
  const heading = node('div', 'g-heading');
  heading.append(node('strong', '', '四层标注工作台'));
  const unsavedNote = node('span', 'g-unsaved-note', '表单尚未保存'); unsavedNote.hidden = true; heading.append(unsavedNote);
  const status = node('span', 'g-status'); heading.append(status);
  const tabs = node('nav', 'g-tabs'); tabs.setAttribute('aria-label', '标注阶段');
  const feedback = node('p', 'g-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  const body = node('div', 'g-body');
  root.replaceChildren(heading, tabs, feedback, body);
  const observeFields = () => { captureFields(); updateUnsavedNote(); };
  root.addEventListener('input', observeFields); root.addEventListener('change', observeFields);
  root.addEventListener('click', () => queueMicrotask(observeFields));
  const ws = () => getWorkspace();
  const graph = () => ws().graph;
  const evidence = () => evidenceNodes(ws());
  const find = (type, id) => type === 'evidence' ? evidence().find(value => value.id === id) : (graph()[COLLECTION[type]] || []).find(value => value.id === id);
  const values = id => [...root.querySelectorAll(`#${id} option:checked`)].map(option => option.value);
  const value = id => root.querySelector(`#${id}`)?.value || '';
  const report = (text, error = false) => { feedback.textContent = text; feedback.hidden = !text; feedback.classList.toggle('error', error); };
  const linksTo = (toType, toID, fromType) => graph().links.filter(link => link.to_type === toType && link.to_id === toID && (!fromType || link.from_type === fromType));
  const entityName = id => find('entity', id)?.name || id || '未指定主体';
  const currentItemID = () => ws()?.manifest.items[ws().index || 0]?.id || '';
  const formContext = () => ({ workspace: ws().id, itemID: currentItemID(), selected: { ...selected } });
  const taskSubjects = () => subjects.forItem(currentItemID());
  function mergeSubjects(...lists) {
    const merged = new Map();
    for (const candidate of lists.flat()) {
      const previous = merged.get(candidate.id);
      merged.set(candidate.id, previous ? { ...previous, evidence_ids: [...new Set([...previous.evidence_ids, ...candidate.evidence_ids])] } : candidate);
    }
    return [...merged.values()];
  }
  const savedSubjects = ids => (ids || []).flatMap(id => { const entity = find('entity', id); return entity ? [{ ...entity, evidence_ids: [], pending: false }] : []; });
  const MODALITY_NAME = { visual_observation: '视觉观察', speech_content: '言语内容', acoustic_observation: '声学观察', other: '其他证据', unclassified: '待分类' };
  const evidenceLabel = entry => `${entry.title || entry.item_id} · ${MODALITY_NAME[entry.modality] || '证据'} · 局部 ${numberText(entry.start_time)}–${numberText(entry.end_time)} · 共同 ${numberText(entry.global_start_time)}–${numberText(entry.global_end_time)} @ ${entry.timeline_id}`;
  function labelFor(type, id) {
    const entry = find(type, id);
    if (!entry) return `已失效的${TYPE_NAME[type] || type}`;
    if (type === 'evidence') return evidenceLabel(entry);
    if (type === 'entity') return entry.name;
    if (type === 'fact') return entry.text || '未填写事实';
    if (type === 'event') return entry.title || '未填写事件';
    if (type === 'emotion_state') return `${entityName(entry.subject_id)} · ${entry.label} · ${rangeText(entry)}`;
    if (type === 'emotion_transition') return `${entityName(entry.subject_id)} · ${find('emotion_state', entry.from_state_id)?.label || '?'} → ${find('emotion_state', entry.to_state_id)?.label || '?'}`;
    return entry.description || entry.id;
  }
  function field(text, element, hint = '') {
    const grouped = element.classList.contains('g-choice-picker') || element.classList.contains('g-subject-lineage');
    const label = node(grouped ? 'div' : 'label', 'g-field');
    const caption = node('span', 'g-field-label', text);
    if (grouped) { caption.id = `${element.dataset.controlId}-caption`; label.setAttribute('role', 'group'); label.setAttribute('aria-labelledby', caption.id); }
    label.append(caption, element);
    if (hint) label.append(node('small', 'g-hint', hint));
    return label;
  }
  function input(id, initial = '', type = 'text') {
    const element = node('input'); element.id = id; element.type = type; element.value = initial ?? '';
    element.maxLength = 20000; if (type === 'number') element.step = '0.001';
    return element;
  }
  function textarea(id, initial = '', rows = 4) { const element = node('textarea'); element.id = id; element.value = initial || ''; element.rows = rows; element.maxLength = 20000; return element; }
  function select(id, options, initial = '', multiple = false) {
    const element = node('select'); element.id = id; element.multiple = multiple;
    const initiallySelected = new Set(multiple ? initial || [] : []);
    if (multiple) element.size = Math.min(7, Math.max(3, options.length));
    for (const option of options) {
      const item = node('option', '', option.label); item.value = option.value;
      item.selected = multiple ? initiallySelected.has(option.value) : option.value === initial;
      element.append(item);
    }
    if (!multiple) return element;
    element.className = 'g-native-multi'; element.tabIndex = -1; element.setAttribute('aria-hidden', 'true');
    const picker = node('div', 'g-choice-picker'); picker.dataset.controlId = id;
    const header = node('div', 'g-choice-header'), count = node('span', 'g-choice-count');
    header.append(count, button('清空', () => { for (const option of element.options) option.selected = false; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, 'g-link'));
    const optionNodes = new Map([...element.options].map(option => [option.value, option]));
    const search = input(`${id}-filter`); search.type = 'search'; search.placeholder = '搜索名称、内容或时间'; search.setAttribute('aria-label', '筛选可选引用'); search.dataset.graphFilter = 'true';
    const list = node('div', 'g-choice-list'), notice = node('p', 'g-choice-notice');
    const searchable = options.map(option => ({ ...option, searchText: `${option.title || ''} ${option.label} ${option.meta || ''}`.toLocaleLowerCase() }));
    function renderCards() {
      const query = search.value.trim().toLocaleLowerCase(), matches = query ? searchable.filter(option => option.searchText.includes(query)) : searchable;
      list.replaceChildren();
      for (const option of matches.slice(0, 200)) {
        const card = node('div', 'g-choice-card');
        const label = node('label', 'g-choice-check'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = option.value;
        checkbox.setAttribute('aria-label', short(option.title || option.label, 200));
        const description = node('span', 'g-choice-description'); description.append(node('strong', '', short(option.title || option.label, 180)));
        if (option.meta) description.append(node('small', '', option.meta));
        label.append(checkbox, description); card.append(label);
        if (option.kind === 'evidence') card.append(button('回放', () => playEvidence(option.value), 'g-link g-choice-replay'));
        checkbox.addEventListener('change', () => { optionNodes.get(option.value).selected = checkbox.checked; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
        list.append(card);
      }
      if (!matches.length) list.append(node('p', 'g-choice-empty', options.length ? '没有匹配记录，请更换关键词。' : '暂无可选记录，请先完成上一层标注。'));
      notice.hidden = matches.length <= 200;
      notice.textContent = `当前显示 200 / ${matches.length} 条匹配记录，请搜索缩小范围。已选引用仍全部保留。`;
      sync();
    }
    const sync = () => {
      for (const card of list.querySelectorAll('.g-choice-card')) {
        const checkbox = card.querySelector('input'); checkbox.checked = optionNodes.get(checkbox.value)?.selected || false; card.classList.toggle('selected', checkbox.checked);
      }
      count.textContent = `已选 ${element.selectedOptions.length} / ${options.length}`;
    };
    search.addEventListener('input', renderCards); search.addEventListener('graph:sync-filter', renderCards);
    element.addEventListener('input', sync); element.addEventListener('change', sync); element.addEventListener('graph:sync-options', sync);
    picker.append(element, header, search, list, notice); renderCards(); return picker;
  }
  const entityOptions = () => graph().entities.map(entry => ({ value: entry.id, label: entry.name }));
  function inheritedSubject(id, candidatesFor, initial = [], { multiple = false, source = '证据', preserve = false } = {}) {
    const wrapper = node('div', 'g-subject-lineage'); wrapper.dataset.controlId = id;
    const controlHost = node('div', 'g-subject-control'), summary = node('div', 'g-inherited-subject'), hint = node('p', 'g-hint');
    wrapper.append(summary, controlHost, hint);
    let candidates = [], current = [...initial], keepSaved = preserve;
    const available = () => mergeSubjects(candidatesFor(), keepSaved ? savedSubjects(initial) : []);
    const read = () => { const control = wrapper.querySelector(`#${id}`); return !control ? [] : multiple ? [...control.selectedOptions].map(option => option.value) : control.value ? [control.value] : []; };
    function paint() {
      candidates = available();
      const allowed = new Set(candidates.map(candidate => candidate.id));
      current = current.filter(id => allowed.has(id));
      if (!current.length && candidates.length === 1 && (!keepSaved || !initial.length)) current = [candidates[0].id];
      const options = candidates.map(candidate => ({ value: candidate.id, label: candidate.name, meta: `沿用${source}中标注的主体` }));
      const selector = select(id, multiple ? options : [{ value: '', label: candidates.length ? '选择本条对应的主体' : '尚无已标主体' }, ...options], multiple ? current : current[0] || '', multiple);
      const control = multiple ? selector.querySelector('select') : selector;
      control.classList.add('g-subject-input');
      controlHost.replaceChildren(selector);
      const single = candidates.length === 1;
      wrapper.classList.toggle('is-single', single); wrapper.classList.toggle('is-empty', !candidates.length);
      if (!multiple) { control.tabIndex = single || !candidates.length ? -1 : 0; control.setAttribute('aria-hidden', String(single || !candidates.length)); }
      summary.replaceChildren();
      if (single) { summary.append(node('strong', '', candidates[0].name), node('span', '', `沿用${source}主体`)); }
      summary.hidden = !single;
      hint.textContent = !candidates.length ? `请先在${source}中标注主体；此处不会预设人物。` : single ? '已自动带入，无需重复选择。' : `仅显示${source}中的主体，请确认本条对应的对象。`;
      control.addEventListener('change', () => { current = read(); });
      return control;
    }
    paint();
    wrapper.refreshSubjects = (notify = false) => {
      const previous = JSON.stringify(read()); current = read();
      if (notify) keepSaved = false;
      const next = available();
      const unchanged = JSON.stringify(candidates.map(({ id, name }) => [id, name])) === JSON.stringify(next.map(({ id, name }) => [id, name]));
      const control = unchanged ? wrapper.querySelector(`#${id}`) : paint();
      if (unchanged) candidates = next;
      wrapper.dispatchEvent(new Event('graph:subjects-refreshed'));
      if (notify && previous !== JSON.stringify(read())) control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    wrapper.commitSubjects = () => {
      const chosen = new Set(read()); subjects.commit(candidates.filter(candidate => chosen.has(candidate.id)));
    };
    return wrapper;
  }
  const factOptions = () => graph().facts.map(entry => ({ value: entry.id, label: short(entry.text, 85), title: entry.text || '未填写事实', meta: `${entry.subject_ids.map(entityName).join('、') || '未指定主体'} · ${REVIEW_NAME[entry.review_status] || '草稿'}` }));
  const eventOptions = () => graph().events.map(entry => ({ value: entry.id, label: entry.title, title: entry.title, meta: `${entry.subject_ids.map(entityName).join('、')} · ${REVIEW_NAME[entry.review_status] || '草稿'}` }));
  const evidenceOptions = () => evidence().map(entry => ({ value: entry.id, label: evidenceLabel(entry), kind: 'evidence', title: `${entry.title || entry.item_id} · ${MODALITY_NAME[entry.modality] || '证据'}`, meta: `局部 ${numberText(entry.start_time)}–${numberText(entry.end_time)} · 共同 ${numberText(entry.global_start_time)}–${numberText(entry.global_end_time)} @ ${entry.timeline_id}` }));
  const multipleHint = '';
  function reviewField(prefix, initial = 'needs_review') {
    return field('复核状态', select(`${prefix}-review`, Object.entries(REVIEW_NAME).map(([id, label]) => ({ value: id, label })), initial));
  }
  function trackForm(form, prefix) {
    for (const element of form.querySelectorAll('input,select,textarea')) element.dataset.graphTracked = controlSignature(element);
    const update = event => {
      const element = event.target;
      if (!element.matches('input,select,textarea') || !element.id || element.dataset.graphFilter || element.id === `${prefix}-review`) return;
      const signature = controlSignature(element);
      if (element.dataset.graphTracked !== signature) { element.dataset.graphTracked = signature; form.querySelector(`#${prefix}-review`).value = 'needs_review'; }
    };
    form.addEventListener('input', update); form.addEventListener('change', update);
  }
  function requireValue(ok, message) { if (!ok) throw new Error(message); }
  const sameMembers = (left = [], right = []) => { const sorted = [...right].sort(); return left.length === sorted.length && [...left].sort().every((value, index) => value === sorted[index]); };
  function nodeSignature(entry, includeReview = false) {
    if (!entry) return '';
    return JSON.stringify(Object.fromEntries(Object.keys(entry).filter(key => includeReview || key !== 'review_status').sort().map(key => [key,
      ['aliases', 'subject_ids'].includes(key) ? [...entry[key]].sort() : entry[key]])));
  }
  function graphSignature(value) {
    const result = {};
    for (const [key, entries] of Object.entries(value)) {
      if (key === 'status') continue;
      result[key] = entries.map(entry => key === 'links'
        ? JSON.stringify([entry.from_type, entry.from_id, entry.to_type, entry.to_id, entry.type])
        : nodeSignature(entry, true)).sort();
    }
    return JSON.stringify(result);
  }
  function changedGraph(mutator, message, context = savingContext) {
    const workspace = ws(), previous = structuredClone({ graph: workspace.graph, records: workspace.records, manifest: workspace.manifest });
    try {
      captureFields();
      workspace.graph.status = 'draft'; mutator();
      const graphModified = graphSignature(previous.graph) !== graphSignature(workspace.graph);
      const modified = graphModified || JSON.stringify(previous.records) !== JSON.stringify(workspace.records) || JSON.stringify(previous.manifest) !== JSON.stringify(workspace.manifest);
      if (!graphModified) workspace.graph.status = previous.graph.status;
      workspace.graph = normalizeGraph(workspace.graph, workspace);
      if (context) clearFormContext(context.type, context.id);
      pruneRemovedContexts(); renderedContext = null;
      if (modified) Promise.resolve(changed()).catch(error => report(error.message || '浏览器草稿保存失败，请导出结果', true));
      render(); report(message);
      if (['fact', 'mention', 'entity'].includes(context?.type)) onFactSaved?.(context.type === 'fact' ? selected.fact : undefined);
      return true;
    } catch (error) { workspace.graph = previous.graph; workspace.records = previous.records; workspace.manifest = previous.manifest; report(error.message || '修改未保存，请检查字段', true); return false; }
  }
  function markDependents(type, id) {
    const queue = [[type, id]], seen = new Set();
    while (queue.length) {
      const [currentType, currentID] = queue.shift(); const key = JSON.stringify([currentType, currentID]);
      if (seen.has(key)) continue; seen.add(key);
      for (const link of graph().links.filter(link => link.from_type === currentType && link.from_id === currentID)) {
        const target = find(link.to_type, link.to_id);
        if (target && 'review_status' in target) target.review_status = 'needs_review';
        queue.push([link.to_type, link.to_id]);
      }
      if (currentType === 'emotion_state') for (const transition of graph().emotion_transitions.filter(entry => entry.from_state_id === currentID || entry.to_state_id === currentID)) transition.review_status = 'needs_review';
    }
  }
  function replaceLinks(toType, toID, fromType, ids, type) {
    const existing = linksTo(toType, toID, fromType), unique = [...new Set(ids)];
    if (sameMembers(existing.map(link => link.from_id), unique) && existing.every(link => link.type === type)) return;
    graph().links = graph().links.filter(link => !(link.to_type === toType && link.to_id === toID && link.from_type === fromType));
    for (const id of unique) graph().links.push({ id: existing.find(link => link.from_id === id)?.id || crypto.randomUUID(), from_type: fromType, from_id: id, to_type: toType, to_id: toID, type });
  }
  function upsert(type, entry) {
    const list = graph()[COLLECTION[type]], index = list.findIndex(current => current.id === entry.id);
    if (index >= 0) { if (nodeSignature(list[index], true) !== nodeSignature(entry, true)) list[index] = entry; } else list.push(entry);
    selected[type] = entry.id;
  }
  function remove(type, id) {
    if (!id || !window.confirm(`删除这个${TYPE_NAME[type]}及其关联关系？受影响的上层标注将改为待复核。`)) return;
    changedGraph(() => { removeGraphNode(ws(), COLLECTION[type], id); selected[type] = ''; }, `已删除${TYPE_NAME[type]}，关联关系已清理`, { type, id });
  }
  function stage(name) { captureFields(); activeStage = name; if (name === 'graph') showManagement = false; feedback.hidden = true; render(); }
  function openNode(type, id) {
    if (type === 'evidence') return playEvidence(id);
    selected[type] = id;
    if (type === 'entity' || type === 'mention') { showManagement = true; stage('evidence'); return; }
    stage(type === 'fact' ? 'facts' : type === 'event' ? 'events' : 'emotions');
  }
  async function playEvidence(id) {
    const entry = find('evidence', id); if (!entry) return report('证据时间窗已不存在', true);
    try { stage('evidence'); await navigateEvidence(entry.item_id, entry.segment_id); }
    catch (error) { report(error.message || '无法回到证据窗口', true); }
  }
  function nodeList(type, title) {
    const sidebar = node('aside', 'g-node-list'); sidebar.dataset.recordType = type;
    const top = node('div', 'g-list-top'); top.append(node('h3', '', `${title}（${graph()[COLLECTION[type]].length}）`), button(`新增${title}`, () => { selected[type] = ''; if (type === 'fact') factSeed = null; render(); }, 'g-button small'));
    sidebar.append(top);
    if (selected[type]) sidebar.append(button(`删除选中${title}`, () => remove(type, selected[type]), 'g-link danger g-list-remove'));
    const list = node('div', 'g-node-scroll');
    for (const entry of graph()[COLLECTION[type]]) {
      const item = button('', () => { selected[type] = entry.id; if (type === 'fact') factSeed = null; render(); }, 'g-node' + (selected[type] === entry.id ? ' active' : ''));
      item.dataset.nodeId = entry.id; item.append(node('strong', '', short(labelFor(type, entry.id), 70)));
      if (entry.review_status) { const badge = node('small', 'g-review-badge', REVIEW_NAME[entry.review_status] || entry.review_status); badge.dataset.review = entry.review_status; item.append(badge); }
      list.append(item);
    }
    if (!list.children.length) list.append(node('p', 'g-empty', `尚未创建${title}。`));
    sidebar.append(list); return sidebar;
  }
  function saveActions(form, type, onSave) {
    const actions = node('div', 'g-actions');
    actions.append(button(`保存${TYPE_NAME[type]}`, () => { savingContext = { type, id: selected[type] || '' }; try { onSave(); } catch (error) { report(error.message, true); } finally { savingContext = null; } }, 'g-button primary'));
    if (selected[type]) actions.append(button(`删除${TYPE_NAME[type]}`, () => remove(type, selected[type]), 'g-button danger'));
    form.append(actions);
  }
  function partitionForm(form, type, ids) {
    form.dataset.editorType = type;
    const columns = node('div', 'g-form-columns'), category = node('section', 'g-category-area'), content = node('section', 'g-content-area');
    category.append(node('h4', 'g-subheading', type === 'fact' ? '类型与主体' : type === 'event' ? '参与主体与复核' : type === 'emotion_state' ? '主体与情感判断' : '主体与状态连接'));
    content.append(node('h4', 'g-subheading', type === 'fact' ? '事实与证据' : type === 'event' ? '具体事件与组成事实' : type === 'emotion_state' ? '时间与事实依据' : '关联事件与判断依据'));
    const actions = [...form.children].find(child => child.classList.contains('g-actions'));
    for (const id of ids) { const field = form.querySelector(`#${id}`)?.closest('.g-field'); if (field) category.append(field); }
    for (const child of [...form.children]) {
      if (child === actions || child.tagName === 'H3' || (child.tagName === 'P' && child.classList.contains('g-hint'))) continue;
      if (child.classList.contains('g-form-pair') && !child.children.length) { child.remove(); continue; }
      if (child.classList.contains('g-form-pair') && child.children.length === 1) { content.append(child.firstElementChild); child.remove(); continue; }
      content.append(child);
    }
    columns.append(category, content); form.append(columns); if (actions) form.append(actions);
  }
  function citedEvidence(ids) {
    const list = node('div', 'g-citations');
    for (const id of ids) list.append(button(`回放：${short(labelFor('evidence', id), 90)}`, () => playEvidence(id), 'g-link'));
    return list;
  }
  function factEvidence(factIDs) { return [...new Set(graph().links.filter(link => link.from_type === 'evidence' && link.to_type === 'fact' && factIDs.includes(link.to_id)).map(link => link.from_id))]; }
  function boundsForFacts(ids) { return evidenceBounds(ws(), factEvidence(ids)); }

  function management() {
    const wrapper = node('details', 'g-management'); wrapper.open = showManagement;
    wrapper.addEventListener('toggle', () => { showManagement = wrapper.open; });
    wrapper.append(node('summary', '', '主体、证据提及与媒体对齐'));
    const columns = node('div', 'g-management-grid');
    const entities = node('section', 'g-card'); entities.append(node('h3', '', '主体与共指'));
    entities.append(node('p', 'g-hint', '先建立稳定主体，再把“黄衣人”“说话人 A”等提及指向主体。未知身份保持独立，不会自动合并。'));
    const entityList = node('div', 'g-chip-list');
    entityList.append(button('新增主体', () => { selected.entity = ''; render(); }));
    for (const entry of graph().entities) entityList.append(button(entry.name, () => { selected.entity = entry.id; render(); }, 'g-chip' + (selected.entity === entry.id ? ' active' : '')));
    const current = find('entity', selected.entity);
    const name = input('g-entity-name', current?.name), aliases = input('g-entity-aliases', current?.aliases?.join('，'));
    entities.append(entityList, field('主体名称', name), field('别名 / 已知称呼', aliases, '使用逗号或换行分隔。别名只记录称呼，不据此自动判断身份。'));
    const entityActions = node('div', 'g-actions');
    entityActions.append(button('保存主体', () => changedGraph(() => {
      requireValue(name.value.trim(), '请填写主体名称');
      const entry = { id: current?.id || crypto.randomUUID(), name: name.value.trim(), aliases: [...new Set(aliases.value.split(/[,，\n]/).map(text => text.trim()).filter(Boolean))] };
      if (current && nodeSignature(current) !== nodeSignature(entry)) {
        for (const fact of graph().facts.filter(fact => fact.subject_ids.includes(current.id) || fact.speaker_id === current.id)) { fact.review_status = 'needs_review'; markDependents('fact', fact.id); }
        for (const state of graph().emotion_states.filter(state => state.subject_id === current.id)) { state.review_status = 'needs_review'; markDependents('emotion_state', state.id); }
      }
      upsert('entity', entry);
    }, '主体已保存', { type: 'entity', id: current?.id || '' }), 'g-button primary'));
    if (current) entityActions.append(button('删除主体', () => remove('entity', current.id), 'g-button danger'));
    entities.append(entityActions);

    const mentions = node('section', 'g-card'); mentions.append(node('h3', '', '证据中的主体提及'));
    const mention = find('mention', selected.mention);
    mentions.append(field('提及描述', input('g-mention-description', mention?.description || '', 'text')), field('指向主体', select('g-mention-entity', [{ value: '', label: '请选择主体' }, ...entityOptions()], mention?.entity_id || '')), field('提及出现的证据窗', select('g-mention-evidence', [{ value: '', label: '请选择证据' }, ...evidenceOptions()], mention?.evidence_id || '')));
    const mentionActions = node('div', 'g-actions'); mentionActions.append(button(mention ? '更新提及' : '新增提及', () => changedGraph(() => {
      requireValue(value('g-mention-description').trim() && value('g-mention-entity') && value('g-mention-evidence'), '请填写提及描述、主体和证据窗');
      const entry = { id: mention?.id || crypto.randomUUID(), description: value('g-mention-description').trim(), entity_id: value('g-mention-entity'), evidence_id: value('g-mention-evidence') };
      if (mention && nodeSignature(mention) !== nodeSignature(entry)) for (const fact of graph().facts.filter(fact => fact.subject_ids.includes(mention.entity_id) || fact.subject_ids.includes(entry.entity_id) || fact.speaker_id === mention.entity_id || fact.speaker_id === entry.entity_id)) { fact.review_status = 'needs_review'; markDependents('fact', fact.id); }
      upsert('mention', entry);
      if (mention && mention.evidence_id !== entry.evidence_id && !graph().mentions.some(current => current.evidence_id === mention.evidence_id && current.entity_id === mention.entity_id)) {
        const previousSource = find('evidence', mention.evidence_id);
        const previousAnnotation = previousSource && ws().records[previousSource.item_id]?.segments.find(segment => segment.id === previousSource.segment_id)?.annotations;
        if (previousAnnotation && Object.hasOwn(previousAnnotation, 'subject_ids')) setEvidenceSubjects(ws(), previousSource.item_id, previousSource.segment_id, previousAnnotation.subject_ids.filter(id => id !== mention.entity_id));
      }
      const evidence = find('evidence', entry.evidence_id);
      const annotation = evidence && ws().records[evidence.item_id]?.segments.find(segment => segment.id === evidence.segment_id)?.annotations;
      if (annotation && Object.hasOwn(annotation, 'subject_ids')) {
        const ids = mention && mention.evidence_id === entry.evidence_id && mention.entity_id !== entry.entity_id
          ? annotation.subject_ids.map(id => id === mention.entity_id ? entry.entity_id : id)
          : [...annotation.subject_ids, entry.entity_id];
        setEvidenceSubjects(ws(), evidence.item_id, evidence.segment_id, [...new Set(ids)]);
      }
    }, '主体提及已保存', { type: 'mention', id: mention?.id || '' })));
    if (mention) mentionActions.append(button('取消编辑', () => { selected.mention = ''; render(); })); mentions.append(mentionActions);
    const mentionList = node('div', 'g-compact-list');
    for (const entry of graph().mentions) {
      const row = node('div', 'g-compact-row');
      row.append(button(`${entry.description} → ${entityName(entry.entity_id)}`, () => { selected.mention = entry.id; render(); }, 'g-link'), button('回放', () => playEvidence(entry.evidence_id), 'g-link'), button('删除', () => remove('mention', entry.id), 'g-link danger'));
      mentionList.append(row);
    }
    mentions.append(mentionList); columns.append(entities, mentions); wrapper.append(columns);

    const alignment = node('section', 'g-card'); alignment.append(node('h3', '', '共同时间轴与媒体偏移'), node('p', 'g-hint', '共同时间 = 素材内时间 + 偏移秒数。同一次录制的独立音轨、视频应使用相同时间轴 ID。偏移可为负数；修改会使引用这些证据的上层标注待复核。'));
    const byItem = new Map();
    for (const entry of evidence()) { if (!byItem.has(entry.item_id)) byItem.set(entry.item_id, []); byItem.get(entry.item_id).push(entry); }
    for (const [index, item] of ws().manifest.items.entries()) {
      const row = node('div', 'g-alignment-row');
      const timeline = input(`g-align-timeline-${index}`, item.timeline_id || item.source_id || item.id), offset = input(`g-align-offset-${index}`, item.time_offset_s ?? item.clip_start_s ?? 0, 'number');
      timeline.dataset.itemId = item.id; offset.dataset.itemId = item.id;
      row.append(node('strong', '', item.title), field('时间轴 ID', timeline), field('偏移 / 秒', offset));
      row.append(button('保存对齐', () => {
        const before = structuredClone(ws());
        try {
          captureFields();
          requireValue(timeline.value.trim(), '时间轴 ID 不能为空'); requireValue(offset.value !== '' && Number.isFinite(Number(offset.value)), '偏移必须为有效秒数');
          if (timeline.value.trim() === (item.timeline_id || item.source_id || item.id) && Number(offset.value) === (item.time_offset_s ?? item.clip_start_s ?? 0)) {
            clearFormContext('alignment', '', item.id); renderedContext = null; render(); report('媒体对齐未变化，已有复核状态保留'); return;
          }
          item.timeline_id = timeline.value.trim(); item.time_offset_s = Number(offset.value);
          graph().status = 'draft'; invalidateEvidence(ws(), evidence().filter(entry => entry.item_id === item.id).map(entry => entry.id));
          for (const event of graph().events) {
            const factIDs = linksTo('event', event.id, 'fact').map(link => link.from_id);
            try { const bounds = boundsForFacts(factIDs); if (bounds) event.timeline_id = bounds.timeline_id; } catch { event.review_status = 'needs_review'; }
          }
          ws().graph = normalizeGraph(graph(), ws()); clearFormContext('alignment', '', item.id); renderedContext = null; Promise.resolve(changed()).catch(error => report(error.message, true)); render(); report('媒体对齐已保存，受影响的事实、事件与情感需要复核');
        } catch (error) {
          ws().manifest = before.manifest; ws().graph = before.graph; render(); report(error.message || '对齐未保存', true);
        }
      }));
      const windows = byItem.get(item.id) || [];
      if (windows.length) row.append(node('small', 'g-hint g-align-summary', `共同时间范围：${numberText(Math.min(...windows.map(entry => entry.global_start_time)))} → ${numberText(Math.max(...windows.map(entry => entry.global_end_time)))} · ${windows.length} 个证据窗`));
      alignment.append(row);
    }
    wrapper.append(alignment); return wrapper;
  }

  function factsPanel() {
    const layout = node('div', 'g-editor-layout'); layout.append(nodeList('fact', '事实'));
    const form = node('div', 'g-card g-form');
    const fact = find('fact', selected.fact), seed = fact ? null : factSeed;
    const refs = fact ? linksTo('fact', fact.id, 'evidence').map(link => link.from_id) : seed?.evidence_ids || [];
    form.append(node('h3', '', fact ? '编辑事实' : '新增事实'), node('p', 'g-hint', '用第三人称客观描述。例：“A 称 B 已离职”描述的是 A 的陈述，不能直接认定 B 已离职。'));
    form.append(field('客观事实描述', textarea('g-fact-text', fact?.text || seed?.text || '')), field('事实类型', select('g-fact-kind', [{ value: 'observation', label: '观察事实' }, { value: 'reported_speech', label: '人物陈述 / 转述事实' }], fact?.kind || 'observation')));
    const candidateSubjects = () => { const ids = form.querySelector('#g-fact-evidence') ? values('g-fact-evidence') : refs; return ids.length ? subjects.fromEvidence(ids) : taskSubjects(); };
    const subjectField = inheritedSubject('g-fact-subjects', candidateSubjects, fact?.subject_ids || seed?.subject_ids || [], { multiple: true, source: '证据', preserve: !!fact });
    const speakerField = inheritedSubject('g-fact-speaker', candidateSubjects, fact?.speaker_id ? [fact.speaker_id] : [], { source: '证据', preserve: !!fact });
    const pair = node('div', 'g-form-pair'); pair.append(field('事实主体', subjectField), field('发言者（人物陈述）', speakerField, '被描述主体与发言者分别记录；观察事实不保存发言者。')); form.append(pair);
    form.append(field('支持证据', select('g-fact-evidence', evidenceOptions(), refs, true), '可勾选多个已对齐的音视频窗；同一证据可支持不同事实。'), reviewField('g-fact', fact?.review_status));
    form.querySelector('#g-fact-kind').addEventListener('change', () => { speakerField.closest('.g-field').hidden = value('g-fact-kind') !== 'reported_speech'; });
    form.querySelector('#g-fact-evidence').addEventListener('change', () => { subjectField.refreshSubjects(true); speakerField.refreshSubjects(true); });
    trackForm(form, 'g-fact');
    saveActions(form, 'fact', () => changedGraph(() => {
      const text = value('g-fact-text').trim(), subjects = values('g-fact-subjects'), evidenceIDs = values('g-fact-evidence'), kind = value('g-fact-kind'), speaker = value('g-fact-speaker');
      requireValue(text, '请填写事实描述'); requireValue(subjects.length, '请至少选择一个主体'); requireValue(evidenceIDs.length, '请选择支持事实的证据窗');
      if (kind === 'reported_speech') requireValue(speaker, '陈述事实必须注明说话主体');
      subjectField.commitSubjects(); if (kind === 'reported_speech') speakerField.commitSubjects();
      const id = fact?.id || crypto.randomUUID(), entry = { id, text, subject_ids: subjects, kind, speaker_id: kind === 'reported_speech' ? speaker : '', review_status: value('g-fact-review') };
      if (fact && (nodeSignature(fact) !== nodeSignature(entry) || !sameMembers(refs, evidenceIDs))) markDependents('fact', id);
      upsert('fact', entry);
      replaceLinks('fact', id, 'evidence', evidenceIDs, 'supports'); factSeed = null;
      for (const [itemID, record] of Object.entries(ws().records)) for (const segment of record.segments) {
        if (segment.annotations.fact_id !== id) continue;
        if (evidenceIDs.includes(JSON.stringify([itemID, segment.id]))) segment.annotations.observation = text;
        else delete segment.annotations.fact_id;
      }
    }, '事实已保存，引用关系可在关联图谱中查看'));
    partitionForm(form, 'fact', ['g-fact-kind', 'g-fact-subjects', 'g-fact-speaker', 'g-fact-review']);
    layout.prepend(form); return layout;
  }

  function eventsPanel() {
    const layout = node('div', 'g-editor-layout'); layout.append(nodeList('event', '复合事件'));
    const form = node('div', 'g-card g-form'), event = find('event', selected.event);
    const refs = event ? linksTo('event', event.id, 'fact').map(link => link.from_id) : [];
    form.append(node('h3', '', event ? '编辑复合事件' : '新增复合事件'), node('p', 'g-hint', '把事实精练为“谁做了什么、对象或结果是什么”的具体事件，避免把情绪或人格判断写成事件。'));
    const subjectField = inheritedSubject('g-event-subjects', () => { const ids = form.querySelector('#g-event-facts') ? values('g-event-facts') : refs; return ids.length ? subjects.fromFacts(ids) : taskSubjects(); }, event?.subject_ids || [], { multiple: true, source: '事实', preserve: !!event });
    form.append(field('事件名称 / 简练描述', textarea('g-event-title', event?.title || '', 2)), field('参与主体', subjectField), field('构成这个事件的事实', select('g-event-facts', factOptions(), refs, true), multipleHint));
    const timing = node('p', 'g-derived-time');
    function updateTiming() { try { const bounds = boundsForFacts(values('g-event-facts')); timing.textContent = bounds ? `支持证据覆盖范围：${bounds.timeline_id} · ${rangeText(bounds)}` : '选择事实后显示支持证据覆盖范围'; } catch (error) { timing.textContent = error.message; } }
    form.append(timing, reviewField('g-event', event?.review_status));
    trackForm(form, 'g-event');
    form.querySelector('#g-event-facts').addEventListener('change', () => { subjectField.refreshSubjects(true); updateTiming(); });
    saveActions(form, 'event', () => changedGraph(() => {
      const title = value('g-event-title').trim(), subjects = values('g-event-subjects'), facts = values('g-event-facts');
      requireValue(title && subjects.length && facts.length, '请填写事件描述，并选择参与主体及构成事实');
      const bounds = boundsForFacts(facts); requireValue(bounds, '所选事实缺少证据，无法确定事件时间轴');
      subjectField.commitSubjects();
      const id = event?.id || crypto.randomUUID(), entry = { id, title, subject_ids: subjects, timeline_id: bounds.timeline_id, review_status: value('g-event-review') };
      if (event && (nodeSignature(event) !== nodeSignature(entry) || !sameMembers(refs, facts))) markDependents('event', id);
      upsert('event', entry);
      replaceLinks('event', id, 'fact', facts, 'constitutes');
    }, '复合事件已保存，支持证据覆盖范围已更新'));
    partitionForm(form, 'event', ['g-event-subjects', 'g-event-review']);
    layout.prepend(form); queueMicrotask(() => { if (activeStage === 'events') updateTiming(); }); return layout;
  }

  function emotionsPanel() {
    const panel = node('div', 'g-emotions');
    const stateLayout = node('div', 'g-editor-layout'); stateLayout.append(nodeList('emotion_state', '情感状态'));
    const form = node('div', 'g-card g-form'), state = find('emotion_state', selected.emotion_state);
    const refs = state ? linksTo('emotion_state', state.id, 'fact').map(link => link.from_id) : [];
    const timelines = [...new Set(evidence().map(entry => entry.timeline_id))];
    if (state?.timeline_id && !timelines.includes(state.timeline_id)) timelines.push(state.timeline_id);
    form.append(node('h3', '', state ? '编辑情感状态' : '新增情感状态'), node('p', 'g-hint', '“皱眉、提高音量”先记为事实；“不满、紧张”是依据事实作出的情感判断。稳定情感可只记录一个状态。'));
    const stateEvents = state ? linksTo('emotion_state', state.id, 'event').map(link => link.from_id) : [];
    const subjectField = inheritedSubject('g-state-subject', () => {
      const facts = form.querySelector('#g-state-facts') ? values('g-state-facts') : refs;
      const events = form.querySelector('#g-state-events') ? values('g-state-events') : stateEvents;
      return facts.length ? subjects.fromFacts(facts) : events.length ? subjects.fromEvents(events) : taskSubjects();
    }, state?.subject_id ? [state.subject_id] : [], { source: '事实', preserve: !!state });
    const first = node('div', 'g-form-pair'); first.append(field('主体', subjectField), field('情感标签', input('g-state-label', state?.label || ''))); form.append(first);
    const second = node('div', 'g-form-pair'); second.append(field('共同时间轴', select('g-state-timeline', timelines.map(id => ({ value: id, label: id })), state?.timeline_id || timelines[0] || '')), field('强度（可选）', select('g-state-intensity', [{ value: '', label: '未标强度' }, ...[1, 2, 3, 4, 5].map(n => ({ value: String(n), label: String(n) }))], state?.intensity == null ? '' : String(state.intensity)))); form.append(second);
    const times = node('div', 'g-form-pair'); times.append(field('共同时间起点 / 秒', input('g-state-start', state?.start_time ?? '', 'number')), field('共同时间终点 / 秒', input('g-state-end', state?.end_time ?? '', 'number'))); form.append(times);
    form.append(field('情感判断的事实依据', select('g-state-facts', factOptions(), refs, true), multipleHint), field('关联的复合事件', select('g-state-events', eventOptions(), stateEvents, true), '稳定情感状态可直接关联事件，无需人为制造一次情绪变化。' + multipleHint));
    for (const id of ['g-state-facts', 'g-state-events']) form.querySelector(`#${id}`).addEventListener('change', () => subjectField.refreshSubjects(true));
    form.append(button('按所选事实的证据范围填入时间', () => {
      try { const bounds = boundsForFacts(values('g-state-facts')); requireValue(bounds, '先选择有证据的事实'); root.querySelector('#g-state-timeline').value = bounds.timeline_id; root.querySelector('#g-state-start').value = bounds.start_time; root.querySelector('#g-state-end').value = bounds.end_time; root.querySelector('#g-state-review').value = 'needs_review'; }
      catch (error) { report(error.message, true); }
    }, 'g-link'), reviewField('g-state', state?.review_status));
    trackForm(form, 'g-state');
    saveActions(form, 'emotion_state', () => changedGraph(() => {
      const subject = value('g-state-subject'), label = value('g-state-label').trim(), timeline = value('g-state-timeline'), start = value('g-state-start'), end = value('g-state-end'), facts = values('g-state-facts'), events = values('g-state-events');
      requireValue(subject && label && timeline && start !== '' && end !== '' && facts.length, '请填写主体、情感、时间和事实依据');
      requireValue(Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(end) > Number(start), '情感状态的终点必须大于起点');
      subjectField.commitSubjects();
      const id = state?.id || crypto.randomUUID(), entry = { id, subject_id: subject, label, timeline_id: timeline, start_time: Number(start), end_time: Number(end), intensity: value('g-state-intensity') === '' ? null : Number(value('g-state-intensity')), review_status: value('g-state-review') };
      if (state && (nodeSignature(state) !== nodeSignature(entry) || !sameMembers(refs, facts) || !sameMembers(stateEvents, events))) markDependents('emotion_state', id);
      upsert('emotion_state', entry);
      replaceLinks('emotion_state', id, 'fact', facts, 'grounds');
      replaceLinks('emotion_state', id, 'event', events, 'associated_with');
    }, '情感状态已保存'));
    partitionForm(form, 'emotion_state', ['g-state-subject', 'g-state-label', 'g-state-intensity', 'g-state-review']);
    stateLayout.prepend(form); panel.append(stateLayout);

    const transitionLayout = node('div', 'g-editor-layout'); transitionLayout.append(nodeList('emotion_transition', '情感变化'));
    const transitionForm = node('div', 'g-card g-form'), transition = find('emotion_transition', selected.emotion_transition);
    const eventLinks = transition ? linksTo('emotion_transition', transition.id, 'event') : [];
    const transitionSubjects = () => {
      const fromID = transitionForm.querySelector('#g-transition-from')?.value || transition?.from_state_id;
      const toID = transitionForm.querySelector('#g-transition-to')?.value || transition?.to_state_id;
      const saved = [fromID, toID].flatMap(id => { const state = find('emotion_state', id); return state ? savedSubjects([state.subject_id]) : []; });
      return saved.length ? mergeSubjects(saved) : taskSubjects();
    };
    const inherited = inheritedSubject('g-transition-subject', transitionSubjects, transition?.subject_id ? [transition.subject_id] : [], { source: '状态与证据', preserve: !!transition });
    const subject = inherited.querySelector('select');
    const selectedSubject = subject.value;
    transitionForm.append(node('h3', '', transition ? '编辑情感变化' : '新增情感变化'), node('p', 'g-hint', '连接同一主体的前后状态。事件默认只表示关联；因果需要另行作出人工判断并填写依据。'));
    const states = () => graph().emotion_states.filter(entry => entry.subject_id === value('g-transition-subject')).map(entry => ({ value: entry.id, label: `${entry.label} · ${entry.timeline_id} · ${rangeText(entry)}` }));
    transitionForm.append(field('主体', inherited));
    const statePair = node('div', 'g-form-pair');
    const initialStates = graph().emotion_states.filter(entry => entry.subject_id === selectedSubject).map(entry => ({ value: entry.id, label: `${entry.label} · ${entry.timeline_id} · ${rangeText(entry)}` }));
    statePair.append(field('变化前的状态', select('g-transition-from', [{ value: '', label: '请选择状态' }, ...initialStates], transition?.from_state_id || '')), field('变化后的状态', select('g-transition-to', [{ value: '', label: '请选择状态' }, ...initialStates], transition?.to_state_id || ''))); transitionForm.append(statePair);
    function syncTransitionStates() {
      const available = states();
      for (const id of ['g-transition-from', 'g-transition-to']) {
        const control = transitionForm.querySelector(`#${id}`); if (!control) continue;
        const previous = control.value;
        control.replaceChildren(...select('unused', [{ value: '', label: '请选择状态' }, ...available], previous).children);
        control.value = available.some(option => option.value === previous) ? previous : '';
      }
    }
    inherited.addEventListener('change', syncTransitionStates);
    inherited.addEventListener('graph:subjects-refreshed', syncTransitionStates);
    const relationOptions = [{ value: 'associated_with', label: '关联：不作因果断言' }, { value: 'causes', label: '因果判断（需填写依据）' }];
    const eventPicker = select('g-transition-events', eventOptions(), eventLinks.map(link => link.from_id), true);
    const eventSelect = eventPicker.querySelector('select');
    const relation = select('g-transition-relation', relationOptions, eventLinks[0]?.type || 'associated_with');
    const relationField = field('事件与情感变化的关系', relation);
    const relations = node('section', 'g-event-relation-list'); relations.id = 'g-transition-event-relations';
    const eventRelationValues = new Map(eventLinks.map(link => [link.from_id, link.type]));
    const eventRelationControls = new Map();
    let previousEvents = [...eventSelect.selectedOptions].map(option => option.value);
    const relationID = id => 'g-transition-event-relation-' + [...new TextEncoder().encode(id)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const context = formContext;
    function syncEventRelations(restoreDrafts = true) {
      if (previousEvents.length === 1) eventRelationValues.set(previousEvents[0], relation.value);
      if (previousEvents.length > 1) for (const [id, control] of eventRelationControls) eventRelationValues.set(id, control.value);
      const ids = [...eventSelect.selectedOptions].map(option => option.value);
      for (const [id, control] of eventRelationControls) if (!ids.includes(id)) dirtyFields.delete(draftKey(control, context()));
      relations.replaceChildren(node('p', 'g-hint', '每个事件分别选择关联或因果；新增关联默认不作因果断言。'));
      eventRelationControls.clear();
      for (const id of ids) {
        const initial = eventLinks.find(link => link.from_id === id)?.type || 'associated_with';
        const control = select(relationID(id), relationOptions, eventRelationValues.get(id) || initial);
        control.dataset.eventId = id;
        const key = draftKey(control, context());
        if (!fieldBaselines.has(key)) fieldBaselines.set(key, initial);
        if (restoreDrafts && dirtyFields.has(key) && fieldDrafts.has(key)) control.value = fieldDrafts.get(key);
        eventRelationValues.set(id, control.value);
        control.dataset.graphTracked = controlSignature(control);
        control.addEventListener('change', () => eventRelationValues.set(id, control.value));
        const row = field(find('event', id)?.title || id, control); row.classList.add('g-event-relation-row'); row.dataset.eventId = id;
        eventRelationControls.set(id, control); relations.append(row);
      }
      relationField.hidden = ids.length > 1; relations.hidden = ids.length <= 1;
      if (ids.length === 1) relation.value = eventRelationValues.get(ids[0]) || 'associated_with';
      previousEvents = ids;
    }
    eventSelect.addEventListener('change', syncEventRelations);
    eventSelect.addEventListener('graph:sync-options', syncEventRelations);
    relation.addEventListener('change', () => {
      if (previousEvents.length === 1) {
        const id = previousEvents[0]; eventRelationValues.set(id, relation.value);
        const control = eventRelationControls.get(id); if (control) { control.value = relation.value; control.dataset.graphTracked = controlSignature(control); }
      }
    });
    syncEventRelations(false);
    transitionForm.append(field('关联事件', eventPicker, multipleHint), relationField, relations, field('变化说明 / 因果判断依据', textarea('g-transition-note', transition?.note || '', 3)), reviewField('g-transition', transition?.review_status));
    trackForm(transitionForm, 'g-transition');
    saveActions(transitionForm, 'emotion_transition', () => changedGraph(() => {
      const subjectID = value('g-transition-subject'), from = value('g-transition-from'), to = value('g-transition-to'), events = values('g-transition-events');
      requireValue(subjectID && from && to && from !== to, '请选择同一主体的两个不同情感状态'); requireValue(events.length, '请选择关联这一情感变化的事件');
      const id = transition?.id || crypto.randomUUID();
      inherited.commitSubjects();
      upsert('emotion_transition', { id, subject_id: subjectID, from_state_id: from, to_state_id: to, note: value('g-transition-note').trim(), review_status: value('g-transition-review') });
      const previous = linksTo('emotion_transition', id, 'event');
      const desired = events.map(eventID => ({ eventID, type: events.length === 1 ? relation.value : eventRelationControls.get(eventID)?.value || eventRelationValues.get(eventID) || 'associated_with' }));
      if (!sameMembers(previous.map(link => link.from_id), events) || desired.some(entry => previous.find(link => link.from_id === entry.eventID)?.type !== entry.type)) {
        graph().links = graph().links.filter(link => !(link.to_type === 'emotion_transition' && link.to_id === id && link.from_type === 'event'));
        for (const entry of desired) graph().links.push({ id: previous.find(link => link.from_id === entry.eventID)?.id || crypto.randomUUID(), from_type: 'event', from_id: entry.eventID, to_type: 'emotion_transition', to_id: id, type: entry.type });
      }
    }, '情感变化已保存'));
    partitionForm(transitionForm, 'emotion_transition', ['g-transition-subject', 'g-transition-from', 'g-transition-to', 'g-transition-relation', 'g-transition-review']);
    transitionLayout.prepend(transitionForm); panel.append(transitionLayout, emotionTimeline()); return panel;
  }

  function emotionTimeline() {
    const section = node('section', 'g-card g-emotion-timeline'); section.append(node('h3', '', '主体的情感时间序列'));
    for (const entity of graph().entities) {
      const all = graph().emotion_states.filter(entry => entry.subject_id === entity.id);
      if (!all.length) continue;
      section.append(node('h4', '', entity.name));
      for (const timeline of new Set(all.map(state => state.timeline_id))) {
        const states = all.filter(state => state.timeline_id === timeline).sort((a, b) => a.start_time - b.start_time);
        const low = Math.min(...states.map(state => state.start_time)), high = Math.max(...states.map(state => state.end_time)), span = Math.max(.001, high - low);
        section.append(node('p', 'g-hint', `${timeline} · ${numberText(low)} → ${numberText(high)}`));
        for (const state of states) {
          const line = node('div', 'g-state-track'); const band = button(`${state.label}${state.intensity == null ? '' : ` · ${state.intensity}/5`} · ${rangeText(state)}`, () => openNode('emotion_state', state.id), 'g-state-band');
          band.style.left = `${(state.start_time - low) / span * 100}%`; band.style.width = `${Math.max(.8, (state.end_time - state.start_time) / span * 100)}%`; band.title = labelFor('emotion_state', state.id); line.append(band); section.append(line);
        }
      }
      for (const transition of graph().emotion_transitions.filter(entry => entry.subject_id === entity.id)) section.append(button(`变化：${labelFor('emotion_transition', transition.id)}`, () => openNode('emotion_transition', transition.id), 'g-link'));
    }
    if (!graph().emotion_states.length) section.append(node('p', 'g-empty', '建立情感状态后，这里会按主体和共同时间轴排列。'));
    return section;
  }

  function directedGraph(data) {
    const section = node('section', 'g-card g-directed-graph');
    const toolbar = node('div', 'g-graph-toolbar'); toolbar.append(node('h3', '', '四层关联有向图'));
    const ns = 'http://www.w3.org/2000/svg';
    const svgNode = (tag, attrs = {}, text = '') => { const element = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attrs)) element.setAttribute(key, String(val)); if (text) element.textContent = text; return element; };
    const viewLinks = graphViewLinks(graph());
    const projection = projectGraphView(data, viewLinks, graphFocus, { page: graphPage });
    const displayed = projection.data; graphPage = projection.page;
    const height = Math.max(260, 80 + Math.max(...displayed.map(([, entries]) => entries.length)) * 88);
    const svg = svgNode('svg', { id: 'g-directed-svg', xmlns: ns, viewBox: `0 0 1450 ${height}`, width: 1450, height, role: 'img', 'aria-label': '证据、事实、复合事件和情感脉络的有向关联图' });
    svg.append(svgNode('rect', { width: 1450, height, fill: '#fbfcf8' }));
    const defs = svgNode('defs'), marker = svgNode('marker', { id: 'g-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
    marker.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#657d64' })); defs.append(marker); svg.append(defs);
    const positions = new Map(), width = 265;
    displayed.forEach(([title, entries], col) => {
      const x = 24 + col * 345;
      svg.append(svgNode('text', { x, y: 28, fill: '#284731', 'font-size': 16, 'font-family': 'sans-serif', 'font-weight': 600 }, `${title}（${data[col][1].length}）`));
      entries.forEach(({ type, entry }, row) => positions.set(JSON.stringify([type, entry.id]), { x, y: 52 + row * 88, type, entry }));
    });
    const edgeGroup = svgNode('g', { 'data-graph-layer': 'edges' }), nodeGroup = svgNode('g', { 'data-graph-layer': 'nodes' });
    const labelNames = { ...RELATION_NAME, before_state: '变化前', after_state: '变化后' };
    const relatedNodes = new Set(), relatedEdges = new Set();
    const forward = new Map(), backward = new Map();
    for (const link of viewLinks) {
      const from = JSON.stringify([link.from_type, link.from_id]), to = JSON.stringify([link.to_type, link.to_id]);
      if (!forward.has(from)) forward.set(from, []); forward.get(from).push(link);
      if (!backward.has(to)) backward.set(to, []); backward.get(to).push(link);
    }
    if (graphFocus) for (const direction of ['forward', 'backward']) {
      const queue = [JSON.stringify([graphFocus.type, graphFocus.id])], visited = new Set();
      while (queue.length) {
        const key = queue.shift(); if (visited.has(key)) continue; visited.add(key); relatedNodes.add(key);
        for (const link of (direction === 'forward' ? forward : backward).get(key) || []) {
          const fromKey = JSON.stringify([link.from_type, link.from_id]), toKey = JSON.stringify([link.to_type, link.to_id]);
          if ((direction === 'forward' ? fromKey : toKey) === key) { relatedEdges.add(link.id); queue.push(direction === 'forward' ? toKey : fromKey); }
        }
      }
    }
    for (const link of projection.links) {
      const from = positions.get(JSON.stringify([link.from_type, link.from_id])), to = positions.get(JSON.stringify([link.to_type, link.to_id]));
      if (!from || !to) continue;
      const x1 = from.x + width, y1 = from.y + 34, sameColumn = from.x === to.x, x2 = sameColumn ? to.x + width : to.x, y2 = to.y + 34;
      const bend = sameColumn ? Math.max(x1, x2) + 78 : (x1 + x2) / 2;
      const focused = relatedEdges.has(link.id);
      const path = svgNode('path', { d: `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`, fill: 'none', stroke: focused ? '#285b39' : '#71836b', 'stroke-width': focused ? 2.5 : 1.6, 'marker-end': 'url(#g-arrow)', 'data-edge-id': link.id });
      if (link.type === 'associated_with' || sameColumn) path.setAttribute('stroke-dasharray', '5 4');
      path.append(svgNode('title', {}, `${labelFor(link.from_type, link.from_id)} — ${labelNames[link.type]} → ${labelFor(link.to_type, link.to_id)}`)); edgeGroup.append(path);
      const labelX = sameColumn ? bend - 8 : (x1 + x2) / 2;
      edgeGroup.append(svgNode('text', { x: labelX, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-size': 10, fill: '#52684c', stroke: '#fbfcf8', 'stroke-width': 3, 'paint-order': 'stroke' }, labelNames[link.type] || link.type));
    }
    for (const position of positions.values()) {
      const { x, y, type, entry } = position;
      const focused = graphFocus?.type === type && graphFocus?.id === entry.id;
      const related = relatedNodes.has(JSON.stringify([type, entry.id]));
      const group = svgNode('g', { tabindex: 0, role: 'button', 'data-node-type': type, 'data-node-id': entry.id, 'aria-label': `${TYPE_NAME[type]}：${labelFor(type, entry.id)}`, cursor: 'pointer' });
      const color = type === 'evidence' ? '#eef2f6' : type === 'fact' ? '#edf3e7' : type === 'event' ? '#f7f1e4' : '#f2edf4';
      group.append(svgNode('rect', { x, y, width, height: 68, rx: 4, fill: focused ? '#dcebd2' : related ? '#eef5e5' : color, stroke: focused ? '#29583a' : related ? '#78966a' : '#b4c3ac', 'stroke-width': focused ? 2.5 : 1 }));
      const characters = [...short(labelFor(type, entry.id), 40)], first = characters.slice(0, 20).join(''), second = characters.slice(20, 40).join('');
      group.append(svgNode('text', { x: x + 10, y: y + 21, fill: '#294330', 'font-family': 'sans-serif', 'font-size': 12 }, first));
      if (second) group.append(svgNode('text', { x: x + 10, y: y + 39, fill: '#294330', 'font-family': 'sans-serif', 'font-size': 12 }, second));
      const meta = type === 'evidence' ? `${numberText(entry.global_start_time)} → ${numberText(entry.global_end_time)}` : REVIEW_NAME[entry.review_status] || TYPE_NAME[type];
      group.append(svgNode('text', { x: x + 10, y: y + 57, fill: '#61705c', 'font-family': 'sans-serif', 'font-size': 10 }, meta));
      group.append(svgNode('title', {}, labelFor(type, entry.id)));
      const focus = () => { graphFocus = { type, id: entry.id }; graphPage = 0; render(); };
      group.addEventListener('click', focus); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus(); } });
      nodeGroup.append(group);
    }
    svg.append(edgeGroup, nodeGroup);
    const exportButton = button('导出当前视图 SVG', () => {
      const copy = svg.cloneNode(true); copy.removeAttribute('role'); copy.removeAttribute('style'); copy.setAttribute('width', '1450'); copy.setAttribute('height', String(height)); copy.setAttribute('data-export-scope', 'current-view');
      const serialized = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(copy);
      const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })), link = node('a');
      link.href = url; link.download = 'four-layer-graph.svg'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }); exportButton.id = 'g-export-svg';
    const fullExportButton = button('导出完整图谱 SVG', () => {
      const serialized = serializeFullGraphSVG(data, viewLinks, { labelFor, reviewNames: REVIEW_NAME, relationNames: RELATION_NAME });
      const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })), link = node('a');
      link.href = url; link.download = 'four-layer-full-graph.svg'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }); fullExportButton.id = 'g-export-full-svg';
    const viewport = node('div', 'g-svg-viewport');
    const sizeControls = node('div', 'g-graph-size-controls');
    const fitButton = button('适应宽度', () => { graphFit = true; syncSize(); }); fitButton.id = 'g-graph-fit';
    const originalButton = button('原始大小', () => { graphFit = false; syncSize(); }); originalButton.id = 'g-graph-original';
    function syncSize() {
      viewport.classList.toggle('fit', graphFit); viewport.dataset.sizeMode = graphFit ? 'fit' : 'original';
      fitButton.setAttribute('aria-pressed', String(graphFit)); originalButton.setAttribute('aria-pressed', String(!graphFit));
    }
    sizeControls.append(fitButton, originalButton, exportButton, fullExportButton); toolbar.append(sizeControls); section.append(toolbar);
    const summary = node('p', 'g-hint', `${projection.mode === 'focus' ? '聚焦当前节点及其上下游' : '全部节点'}：本页 ${projection.shown} / 范围 ${projection.scopeTotal} / 项目 ${projection.total} 个节点。虚线表示关联或状态衔接，不自动推断因果。`); summary.id = 'g-graph-view-summary'; section.append(summary);
    const paging = node('div', 'g-graph-page-controls'); paging.id = 'g-graph-page-controls';
    const previousPage = button('上一页', () => { graphPage--; render(); }); previousPage.id = 'g-graph-prev'; previousPage.disabled = !projection.page;
    const nextPage = button('下一页', () => { graphPage++; render(); }); nextPage.id = 'g-graph-next'; nextPage.disabled = projection.page >= projection.pageCount - 1;
    const pageStatus = node('span', '', `${projection.page + 1} / ${projection.pageCount}`); pageStatus.id = 'g-graph-page-status';
    paging.append(previousPage, pageStatus, nextPage); section.append(paging);
    viewport.append(svg); syncSize(); section.append(viewport); return section;
  }

  function graphPanel() {
    const panel = node('div', 'g-graph-panel');
    panel.append(node('p', 'g-flow-caption', '点击节点查看上下游，可回放证据或编辑标注。图随关联自动生成。'));
    const columns = node('div', 'g-graph-columns');
    const data = [['证据', evidence().map(entry => ({ type: 'evidence', entry }))], ['事实', graph().facts.map(entry => ({ type: 'fact', entry }))], ['复合事件', graph().events.map(entry => ({ type: 'event', entry }))], ['情感脉络', [...graph().emotion_states.map(entry => ({ type: 'emotion_state', entry })), ...graph().emotion_transitions.map(entry => ({ type: 'emotion_transition', entry }))]]];
    const neighbors = new Set();
    if (graphFocus) for (const link of graph().links) {
      if (link.from_type === graphFocus.type && link.from_id === graphFocus.id) neighbors.add(JSON.stringify([link.to_type, link.to_id]));
      if (link.to_type === graphFocus.type && link.to_id === graphFocus.id) neighbors.add(JSON.stringify([link.from_type, link.from_id]));
    }
    for (const [title, items] of data) {
      const column = node('section', 'g-graph-column'); column.append(node('h4', '', `${title}（${items.length}）`));
      const scroll = node('div', 'g-graph-scroll');
      for (const { type, entry } of items) {
        const focused = graphFocus?.type === type && graphFocus?.id === entry.id;
        const item = button('', () => { graphFocus = { type, id: entry.id }; graphPage = 0; render(); }, 'g-graph-node' + (focused ? ' active' : neighbors.has(JSON.stringify([type, entry.id])) ? ' related' : ''));
        item.dataset.nodeType = type; item.dataset.nodeId = entry.id;
        item.append(node('strong', '', short(labelFor(type, entry.id), 95)), node('small', '', type === 'evidence' ? `共同时间 ${numberText(entry.global_start_time)} → ${numberText(entry.global_end_time)}` : REVIEW_NAME[entry.review_status] || TYPE_NAME[type]));
        scroll.append(item);
      }
      if (!items.length) scroll.append(node('p', 'g-empty', '尚无节点')); column.append(scroll); columns.append(column);
    }
    panel.append(directedGraph(data));
    const nodeBrowser = node('details', 'g-graph-browser'); nodeBrowser.append(node('summary', '', '展开节点列表'), columns); panel.append(nodeBrowser);
    const relation = node('section', 'g-card'); relation.append(node('h3', '', graphFocus ? `${TYPE_NAME[graphFocus.type]}的上下游关系` : '全部关联关系'));
    if (graphFocus) relation.append(node('p', 'g-focus-label', labelFor(graphFocus.type, graphFocus.id)), button(graphFocus.type === 'evidence' ? '回放此证据' : '编辑此节点', () => openNode(graphFocus.type, graphFocus.id), 'g-button'), button('显示全部关系', () => { graphFocus = null; graphPage = 0; render(); }, 'g-link'));
    const relevant = graphFocus ? graph().links.filter(link => (link.from_type === graphFocus.type && link.from_id === graphFocus.id) || (link.to_type === graphFocus.type && link.to_id === graphFocus.id)) : graph().links;
    const relationList = node('div', 'g-relation-list');
    for (const link of relevant) {
      const row = node('div', 'g-relation-row');
      row.append(button(short(labelFor(link.from_type, link.from_id), 85), () => { graphFocus = { type: link.from_type, id: link.from_id }; graphPage = 0; render(); }, 'g-link'), node('span', 'g-relation-type', `— ${RELATION_NAME[link.type] || link.type} →`), button(short(labelFor(link.to_type, link.to_id), 85), () => { graphFocus = { type: link.to_type, id: link.to_id }; graphPage = 0; render(); }, 'g-link'));
      relationList.append(row);
    }
    if (!relevant.length) relationList.append(node('p', 'g-empty', '暂无这组关联。请在事实、事件或情感表单中选择依据。'));
    relation.append(relationList); panel.append(relation, emotionTimeline());
    const validation = node('section', 'g-card g-validation'); validation.id = 'g-validation'; validation.append(node('h3', '', '四层完整性检查'));
    const issues = graphIssues(ws()), errors = issues.filter(issue => issue.severity === 'error');
    if (issues.length) {
      const list = node('ul'); for (const issue of issues) { const item = node('li', issue.severity === 'error' ? 'g-issue-error' : 'g-issue-warning'); item.append(node('span', '', issue.message)); if (issue.node_type && issue.node_id && (COLLECTION[issue.node_type] || issue.node_type === 'evidence')) item.append(button('定位', () => openNode(issue.node_type, issue.node_id), 'g-link')); list.append(item); } validation.append(list);
    } else validation.append(node('p', 'g-complete', '未发现完整性问题。'));
    validation.append(button('标记四层完成', () => {
      if (hasUnsavedChanges()) { report('仍有表单尚未保存，请先保存或处理未提交内容，再标记四层完成', true); return; }
      const problems = graphIssues(ws()).filter(issue => issue.severity === 'error');
      if (problems.length) { report(`还有 ${problems.length} 项未完成：${problems[0].message}`, true); root.querySelector('#g-validation').scrollIntoView({ block: 'nearest' }); return; }
      const previous = graph().status;
      try { graph().status = 'complete'; ws().graph = normalizeGraph(graph(), ws()); changed(); render(); report('四层已通过完整性检查并标记完成'); }
      catch (error) { graph().status = previous; report(error.message, true); }
    }, 'g-button primary'));
    validation.append(node('p', 'g-hint', errors.length ? `当前有 ${errors.length} 项阻止完成的问题。检查核对引用与时序，不自动证明事实、因果或双标一致。` : '结构检查不自动证明事实、因果或双标一致；“已人工确认”表示完成本轮复核。'));
    panel.append(validation); return panel;
  }

  function render() {
    captureFields();
    const workspace = ws(); root.hidden = !workspace;
    if (!workspace) { fieldDrafts.clear(); fieldBaselines.clear(); dirtyFields.clear(); renderedContext = null; updateUnsavedNote(); return; }
    if (renderedContext && renderedContext.workspace !== workspace.id) {
      activeStage = 'evidence'; graphFocus = null; graphPage = 0; factSeed = null;
      for (const type of Object.keys(selected)) selected[type] = '';
      fieldDrafts.clear(); fieldBaselines.clear(); dirtyFields.clear(); renderedContext = null;
    }
    if (!workspace.graph) workspace.graph = blankGraph();
    if (subjectWorkspace !== workspace) { subjectWorkspace = workspace; subjects = createSubjectResolver(workspace); }
    if (renderedContext?.itemID && renderedContext.itemID !== currentItemID()) {
      for (const type of ['fact', 'event', 'emotion_state', 'emotion_transition']) selected[type] = '';
      factSeed = null;
    }
    if (graphFocus && !find(graphFocus.type, graphFocus.id)) { graphFocus = null; graphPage = 0; }
    root.dataset.stage = activeStage;
    const counts = { evidence: evidence().length, facts: graph().facts.length, events: graph().events.length, emotions: graph().emotion_states.length + graph().emotion_transitions.length };
    status.textContent = graph().status === 'complete' ? '四层已完成' : '四层待完成'; status.classList.toggle('complete', graph().status === 'complete');
    tabs.replaceChildren();
    for (const [id, text] of STAGES) {
      const tab = button(`${text}${id in counts ? ` ${counts[id]}` : ''}`, () => stage(id), 'g-tab' + (activeStage === id ? ' active' : ''));
      tab.dataset.stage = id; tab.setAttribute('aria-current', activeStage === id ? 'step' : 'false'); tabs.append(tab);
    }
    const editor = document.querySelector('.editor-grid'), footer = document.querySelector('.task-footer');
    if (editor) editor.hidden = activeStage !== 'evidence'; if (footer) footer.hidden = activeStage !== 'evidence';
    body.replaceChildren();
    if (activeStage === 'evidence') body.append(node('p', 'g-stage-hint', '在下方标记时间窗、选择主体并填写事实描述；保存后直接建立证据与事实的关联。事实汇总可继续整理多模态依据。'));
    if (activeStage === 'evidence') body.append(management());
    if (activeStage === 'facts') body.append(factsPanel());
    else if (activeStage === 'events') body.append(eventsPanel());
    else if (activeStage === 'emotions') body.append(emotionsPanel());
    else if (activeStage === 'graph') body.append(graphPanel());
    if (activeStage !== 'evidence') body.append(management());
    const context = formContext();
    recordBaselines(context); restoreFields(context);
    for (const wrapper of body.querySelectorAll('.g-subject-lineage')) wrapper.refreshSubjects();
    restoreFields(context);
    const speaker = body.querySelector('#g-fact-speaker'); if (speaker) speaker.closest('.g-field').hidden = value('g-fact-kind') !== 'reported_speech';
    renderedContext = context; captureFields(); updateUnsavedNote();
  }
  function openFactFromEvidence(id) {
    const entry = find('evidence', id); if (!entry) return report('请先选择有效证据时间窗', true);
    const segment = ws().records[entry.item_id]?.segments.find(segment => segment.id === entry.segment_id);
    captureFields();
    const pendingFact = [...dirtyFields].some(key => { const [workspace, type, nodeID, itemID] = JSON.parse(key); return workspace === ws().id && type === 'fact' && !nodeID && itemID === currentItemID(); });
    if (pendingFact && !window.confirm('当前新增事实还有未保存内容。放弃这份草稿，并从所选证据重新整理事实？')) return false;
    clearFormContext('fact', ''); renderedContext = null;
    selected.fact = ''; factSeed = { text: segment?.annotations?.local_fact || segment?.annotations?.observation || '', evidence_ids: [id], subject_ids: subjects.fromEvidence([id]).map(candidate => candidate.id) };
    stage('facts'); report('已带入当前证据和文本。请核对主体与事实表述后保存；没有自动确认。');
  }
  render();
  function hasUnsavedChanges() { captureFields(); return updateUnsavedNote(); }
  return { render, openFactFromEvidence, hasUnsavedChanges, setStage: stage, get stage() { return activeStage; } };
}
