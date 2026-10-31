import { blankGraph, evidenceNodes, evidenceBounds, evidenceTimeRanges, factTimeRanges, eventTimeRanges, normalizeGraph, invalidateEvidence, removeGraphNode, connectEmotionStateSelection, nextAnnotationId, assertTemporalOrder } from './graph.mjs';
import { annotationNodePresentation, fourLayerTimeline, serializeTimelineSVG, FACT_COLORS } from './graph-view.mjs';
import { createSubjectResolver } from './subject-lineage.mjs';
import { setEvidenceSubjects } from './evidence-fact.mjs';
import { createAnnotationTimeline, planAnnotationTimeEdit, applyAnnotationTimePlan, createAnnotationDraft } from './annotation-timeline.mjs';
import { materialGraph, materialWorkspace } from './material-scope.mjs';

const STAGES = [['evidence', '证据'], ['facts', '事实'], ['events', '复合事件'], ['emotions', '情感脉络'], ['graph', '关联图谱']];
const COLLECTION = { entity: 'entities', mention: 'mentions', fact: 'facts', event: 'events', emotion_state: 'emotion_states', emotion_transition: 'emotion_transitions', link:'links' };
const TYPE_NAME = { link:'关系', evidence: '证据', entity: '主体', mention: '提及', fact: '事实', event: '复合事件', emotion_state: '情感状态', emotion_transition: '情感变化' };
const RELATION_NAME = { supports: '支持', constitutes: '构成', grounds: '情感判断依据', associated_with: '关联', causes: '导致（人工判断）', transitions_to: '情感变化' };
const node = (tag, className, content) => { const value = document.createElement(tag); if (className) value.className = className; if (content !== undefined) value.textContent = content; return value; };
export function uiIcon(name){const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');icon.classList.add('ui-icon');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');use.setAttribute('href',`#icon-${name}`);icon.append(use);return icon;}
const button = (text, action, className = 'g-button') => { const value = node('button', className, text); value.type = 'button';const name=text==='撤回'?'undo':/^(新增|新建)/.test(text)?'plus':/^保存/.test(text)?'save':text==='连接选中状态'?'link':/^删除/.test(text)?'trash':text==='回放'?'play':null;if(name)value.prepend(uiIcon(name)); value.addEventListener('click', action); return value; };
const short = (text, length = 55) => String(text || '').length > length ? String(text).slice(0, length) + '…' : String(text || '');
const numberText = value => Number.isFinite(value) ? `${Math.round(value * 1000) / 1000}s` : '—';
const rangeText = value => value ? `${numberText(value.start_time)} → ${numberText(value.end_time)}` : '尚未关联时间范围';

export function mountGraphWorkbench(root, { getWorkspace, changed, persistDraft, deleteEvidence, navigateEvidence, onFactSaved, seekTimeline, getPlaybackTime, pausePlayback, canUndo, onUndo }) {
  root.classList.add('graph-workbench');
  let activeStage = 'evidence';
  let graphPage = 0;
  const selected = { entity: '', mention: '', fact: '', event: '', emotion_state: '', emotion_transition: '' };
  const stateSelection = new Set();
  let selectedEmotionEdge='';
  let factSeed = null, graphFocus = null, graphTimeline = null, graphRange = 'full', graphSearch = '', graphListScroll = 0, graphCategory = 'evidence', graphWindowStart = null, graphWindowSpan = 60, graphPanFrame = 0;
  let graphReferenceID=null,referenceDeletion=null;
  let graphTypographyObserver=null;
  let layerTimeline = null;
  const timelineViews = { facts: {}, events: {}, emotions: {} };
  let subjectWorkspace = null, subjects = null;
  const fieldDrafts = new Map(), fieldBaselines = new Map(), dirtyFields = new Set(); let renderedContext = null, savingContext = null;
  let autoTimer=null,autoSaving=false,draftWorkspace=null;
  const temporalConflicts = new Map();
  function storeFormDrafts(){if(!ws())return;ws().ui_form_drafts=[...dirtyFields].filter(key=>JSON.parse(key)[0]===ws().id).map(key=>[key,fieldDrafts.get(key),fieldBaselines.get(key)]);ws().ui_temporal_conflicts=[...temporalConflicts].map(([key,entry])=>[key,{itemID:entry.itemID,message:entry.error.message}]);}
  function retainDrafts(){captureFields();storeFormDrafts();if(ws()){ws().updated_at=new Date().toISOString();persistDraft?.();}}
  function autosave(){clearTimeout(autoTimer);retainDrafts();const save=body.querySelector('.g-actions .primary');const dirtyHere=renderedContext && [...body.querySelectorAll('input[id],select[id],textarea[id]')].some(element=>!element.dataset.graphFilter && dirtyFields.has(draftKey(element,renderedContext)));const conflictType={facts:'fact',events:'event',emotions:'emotion_state'}[activeStage];const retryConflict=conflictType&&temporalConflicts.has(JSON.stringify([ws().id,conflictType,selected[conflictType]||'']));if(!save || (!dirtyHere&&!retryConflict))return;
    const active=document.activeElement, id=active?.id,start=active?.selectionStart,end=active?.selectionEnd;
    autoSaving=true;try{save.click();}finally{autoSaving=false;storeFormDrafts();persistDraft?.();}
    const target=id && document.getElementById(id);if(target){target.focus({preventScroll:true});if(typeof start==='number' && target.setSelectionRange)try{target.setSelectionRange(start,end);}catch{}}
  }
  const controlSignature = element => JSON.stringify(element.multiple ? [...element.selectedOptions].map(option => option.value) : element.value);
  function draftKey(element, context) {
    const prefix = element.id.startsWith('g-fact-') ? 'fact' : element.id.startsWith('g-event-') ? 'event' : element.id.startsWith('g-state-') ? 'emotion_state' : element.id.startsWith('g-transition-') ? 'emotion_transition' : element.id.startsWith('g-entity-') ? 'entity' : element.id.startsWith('g-mention-') ? 'mention' : 'alignment';
    return JSON.stringify([context.workspace, prefix, context.selected[prefix] || '', element.dataset.itemId || (!context.selected[prefix] && ['fact', 'event', 'emotion_state', 'emotion_transition'].includes(prefix) ? context.itemID || '' : ''), element.id]);
  }
  function captureFields() {
    if (!renderedContext) return;
    for (const element of body.querySelectorAll('input[id],select[id],textarea[id]')) {
      if(element.closest('.g-state-edge-list'))continue;
      if (element.type === 'hidden' && element.id.endsWith('-review')) continue;
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
      if(element.closest('.g-state-edge-list'))continue;
      if (element.type === 'hidden' && element.id.endsWith('-review')) continue;
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
      if(element.closest('.g-state-edge-list'))continue;
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
  const unsavedNote = node('span', 'g-unsaved-note', '内容已自动保留为草稿'); unsavedNote.hidden = true; heading.append(unsavedNote);
  const status = node('span', 'g-status');
  const undoButton = button('撤回', () => onUndo?.(), 'g-button small'); undoButton.id = 'g-undo'; undoButton.title = '撤回上一步标注修改（Ctrl+Z；输入框内保留文字撤销）'; heading.append(undoButton);
  const tabs = node('nav', 'g-tabs'); tabs.setAttribute('aria-label', '标注阶段');
  const feedback = node('p', 'g-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  const body = node('div', 'g-body');
  const layerView = node('div', 'g-layer-view'); layerView.hidden = true;
  const previewHost = node('div', 'g-layer-preview'), timelineHost = node('div', 'g-layer-timeline-host');
  layerView.append(previewHost, timelineHost);
  root.replaceChildren(heading, tabs, feedback, layerView, body);
  for (const media of document.querySelectorAll('#video,#audio')) {
    for (const event of ['timeupdate', 'seeked', 'loadedmetadata']) media.addEventListener(event, () => layerTimeline?.updatePlayhead());
  }
  const observeFields = event => { if(event?.target?.closest('.g-state-edge-list'))return;captureFields(); updateUnsavedNote();if(event?.target?.dataset.graphFilter || activeStage==='graph')return;retainDrafts();clearTimeout(autoTimer);autoTimer=setTimeout(autosave,650); };
  root.addEventListener('input', observeFields); root.addEventListener('change', observeFields);
  root.addEventListener('click', () => queueMicrotask(observeFields));
  const ws = () => getWorkspace();
  const graph = () => ws().graph;
  const visibleGraph = () => materialGraph(ws(),currentItemID());
  const evidence = () => evidenceNodes(materialWorkspace(ws()));
  const find = (type, id) => type === 'evidence' ? evidence().find(value => value.id === id) : (visibleGraph()[COLLECTION[type]] || []).find(value => value.id === id);
  const values = id => [...root.querySelectorAll(`#${id} option:checked`)].map(option => option.value);
  const value = id => root.querySelector(`#${id}`)?.value || '';
  const report = (text, error = false, temporal = false) => { if(autoSaving && error && !temporal){feedback.textContent='内容已自动保存为草稿，填写完整后自动更新标注。';feedback.hidden=false;feedback.classList.remove('error');return;}feedback.textContent = text; feedback.hidden = !text; feedback.classList.toggle('error', error); };
  const seekFromTimeline = (timeline, time) => {
    const result = seekTimeline?.(timeline, time);
    if (result === false) report('当前素材不覆盖该时间位置；可通过条目中的支持证据回看对应素材。');
    return result;
  };
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
  const evidenceLabel = entry => {const display=annotationNodePresentation(ws(),'evidence',entry);return `${display.id} · ${display.content} · ${numberText(entry.start_time)}–${numberText(entry.end_time)}`;};
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
    if (hint) element.title = hint;
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
        if(['g-fact-evidence','g-event-facts','g-state-facts','g-state-events'].includes(id)){
          card.tabIndex=0;card.dataset.referenceId=option.value;card.dataset.referenceControl=id;
          const context=()=>JSON.stringify([ws().id,activeStage,selected[activeStage==='facts'?'fact':activeStage==='events'?'event':'emotion_state']||'',currentItemID()]);
          const selectReference=()=>{if(!optionNodes.get(option.value).selected)return;referenceDeletion={control:id,id:option.value,context:context()};for(const other of root.querySelectorAll('.g-selected-reference'))other.classList.remove('g-selected-reference');card.classList.add('g-selected-reference');};
          if(referenceDeletion?.control===id && referenceDeletion.id===option.value && referenceDeletion.context===context())card.classList.add('g-selected-reference');
          card.addEventListener('click',event=>{if(event.target.closest('button,input')||!optionNodes.get(option.value).selected)return;event.preventDefault();selectReference();card.focus({preventScroll:true});},true);
          card.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ') && event.target===card){event.preventDefault();selectReference();}});
          card.title='已勾选的上级可再次点击选中关联，退格仅解除这一条关联';
        }
        const label = node('label', 'g-choice-check'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = option.value;
        checkbox.setAttribute('aria-label', short(option.title || option.label, 200));
        const description = node('span', 'g-choice-description'); description.append(node('strong', '', short(option.title || option.label, 180)));
        if (option.content) description.append(node('span', 'g-choice-content', option.content));
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
  const entityOptions = () => visibleGraph().entities.map(entry => ({ value: entry.id, label: entry.name }));
  function inheritedSubject(id, candidatesFor, initial = [], { multiple = false, source = '证据', preserve = false, showIDs = false } = {}) {
    const wrapper = node('div', 'g-subject-lineage'); wrapper.dataset.controlId = id;
    const controlHost = node('div', 'g-subject-control'), summary = node('div', 'g-inherited-subject');
    wrapper.append(summary, controlHost);
    let candidates = [], current = [...initial], keepSaved = preserve;
    const available = () => mergeSubjects(mergeSubjects(candidatesFor(), savedSubjects(visibleGraph().entities.map(e=>e.id))), keepSaved ? savedSubjects(initial) : []);
    const read = () => { const control = wrapper.querySelector(`#${id}`); return !control ? [] : multiple ? [...control.selectedOptions].map(option => option.value) : control.value ? [control.value] : []; };
    function paint() {
      candidates = available();
      const allowed = new Set(candidates.map(candidate => candidate.id));
      current = current.filter(id => allowed.has(id));
      if (!current.length && candidates.length === 1 && (!keepSaved || !initial.length) && !wrapper.dataset.allowEmpty) current = [candidates[0].id];
      const options = candidates.map(candidate => ({ value: candidate.id, label: showIDs ? `${candidate.name} · ${candidate.id}` : candidate.name }));
      const selector = select(id, multiple ? options : [{ value: '', label: candidates.length ? '选择本条对应的主体' : '尚无已标主体' }, ...options], multiple ? current : current[0] || '', multiple);
      const control = multiple ? selector.querySelector('select') : selector;
      control.classList.add('g-subject-input');
      controlHost.replaceChildren(selector);
      const single = candidates.length === 1 && current.length === 1;
      wrapper.classList.toggle('is-single', single); wrapper.classList.toggle('is-empty', !candidates.length);
      if (!multiple) { control.tabIndex = single || !candidates.length ? -1 : 0; control.setAttribute('aria-hidden', String(single || !candidates.length)); }
      summary.replaceChildren();
      if (single) { summary.append(node('strong', '', showIDs ? `${candidates[0].name} · ${candidates[0].id}` : candidates[0].name)); }
      summary.hidden = !single;

      control.addEventListener('change', () => { current = read(); });
      return control;
    }
    paint();
    const nameInput=input(`${id}-name`);nameInput.placeholder='名字 + 回车';nameInput.title='回车添加；空输入框中按退格移除最后一个主体';nameInput.setAttribute('aria-label','输入新主体名字');wrapper.append(nameInput);
    nameInput.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='Enter'){event.preventDefault();const name=nameInput.value.trim();if(!name || name.length>500)return;let entity=visibleGraph().entities.find(entity=>entity.name===name);if(!entity){entity={id:nextAnnotationId(ws(),'entity'),name,aliases:[],item_id:currentItemID()};graph().entities.push(entity);graph().status='draft';}
        current=multiple?[...new Set([...read(),entity.id])]:[entity.id];nameInput.value='';const control=paint();control.dispatchEvent(new Event('change',{bubbles:true}));
      }else if(event.key==='Backspace' && !nameInput.value){event.preventDefault();current=read().slice(0,-1);wrapper.dataset.allowEmpty='true';const control=paint();control.dispatchEvent(new Event('change',{bubbles:true}));}
    });
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
  const factOptions = () => visibleGraph().facts.map(entry => ({ value: entry.id, label: short(entry.text, 85), title: entry.text || '未填写事实', meta: entry.subject_ids.map(entityName).join('、') || '未指定主体' }));
  const eventOptions = () => visibleGraph().events.map(entry => ({ value: entry.id, label: entry.title, title: entry.title, meta: entry.subject_ids.map(entityName).join('、') }));
  const evidenceOptions = () => evidence().map(entry => {const display=annotationNodePresentation(ws(),'evidence',entry),shifted=entry.start_time!==entry.global_start_time||entry.end_time!==entry.global_end_time;return {value:entry.id,label:evidenceLabel(entry),kind:'evidence',title:`${display.id} · ${MODALITY_NAME[entry.modality]||'证据'}`,content:display.content,meta:`${numberText(entry.start_time)}–${numberText(entry.end_time)}${shifted?` · 对齐 ${numberText(entry.global_start_time)}–${numberText(entry.global_end_time)}`:''}`};});
  const multipleHint = '';
  function reviewField(prefix, initial = 'needs_review') {
    return input(`${prefix}-review`, initial, 'hidden');
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
        ? JSON.stringify([entry.from_type, entry.from_id, entry.to_type, entry.to_id, entry.type, entry.note ?? null,entry.content_influence??null,entry.content_refs??null])
        : nodeSignature(entry, true)).sort();
    }
    return JSON.stringify(result);
  }
  function changedGraph(mutator, message, context = savingContext, validationContext = context) {
    const workspace = ws(), previous = structuredClone({ graph: workspace.graph, records: workspace.records, manifest: workspace.manifest });
    const previousSelection = { ...selected }, conflictKey = JSON.stringify([workspace.id, validationContext?.type || activeStage, validationContext?.id || '']);
    try {
      captureFields();
      workspace.graph.status = 'draft'; mutator();
      const graphModified = graphSignature(previous.graph) !== graphSignature(workspace.graph);
      const modified = graphModified || JSON.stringify(previous.records) !== JSON.stringify(workspace.records) || JSON.stringify(previous.manifest) !== JSON.stringify(workspace.manifest);
      if (!graphModified) workspace.graph.status = previous.graph.status;
      workspace.graph = normalizeGraph(workspace.graph, workspace);
      assertTemporalOrder(workspace);
      const clearedConflict=temporalConflicts.delete(conflictKey);
      if (context) clearFormContext(context.type, context.id);
      pruneRemovedContexts(); renderedContext = null;
      storeFormDrafts();
      if(clearedConflict&&!modified)persistDraft?.();
      if (modified) Promise.resolve(changed()).catch(error => report(error.message || '浏览器草稿保存失败，请导出结果', true));
      render(); const remaining=[...temporalConflicts.values()].find(entry=>entry.itemID===currentItemID());report(remaining?remaining.error.message:message,!!remaining,!!remaining);
      if (['fact', 'mention', 'entity'].includes(context?.type)) onFactSaved?.(context.type === 'fact' ? selected.fact : undefined);
      return true;
    } catch (error) {
      workspace.graph = previous.graph; workspace.records = previous.records; workspace.manifest = previous.manifest; Object.assign(selected, previousSelection);
      if (error.code === 'TEMPORAL_ORDER') temporalConflicts.set(conflictKey, { error, itemID: currentItemID() });
      storeFormDrafts(); persistDraft?.();
      report(error.message || '修改未保存，请检查字段', true, error.code === 'TEMPORAL_ORDER'); return false;
    }
  }
  function editTimeline(request) {
    const saved = changedGraph(() => {
      const plan = planAnnotationTimeEdit(materialWorkspace(ws()), request);
      applyAnnotationTimePlan(ws(), plan);
      if (plan.state_updates.length) selected.emotion_state = plan.state_updates[0].id;
      else selected[request.type] = request.id;
      // Keep unsaved descriptions while replacing stale time fields for edited states.
      for (const state of plan.state_updates) for (const key of fieldDrafts.keys()) {
        const parts = JSON.parse(key);
        if (parts[1] === 'emotion_state' && parts[2] === state.id && ['g-state-start', 'g-state-end', 'g-state-review'].includes(parts[4])) {
          fieldDrafts.delete(key); dirtyFields.delete(key); fieldBaselines.delete(key);
        }
      }
      for(const fact of plan.fact_updates)for(const key of fieldDrafts.keys()){
        const parts=JSON.parse(key);if(parts[1]==='fact'&&parts[2]===fact.id&&(parts[4]==='g-fact-time-mode'||/^g-fact-time-(start|end)-/.test(parts[4]))){fieldDrafts.delete(key);dirtyFields.delete(key);fieldBaselines.delete(key);}
      }
    }, request.type === 'event' ? '事件时间已保存，构成事实和证据均保持不变' : request.type === 'fact' ? '事实时间已保存，证据保持不变' : '情感时间框已保存', null, {type:request.type,id:request.id});
    if (saved) onFactSaved?.();
  }
  function createTimelineDraft(stage, timeline, start, end) {
    const saved = changedGraph(() => {
      const entry = createAnnotationDraft(ws(), stage, timeline, start, end); selected[entry.type] = entry.id;
      if (stage === 'facts') factSeed = null;
    }, stage === 'emotions' ? '已新建情感时间窗，请补充主体、情感以及事实或事件依据' : '已新建时间窗与关联草稿，请补充证据类别、主体和事实描述', null);
    if (saved) onFactSaved?.();
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
    for (const id of unique) graph().links.push({ id: existing.find(link => link.from_id === id)?.id || nextAnnotationId(ws(), 'link'), from_type: fromType, from_id: id, to_type: toType, to_id: toID, type });
  }
  function upsert(type, entry) {
    const list = graph()[COLLECTION[type]], index = list.findIndex(current => current.id === entry.id);
    if (index >= 0) { if (nodeSignature(list[index], true) !== nodeSignature(entry, true)) list[index] = entry; } else list.push(entry);
    selected[type] = entry.id;
  }
  function remove(type, id, confirm=true) {
    if (!id || (confirm && !window.confirm(`删除这个${TYPE_NAME[type]}及其关联关系？`))) return;
    changedGraph(() => { removeGraphNode(ws(), COLLECTION[type], id); selected[type] = ''; }, `已删除${TYPE_NAME[type]}，关联关系已清理`, { type, id });
  }
  function stage(name) { autosave(); referenceDeletion=null;graphReferenceID=null;activeStage = name; feedback.hidden = true; render(); }
  function toggleStateSelection(id) {
    if (!find('emotion_state', id)) return;
    if (stateSelection.has(id)) stateSelection.delete(id); else stateSelection.add(id);
    render();
  }
  function selectionTools({compact=false}={}) {
    const tools = node('section', 'g-state-selection-tools'); tools.setAttribute('aria-label', '情感状态多选连边');
    tools.classList.toggle('compact',compact);
    const summary = node('strong', 'g-state-selection-count', `已选择 ${stateSelection.size} 个情感状态`); summary.setAttribute('role', 'status');
    const connect = button('连接选中状态', () => changedGraph(() => {connectEmotionStateSelection(ws(), [...stateSelection]);selectedEmotionEdge=graph().links.find(link=>link.type==='transitions_to'&&stateSelection.has(link.from_id)&&stateSelection.has(link.to_id))?.id||'';}, '已按时间顺序连接选中状态', null), 'g-button primary'); connect.id = 'g-connect-selected'; connect.disabled = compact ? stateSelection.size!==2 : stateSelection.size<2;
    tools.append(summary, connect, button('清空多选', () => { stateSelection.clear(); render(); }, 'g-button'));
    const labels = node('div', 'g-state-selection-tags');
    for (const id of stateSelection) labels.append(button(`${labelFor('emotion_state', id)} ×`, () => toggleStateSelection(id), 'g-chip'));
    if(!compact)tools.append(labels); return tools;
  }
  function openNode(type, id) {
    referenceDeletion=null;graphReferenceID=null;
    if(type==='emotion_state')selectedEmotionEdge='';
    if (type === 'evidence') return playEvidence(id);
    if (type === 'emotion_transition' || type === 'emotion_relation') {
      const entry = type === 'emotion_transition' ? find(type, id) : graph().links.find(link => link.id === id);
      if (entry) { selected.emotion_state = entry.to_state_id || entry.to_id; stage('emotions'); return; }
    }
    selected[type] = id;
    if (type === 'entity' || type === 'mention') { stage('evidence'); report('主体在证据与事实中维护；原有证据提及与媒体对齐信息保留在数据中。'); return; }
    stage(type === 'fact' ? 'facts' : type === 'event' ? 'events' : 'emotions');
  }
  async function playEvidence(id) {
    const entry = find('evidence', id); if (!entry) return report('证据时间窗已不存在', true);
    try { stage('evidence'); await navigateEvidence(entry.item_id, entry.segment_id); }
    catch (error) { report(error.message || '无法回到证据窗口', true); }
  }
  function nodeList(type, title) {
    const times = type === 'event' ? eventTimeRanges(ws(), graph()) : {};
    const entries = visibleGraph()[COLLECTION[type]];
    const sidebar = node('aside', 'g-node-list'); sidebar.dataset.recordType = type;
    const top = node('div', 'g-list-top'); top.append(node('h3', '', `${title}（${entries.length}）`), button(`新增${title}`, () => { selected[type] = ''; if (type === 'fact') factSeed = null; render(); }, 'g-button small'));
    sidebar.append(top);
    if (selected[type]) sidebar.append(button(type === 'emotion_state' ? '删除当前编辑状态' : `删除选中${title}`, () => remove(type, selected[type]), 'g-link danger g-list-remove'));
    const list = node('div', 'g-node-scroll');
    for (const entry of entries) {
      const item = button('', () => { referenceDeletion=null;graphReferenceID=null;if (['emotion_state', 'emotion_transition'].includes(type)) return openNode(type, entry.id); selected[type] = entry.id; if (type === 'fact') factSeed = null; render(); }, 'g-node' + (selected[type] === entry.id ? ' active' : ''));
      const display=annotationNodePresentation(ws(),type,entry);
      if(type==='fact'){item.dataset.factKind=entry.kind;item.style.setProperty('--node-color',display.color);item.style.borderLeft=`3px solid ${display.color}`;}
      item.dataset.nodeId = entry.id; item.append(node('strong', '', display.cardHeading),node('span','g-node-description',display.content));
      item.append(node('small', 'g-node-id', type==='emotion_state'?entry.id:`参与主体：${display.subjects}`));
      if(display.tag) item.append(node('small','g-node-type-tag',display.tag));
      if (type === 'event') item.append(node('small', 'g-event-time', times[entry.id].time_ranges.length ? times[entry.id].time_ranges.map(rangeText).join(' ∪ ') : '时间待补充'));
      if (type === 'emotion_state') {
        const row = node('div', 'g-state-choice-row'), check = node('input'); check.type = 'checkbox'; check.checked = stateSelection.has(entry.id); check.dataset.stateId = entry.id;
        check.setAttribute('aria-label', `选择状态用于连边：${labelFor(type, entry.id)}`); check.addEventListener('change', () => toggleStateSelection(entry.id));
        row.append(check, item); list.append(row);
      } else list.append(item);
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
  function boundsForFacts(ids) {const times=factTimeRanges(ws()), chosen=ids.map(id=>times[id]);if(!chosen.length||chosen.some(t=>!t?.time_ranges.length))return null;requireValue(chosen.every(t=>t.timeline_id===chosen[0].timeline_id),'所选事实属于不同时间轴');return {timeline_id:chosen[0].timeline_id,start_time:Math.min(...chosen.flatMap(t=>t.time_ranges.map(r=>r.start_time))),end_time:Math.max(...chosen.flatMap(t=>t.time_ranges.map(r=>r.end_time)))};}

  function factsPanel() {
    const layout = node('div', 'g-editor-layout'); layout.append(nodeList('fact', '事实'));
    const form = node('div', 'g-card g-form');
    const fact = find('fact', selected.fact), seed = fact ? null : factSeed;
    const refs = fact ? linksTo('fact', fact.id, 'evidence').map(link => link.from_id) : seed?.evidence_ids || [];
    form.append(node('h3', '', fact ? '编辑事实' : '新增事实'));
    form.append(field('客观事实描述', textarea('g-fact-text', fact?.text || seed?.text || '')), field('事实类型', select('g-fact-kind', [{ value: 'observation', label: '观察事实' }, { value: 'reported_speech', label: '人物陈述 / 转述事实' }], fact?.kind || 'observation')));
    const candidateSubjects = () => { const ids = form.querySelector('#g-fact-evidence') ? values('g-fact-evidence') : refs; return ids.length ? subjects.fromEvidence(ids) : taskSubjects(); };
    const subjectField = inheritedSubject('g-fact-subjects', candidateSubjects, fact?.subject_ids || seed?.subject_ids || [], { multiple: true, source: '证据', preserve: !!fact });
    const speakerField = inheritedSubject('g-fact-speaker', candidateSubjects, fact?.speaker_id ? [fact.speaker_id] : [], { source: '证据', preserve: !!fact });
    const pair = node('div', 'g-form-pair'); pair.append(field('事实主体', subjectField), field('发言者（人物陈述）', speakerField, '被描述主体与发言者分别记录；观察事实不保存发言者。')); form.append(pair);
    form.append(field('支持证据', select('g-fact-evidence', evidenceOptions(), refs, true), '可勾选多个已对齐的音视频窗；同一证据可支持不同事实。'), reviewField('g-fact', fact?.review_status));
    const temporal=node('details','g-fact-temporal'),mode=select('g-fact-time-mode',[{value:'evidence',label:'默认：沿用证据呈现时间'},{value:'independent',label:'单独指定事实发生时间'}],fact?.time_ranges?.length?'independent':'evidence');
    temporal.open=!!fact?.time_ranges?.length;temporal.append(node('summary','',`事实发生时间 · ${fact?.time_ranges?.length?'单独指定':'沿用证据'}`));
    const timing=fact?factTimeRanges(ws())[fact.id]:null,ranges=timing?.time_ranges||[],timeControls=[];
    temporal.append(node('h4','','事实发生时间'),field('时间设置',mode),node('p','g-hint','证据与事实的时间窗可以不同，但证据的结束时间不能晚于事实。'));
    for(const [index,range] of (ranges.length?ranges:[{start_time:'',end_time:''}]).entries()){
      const start=input(`g-fact-time-start-${index}`,range.start_time,'number'),end=input(`g-fact-time-end-${index}`,range.end_time,'number'),pair=node('div','g-form-pair');
      start.disabled=end.disabled=mode.value!=='independent';pair.append(field(`发生起点 ${ranges.length>1?index+1:''} / 秒`,start),field(`发生终点 ${ranges.length>1?index+1:''} / 秒`,end));timeControls.push({start,end});temporal.append(pair);
    }
    const timeNote=textarea('g-fact-time-note',fact?.time_note||'',2),timeWarning=node('p','g-temporal-warning'),presentation=node('p','g-derived-time');timeWarning.id='g-fact-time-warning';presentation.id='g-fact-evidence-time';
    temporal.append(presentation,timeWarning,field('时间说明',timeNote,'发生时间与证据不相交时请说明原因，例如后续回述、回忆或前提证据。'));form.append(temporal);
    const updateTimeFeedback=()=>{try{
      const evidenceIDs=values('g-fact-evidence'),bounds=evidenceTimeRanges(ws(),evidenceIDs),windows=evidence().filter(entry=>evidenceIDs.includes(entry.id));
      presentation.textContent=bounds?`证据呈现时间：${bounds.time_ranges.map(rangeText).join(' ∪ ')}`:'尚未选择支持证据';
      for(const controls of timeControls){controls.start.disabled=controls.end.disabled=mode.value!=='independent';}
      const occurrence=timeControls.filter(({start,end})=>start.value!==''&&end.value!=='').map(({start,end})=>({start_time:Number(start.value),end_time:Number(end.value)}));
      const mismatch=mode.value==='independent'&&occurrence.length&&windows.some(window=>!occurrence.some(range=>range.start_time<window.global_end_time&&range.end_time>window.global_start_time));
      const latestEnd=occurrence.length?Math.max(...occurrence.map(range=>range.end_time)):null;
      const late=mode.value==='independent'&&latestEnd!==null&&windows.find(window=>window.global_end_time>latestEnd+1e-6);
      timeWarning.hidden=!mismatch&&!late;timeWarning.textContent=late?`证据 ${late.segment_id} 的结束时间晚于事实，请调整时间窗或取消该关联后再保存。`:mismatch?(timeNote.value.trim()?'事实与证据时间不相交；已记录说明。':'事实与证据时间不相交，请填写时间说明。'):'';timeNote.required=!!mismatch&&!late;
    }catch(error){timeWarning.hidden=false;timeWarning.textContent=error.message;}};
    temporal.addEventListener('input',updateTimeFeedback);temporal.addEventListener('change',updateTimeFeedback);form.querySelector('#g-fact-evidence').addEventListener('change',updateTimeFeedback);queueMicrotask(()=>{if(activeStage==='facts')updateTimeFeedback();});
    form.querySelector('#g-fact-kind').addEventListener('change', () => { speakerField.closest('.g-field').hidden = value('g-fact-kind') !== 'reported_speech'; });
    form.querySelector('#g-fact-evidence').addEventListener('change', () => { subjectField.refreshSubjects(true); speakerField.refreshSubjects(true); });
    trackForm(form, 'g-fact');
    saveActions(form, 'fact', () => changedGraph(() => {
      const text = value('g-fact-text').trim(), subjects = values('g-fact-subjects'), evidenceIDs = values('g-fact-evidence'), kind = value('g-fact-kind'), speaker = value('g-fact-speaker');
      if(!autoSaving){requireValue(text, '请填写事实描述'); requireValue(subjects.length, '请至少选择一个主体'); requireValue(evidenceIDs.length, '请选择支持事实的证据窗');
      if (kind === 'reported_speech') requireValue(speaker, '陈述事实必须注明说话主体');}
      subjectField.commitSubjects(); if (kind === 'reported_speech') speakerField.commitSubjects();
      const id = fact?.id || nextAnnotationId(ws(), 'fact'), entry = { ...(fact || {}), id, text, subject_ids: subjects, kind, speaker_id: kind === 'reported_speech' ? speaker : '', review_status: value('g-fact-review'), ...(fact ? fact.item_id ? { item_id: fact.item_id } : {} : { item_id: currentItemID() }) };
      entry.time_note=value('g-fact-time-note').trim();
      if(value('g-fact-time-mode')==='independent'){
        entry.time_ranges=timeControls.map(({start,end})=>{requireValue(start.value!==''&&end.value!==''&&Number.isFinite(Number(start.value))&&Number.isFinite(Number(end.value))&&Number(end.value)>Number(start.value),'请填写有效的事实发生时间，终点须大于起点');return {start_time:Number(start.value),end_time:Number(end.value)};});
        entry.timeline_id=fact?.timeline_id||evidenceTimeRanges(ws(),evidenceIDs)?.timeline_id||ws().manifest.items[ws().index||0].timeline_id;
      }else{delete entry.time_ranges;delete entry.timeline_id;}
      if (fact && (nodeSignature(fact) !== nodeSignature(entry) || !sameMembers(refs, evidenceIDs))) markDependents('fact', id);
      upsert('fact', entry);
      replaceLinks('fact', id, 'evidence', evidenceIDs, 'supports'); factSeed = null;
      for (const [itemID, record] of Object.entries(ws().records)) for (const segment of record.segments) {
        if (segment.annotations.fact_id !== id) continue;
        if (!evidenceIDs.includes(JSON.stringify([itemID, segment.id]))) delete segment.annotations.fact_id;
      }
    }, '事实已保存，引用关系可在关联图谱中查看'));
    partitionForm(form, 'fact', ['g-fact-kind', 'g-fact-subjects', 'g-fact-speaker', 'g-fact-review']);
    layout.prepend(form); return layout;
  }

  function eventsPanel() {
    const layout = node('div', 'g-editor-layout'); layout.append(nodeList('event', '复合事件'));
    const form = node('div', 'g-card g-form'), event = find('event', selected.event);
    const refs = event ? linksTo('event', event.id, 'fact').map(link => link.from_id) : [];
    form.append(node('h3', '', event ? '编辑复合事件' : '新增复合事件'));
    const subjectField = inheritedSubject('g-event-subjects', () => { const ids = form.querySelector('#g-event-facts') ? values('g-event-facts') : refs; return ids.length ? subjects.fromFacts(ids) : taskSubjects(); }, event?.subject_ids || [], { multiple: true, source: '事实', preserve: !!event });
    form.append(field('事件名称 / 简练描述', textarea('g-event-title', event?.title || '', 2)), field('参与主体', subjectField), field('构成这个事件的事实', select('g-event-facts', factOptions(), refs, true), multipleHint));
    const timing = node('p', 'g-derived-time');
    function updateTiming() { try {
      const ids = values('g-event-facts');
      const planned={...graph(),events:[{...(event||{}),id:event?.id||'event-preview'}],links:graph().links.filter(link=>!(link.to_type==='event' && link.to_id===event?.id))};
      planned.links.push(...ids.map(id=>({from_type:'fact',from_id:id,to_type:'event',to_id:event?.id||'event-preview',type:'constitutes'})));
      const ranges=eventTimeRanges(ws(),planned)[event?.id||'event-preview'];
      timing.textContent = ranges.time_ranges.length ? `发生时间：${ranges.time_ranges.map(rangeText).join(' ∪ ')}` : '发生时间：待选择构成事实';
    } catch (error) { timing.textContent = error.message; } }
    form.append(timing, reviewField('g-event', event?.review_status));
    trackForm(form, 'g-event');
    form.querySelector('#g-event-facts').addEventListener('change', () => { subjectField.refreshSubjects(true); updateTiming(); });
    saveActions(form, 'event', () => changedGraph(() => {
      const title = value('g-event-title').trim(), subjects = values('g-event-subjects'), facts = values('g-event-facts');
      if(!autoSaving)requireValue(title && subjects.length && facts.length, '请填写事件描述，并选择参与主体及构成事实');
      const current=ws().manifest.items[ws().index||0],bounds = boundsForFacts(facts) || (autoSaving?{timeline_id:event?.timeline_id||current.timeline_id||current.source_id||current.id}:null); requireValue(bounds, '所选事实尚无时间，无法确定事件时间轴');
      subjectField.commitSubjects();
      const id = event?.id || nextAnnotationId(ws(), 'event'), entry = { ...(event||{}),id, title, subject_ids: subjects, timeline_id: bounds.timeline_id, review_status: value('g-event-review'), ...(event ? event.item_id ? { item_id: event.item_id } : {} : { item_id: currentItemID() }) };
      if (event && (nodeSignature(event) !== nodeSignature(entry) || !sameMembers(refs, facts))) markDependents('event', id);
      upsert('event', entry);
      replaceLinks('event', id, 'fact', facts, 'constitutes');
    }, '复合事件已保存，构成事实保持独立'));
    partitionForm(form, 'event', ['g-event-subjects', 'g-event-review']);
    layout.prepend(form); queueMicrotask(() => { if (activeStage === 'events') updateTiming(); }); return layout;
  }

  function emotionEdgeEditor(link) {
    const editor=node('section','g-emotion-edge-editor g-state-edge-list');editor.dataset.edgeId=link.id;
    editor.append(node('h4','','关联依据'));
    const prefix=`emotion-edge-${[...new TextEncoder().encode(link.id)].map(b=>b.toString(16).padStart(2,'0')).join('')}`;
    const save=(mutator,control)=>{
      const caret=control?.tagName==='TEXTAREA'?{id:control.id,start:control.selectionStart,end:control.selectionEnd}:null;
      changedGraph(()=>{const edge=find('link',link.id);if(edge)mutator(edge);},'情感变化依据已自动保存',null);
      if(caret){const target=document.getElementById(caret.id);target?.focus({preventScroll:true});target?.setSelectionRange(caret.start,caret.end);}
    };
    for(const [type,options] of [['evidence',evidenceOptions()],['fact',factOptions()],['event',eventOptions()]]){
      const picker=select(`${prefix}-${type}`,options.map(option=>{const source=find(type,option.value),display=annotationNodePresentation(ws(),type,source);return {...option,title:`${display.id} · ${display.content}`,...(type==='evidence'?{meta:`${Math.round(source.global_start_time)}s–${Math.round(source.global_end_time)}s`}:{})};}),(link.content_refs||[]).filter(ref=>ref.node_type===type).map(ref=>ref.node_id),true);
      picker.querySelector('select').addEventListener('change',event=>{const ids=[...event.target.selectedOptions].map(option=>option.value);save(edge=>{const previous=edge.content_refs||[];edge.content_refs=[...previous.filter(ref=>ref.node_type!==type),...ids.map(id=>previous.find(ref=>ref.node_type===type&&ref.node_id===id)||{node_type:type,node_id:id,relation:'associated_with',note:''})];});});
      editor.append(field(`对应${TYPE_NAME[type]}`,picker));
    }
    const relationOptions=[{value:'associated_with',label:'有关联，未断言影响'},{value:'influences',label:'影响本次情感变化'},{value:'unrelated',label:'无关联／无影响'},{value:'insufficient_evidence',label:'证据不足'}];
    for(const [index,ref] of (link.content_refs||[]).entries()){
      const source=find(ref.node_type,ref.node_id);if(!source)continue;
      const display=annotationNodePresentation(ws(),ref.node_type,source),row=node('section','g-edge-content-ref');row.dataset.refType=ref.node_type;row.dataset.refId=ref.node_id;
      row.append(node('strong','',`${TYPE_NAME[ref.node_type]} · ${display.heading}`),node('p','',display.content));
      if(ref.node_type==='event'&&ref.relation==='influences'){
        const notice=eventChronologyNotice(ref.node_id,find('emotion_state',link.to_id)?.end_time);if(notice)row.append(node('p','g-temporal-warning',notice));
      }
      const relation=select(`${prefix}-relation-${index}`,relationOptions,ref.relation),reason=textarea(`${prefix}-reason-${index}`,ref.note,2);
      relation.addEventListener('change',()=>save(edge=>{edge.content_refs.find(entry=>entry.node_type===ref.node_type&&entry.node_id===ref.node_id).relation=relation.value;}));
      reason.addEventListener('input',()=>save(edge=>{edge.content_refs.find(entry=>entry.node_type===ref.node_type&&entry.node_id===ref.node_id).note=reason.value;},reason));
      row.append(field('与本次变化的关系',relation),field('逐项判断依据',reason),button('查看／编辑原节点',()=>openNode(ref.node_type,ref.node_id),'g-link'),button('移除对应关系',()=>save(edge=>{edge.content_refs=edge.content_refs.filter(entry=>entry.node_type!==ref.node_type||entry.node_id!==ref.node_id); }),'g-link danger'));editor.append(row);
    }
    const note=textarea(`${prefix}-note`,link.note||'',3);note.addEventListener('input',()=>save(edge=>{edge.note=note.value;},note));editor.append(field('本次情感变化的说明／综合判断依据',note));
    return editor;
  }

  function eventChronologyNotice(eventID,targetEnd){
    const timing=eventTimeRanges(ws())[eventID];
    if(!timing?.time_ranges.length)return '事件发生时间尚未完整确定，请补充构成事实；证据呈现先后不代替事件发生先后。';
    if(Number.isFinite(Number(targetEnd))&&timing.time_ranges.every(range=>range.start_time>Number(targetEnd)+.001))return '时序冲突：事件完全发生在目标情感状态结束之后，请核对发生时间或影响判断。后续回述证据本身不构成冲突。';
    return '';
  }

  function emotionsPanel() {
    const panel = node('div', 'g-emotions');
    const layout = node('div', 'g-editor-layout'),sidebar=nodeList('emotion_state', '情感状态'); layout.append(sidebar);
    sidebar.append(selectionTools({compact:true}));
    const form = node('div', 'g-card g-form'), state = find('emotion_state', selected.emotion_state);
    const refs = state ? linksTo('emotion_state', state.id, 'fact').map(link => link.from_id) : [];
    const eventLinks = state ? linksTo('emotion_state', state.id, 'event') : [];
    const stateEvents = eventLinks.map(link => link.from_id);
    const current=ws().manifest.items[ws().index||0],timeline=state?.timeline_id || current.timeline_id || current.source_id || current.id;
    form.append(node('h3', '', state ? '编辑情感状态' : '新增情感状态'));
    const subjectField = inheritedSubject('g-state-subject', () => {
      const facts = form.querySelector('#g-state-facts') ? values('g-state-facts') : refs;
      const events = form.querySelector('#g-state-events') ? values('g-state-events') : stateEvents;
      return facts.length ? subjects.fromFacts(facts) : events.length ? subjects.fromEvents(events) : taskSubjects();
    }, state?.subject_id ? [state.subject_id] : [], { source: '事实或事件', preserve: !!state, showIDs: true });
    const first = node('div', 'g-form-pair'); first.append(field('主体', subjectField), field('情感标签', input('g-state-label', state?.label || ''))); form.append(first);
    form.append(input('g-state-timeline',timeline,'hidden'),field('强度（可选）',select('g-state-intensity',[{value:'',label:'未标强度'},...[1,2,3,4,5].map(n=>({value:String(n),label:String(n)}))],state?.intensity==null?'':String(state.intensity))));
    const times = node('div', 'g-form-pair'); times.append(field('观测起点 / 秒', input('g-state-start', state?.start_time ?? '', 'number')), field('观测终点 / 秒', input('g-state-end', state?.end_time ?? '', 'number'))); form.append(times);
    form.append(field('情感判断的事实依据', select('g-state-facts', factOptions(), refs, true)));
    const eventPicker = select('g-state-events', eventOptions(), stateEvents, true), eventSelect = eventPicker.querySelector('select');
    const factSelect = form.querySelector('#g-state-facts');
    let previousEvents = new Set(stateEvents);
    eventSelect.addEventListener('change', () => {
      const chosen = new Set([...eventSelect.selectedOptions].map(option => option.value));
      const added = new Set([...chosen].filter(id => !previousEvents.has(id)));
      previousEvents = chosen;
      const defaults = new Set(graph().links.filter(link => link.from_type === 'fact' && link.to_type === 'event' && link.type === 'constitutes' && added.has(link.to_id)).map(link => link.from_id));
      if (!defaults.size) return;
      for (const option of factSelect.options) if (defaults.has(option.value)) option.selected = true;
      factSelect.dispatchEvent(new Event('input', {bubbles:true})); factSelect.dispatchEvent(new Event('change', {bubbles:true}));
    });
    // Restoring a draft must preserve manual exclusions instead of applying defaults again.
    eventSelect.addEventListener('graph:sync-options', () => { previousEvents = new Set([...eventSelect.selectedOptions].map(option => option.value)); });
    form.append(field('关联／导致该状态的复合事件', eventPicker));
    const relationPanel = node('section', 'g-event-relation-list'); relationPanel.id = 'g-state-event-relations';
    const relationValues = new Map(eventLinks.map(link => [link.from_id, { type: link.type, note: link.note || '' }]));
    const relationControls = new Map();
    const relationID = (kind, id) => `g-state-${kind}-` + [...new TextEncoder().encode(id)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    function syncRelations() {
      for (const [id, controls] of relationControls) relationValues.set(id, { type: controls.type.value, note: controls.note.value });
      const chosen = [...eventSelect.selectedOptions].map(option => option.value);
      for (const [id, controls] of relationControls) if (!chosen.includes(id)) for (const control of [controls.type, controls.note]) dirtyFields.delete(draftKey(control, formContext()));
      relationControls.clear(); relationPanel.replaceChildren();
      if (chosen.length) relationPanel.append(node('h4', '', '事件关系'));
      for (const id of chosen) {
        const saved = eventLinks.find(link => link.from_id === id), remembered = relationValues.get(id) || { type: 'associated_with', note: '' };
        const type = select(relationID('relation', id), [{ value: 'associated_with', label: '关联：不作因果断言' }, { value: 'causes', label: '导致：人工因果判断' }], remembered.type);
        const note = textarea(relationID('reason', id), remembered.note, 2);
        for (const [control, initial] of [[type, saved?.type || 'associated_with'], [note, saved?.note || '']]) {
          control.dataset.eventId = id;
          const key = draftKey(control, formContext());
          if (!fieldBaselines.has(key)) fieldBaselines.set(key, initial);
          if (dirtyFields.has(key) && fieldDrafts.has(key)) control.value = fieldDrafts.get(key);
          control.dataset.graphTracked = controlSignature(control);
        }
        const row = node('div', 'g-state-event-relation'); row.dataset.eventId = id;
        const chronology=node('p','g-temporal-warning'),updateChronology=()=>{const message=type.value==='causes'?eventChronologyNotice(id,value('g-state-end')):'';chronology.hidden=!message;chronology.textContent=message;};
        type.addEventListener('change',updateChronology);form.querySelector('#g-state-end').addEventListener('input',updateChronology);queueMicrotask(()=>{if(activeStage==='emotions')updateChronology();});
        row.append(node('strong', '', find('event', id)?.title || id), field('关系', type), field('判断依据（导致时必填）', note),chronology);
        relationPanel.append(row); relationControls.set(id, { type, note });
      }
    }
    eventSelect.addEventListener('change', syncRelations); eventSelect.addEventListener('graph:sync-options', syncRelations);
    syncRelations(); form.append(relationPanel);
    for (const id of ['g-state-facts', 'g-state-events']) form.querySelector(`#${id}`).addEventListener('change', () => subjectField.refreshSubjects(true));
    form.append(button('按所选依据填入时间', () => {
      try { const facts = values('g-state-facts'), events = new Set(values('g-state-events')); const fallback = graph().links.filter(link => link.from_type==='fact' && link.to_type==='event' && link.type==='constitutes' && events.has(link.to_id)).map(link=>link.from_id); const bounds = boundsForFacts(facts.length ? facts : fallback); requireValue(bounds, '先选择有证据的事实或复合事件'); root.querySelector('#g-state-timeline').value = bounds.timeline_id; root.querySelector('#g-state-start').value = bounds.start_time; root.querySelector('#g-state-end').value = bounds.end_time; root.querySelector('#g-state-review').value = 'needs_review'; }
      catch (error) { report(error.message, true); }
    }, 'g-link'), reviewField('g-state', state?.review_status));
    const changes=visibleGraph().links.filter(link=>link.type==='transitions_to'),slot=node('section','g-state-change-slot g-state-edge-list');slot.append(node('h4','',`状态连边（${changes.length}）`));
    for(const link of changes){
      const row=node('div','g-state-change-row');row.dataset.edgeId=link.id;const from=find('emotion_state',link.from_id),to=find('emotion_state',link.to_id);
      const controlID=`emotion-edge-impact-${[...new TextEncoder().encode(link.id)].map(b=>b.toString(16).padStart(2,'0')).join('')}`,impact=select(controlID,[{value:'',label:'未标注'},{value:'yes',label:'有影响'},{value:'no',label:'无影响'},{value:'insufficient_evidence',label:'证据不足'}],link.content_influence||'');impact.dataset.edgeId=link.id;impact.setAttribute('aria-label','视频内容是否影响这次情感变化');
      impact.addEventListener('change',()=>{const value=impact.value;changedGraph(()=>{const edge=graph().links.find(edge=>edge.id===link.id);if(value)edge.content_influence=value;else delete edge.content_influence;},'内容影响已自动保存',null);root.querySelector(`#${controlID}`)?.focus({preventScroll:true});});
      const choose=button(`${from?.id||'?'} · ${from?.label||''} → ${to?.id||'?'} · ${to?.label||''}`,()=>{selectedEmotionEdge=link.id;render();},'g-link g-edge-select');choose.setAttribute('aria-pressed',String(selectedEmotionEdge===link.id));
      row.append(choose,field('视频内容影响（整体判断，可选）',impact),button('删除连边',()=>changedGraph(()=>removeGraphNode(ws(),'link',link.id),'情感连边已删除',null),'g-link danger'));slot.append(row);
    }
    if(!changes.length)slot.append(node('p','g-hint','暂无连边'));sidebar.append(slot);
    const editingEdge=changes.find(link=>link.id===selectedEmotionEdge);
    if(editingEdge){
      const edgeForm=node('section','g-card g-emotion-edge-form'),states=node('div','g-edge-state-summary');states.setAttribute('aria-label','所选连边连接的情感状态');
      edgeForm.append(node('h3','','编辑情感变化'));
      for(const side of ['from','to']){const state=find('emotion_state',editingEdge[`${side}_id`]);if(!state)continue;const entry=node('div','g-edge-state-panel');entry.append(node('strong','',`${entityName(state.subject_id)} · ${state.id}`),node('p','g-edge-state-label',state.label),node('small','',`${numberText(state.start_time)}–${numberText(state.end_time)}`));if(states.childElementCount)states.append(node('span','g-state-direction','→'));states.append(entry);}
      edgeForm.append(states,emotionEdgeEditor(editingEdge));layout.prepend(edgeForm);panel.append(layout);return panel;
    }
    const legacy = state ? graph().emotion_transitions.filter(entry => entry.from_state_id === state.id || entry.to_state_id === state.id) : [];
    if (legacy.length) {
      const history = node('details', 'g-state-history'); history.append(node('summary', '', `历史情感变化记录（${legacy.length}，原样保留）`));
      for (const entry of legacy) {
        history.append(node('p', 'g-hint', `${labelFor('emotion_transition', entry.id)} · ${entry.note || '未填写说明'}`));
        for (const link of linksTo('emotion_transition', entry.id, 'event')) history.append(node('p', 'g-hint', `${labelFor('event', link.from_id)} · ${RELATION_NAME[link.type] || link.type}`));
      }
      form.append(history);
    }
    trackForm(form, 'g-state');
    saveActions(form, 'emotion_state', () => changedGraph(() => {
      const subject = value('g-state-subject'), label = value('g-state-label').trim(), timeline = value('g-state-timeline'), start = value('g-state-start'), end = value('g-state-end'), facts = values('g-state-facts'), events = values('g-state-events');
      if(!autoSaving)requireValue(subject && label && timeline && start !== '' && end !== '' && (facts.length || events.length), '请填写主体、情感、时间，并至少选择一条事实或一个复合事件作为依据');
      requireValue(timeline && start!=='' && end!=='','请先标注情感时间窗');
      requireValue(Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(end) > Number(start), '情感状态的终点必须大于起点');
      const desired = events.map(eventID => {
        const controls = relationControls.get(eventID), previous = eventLinks.find(link => link.from_id === eventID);
        const type = controls?.type.value || 'associated_with', note = controls?.note.value || '';
        requireValue(type !== 'causes' || note.trim(), '导致该状态的每个事件都需要填写因果判断依据');
        return { id: previous?.id || nextAnnotationId(ws(), 'link'), from_type: 'event', from_id: eventID, to_type: 'emotion_state', to_id: state?.id || '', type, ...(note || Object.hasOwn(previous || {}, 'note') ? { note } : {}) };
      });
      subjectField.commitSubjects();
      const id = state?.id || nextAnnotationId(ws(), 'emotion_state'), entry = { id, subject_id: subject, label, timeline_id: timeline, start_time: Number(start), end_time: Number(end), intensity: value('g-state-intensity') === '' ? null : Number(value('g-state-intensity')), review_status: value('g-state-review'), ...(state ? state.item_id ? { item_id: state.item_id } : {} : { item_id: currentItemID() }) };
      for (const link of desired) link.to_id = id;
      const relationsChanged = desired.length !== eventLinks.length || desired.some(link => JSON.stringify(link) !== JSON.stringify(eventLinks.find(previous => previous.from_id === link.from_id)));
      if (state && (nodeSignature(state) !== nodeSignature(entry) || !sameMembers(refs, facts) || relationsChanged)) markDependents('emotion_state', id);
      upsert('emotion_state', entry); replaceLinks('emotion_state', id, 'fact', facts, 'grounds');
      if (relationsChanged || !state) { graph().links = graph().links.filter(link => !(link.to_type === 'emotion_state' && link.to_id === id && link.from_type === 'event')); graph().links.push(...desired); }
    }, '情感状态已保存'));
    partitionForm(form, 'emotion_state', ['g-state-subject', 'g-state-label', 'g-state-intensity', 'g-state-review']);
    layout.prepend(form); panel.append(layout); return panel;
  }

  function focusGraphNode(type,id,force=false) {
    if(!force && graphFocus && graphFocus.type!=='link' && (graphFocus.type!==type||graphFocus.id!==id)){
      const link=graph().links.find(link=>link.from_type===type && link.from_id===id && link.to_type===graphFocus.type && link.to_id===graphFocus.id && link.type!=='transitions_to');
      if(link){graphReferenceID=link.id;referenceDeletion=null;render();return;}
    }
    graphReferenceID=null;referenceDeletion=null;const category=type==='emotion_transition'?'emotion_state':type; if(graphCategory!==category){graphSearch='';graphListScroll=0;}graphFocus={type,id};graphCategory=category;render();
  }
  function factColorLegend(){const legend=node('div','g-fact-color-legend');for(const [kind,label] of [['observation','观察事实'],['reported_speech','转述事实']]){const entry=node('span','',label);entry.style.setProperty('--fact-color',FACT_COLORS[kind]);legend.append(entry);}return legend;}
  function directedGraph() {
    const section = node('section', 'g-card g-directed-graph');
    const current=ws().manifest.items[ws().index||0],preferred=current.timeline_id||current.source_id||current.id;
    const model = fourLayerTimeline(materialWorkspace(ws()), {timeline: graphTimeline||preferred, focus: graphFocus, range:graphRange,windowStart:graphWindowStart,windowSpan:graphWindowSpan});model.selectedReference=graphReferenceID; graphTimeline = model.timeline;graphWindowStart=model.low;
    const toolbar = node('div', 'g-graph-toolbar'); toolbar.append(node('h3', '', '关联图谱'));
    const controls = node('div', 'g-graph-size-controls');
    const all=button('展示完整关联图谱',()=>{graphFocus=null;graphReferenceID=null;referenceDeletion=null;render();});all.id='g-graph-show-all';
    const fullRange=button('全片范围',()=>{graphRange='full';render();});fullRange.id='g-graph-range-full';fullRange.setAttribute('aria-pressed',String(graphRange==='full'));
    const localRange=button('局部范围',()=>{graphRange='local';render();});localRange.id='g-graph-range-local';localRange.setAttribute('aria-pressed',String(graphRange==='local'));
    const spanInput=input('g-graph-window-span',model.high-model.low,'number');spanInput.min='.1';spanInput.step='.1';spanInput.max=model.fullHigh-model.fullLow;spanInput.disabled=graphRange==='full';
    const spanField=field('时间跨度 / 秒',spanInput);spanField.classList.add('g-graph-span-field');
    spanInput.addEventListener('change',()=>{const span=Number(spanInput.value);if(!Number.isFinite(span)||span<=0){spanInput.value=model.high-model.low;return;}const next=Math.max(.1,Math.min(span,model.fullHigh-model.fullLow));graphWindowStart=(model.low+model.high)/2-next/2;graphWindowSpan=next;graphRange='local';render();});
    const viewport = node('div', 'g-svg-viewport fit');viewport.dataset.sizeMode='fit'; viewport.innerHTML = serializeTimelineSVG(model);
    queueMicrotask(()=>{if(!viewport.isConnected)return;const fitType=()=>{const width=viewport.querySelector('svg')?.getBoundingClientRect().width;if(width>0)viewport.style.setProperty('--graph-text-scale',String(1450/width));};fitType();graphTypographyObserver=new ResizeObserver(fitType);graphTypographyObserver.observe(viewport);});
    const zoomWindow=event=>{
      if(event.ctrlKey||event.metaKey)return;event.preventDefault();
      const delta=event.deltaY||event.deltaX,unit=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1,total=model.fullHigh-model.fullLow;
      const span=graphRange==='local'?graphWindowSpan:model.high-model.low,next=Math.max(Math.min(.1,total),Math.min(total,span*Math.exp(Math.max(-1,Math.min(1,delta*unit*.002)))));
      const rect=viewport.getBoundingClientRect(),anchor=event.currentTarget===viewport?Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)):.5;
      graphWindowStart=Math.max(model.fullLow,Math.min(model.fullHigh-next,graphWindowStart+anchor*(span-next)));graphWindowSpan=next;graphRange=next>=total?'full':'local';
      if(!graphPanFrame)graphPanFrame=requestAnimationFrame(()=>{graphPanFrame=0;if(activeStage==='graph')render();});
    };
    viewport.addEventListener('wheel',zoomWindow,{passive:false});
    const svg = viewport.querySelector('svg');
    for (const item of svg.querySelectorAll('[data-node-type]')) {
      const focus = () => focusGraphNode(item.dataset.nodeType,item.dataset.nodeId);
      item.addEventListener('click', focus); item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();focus();} });
      item.addEventListener('dblclick',()=>focusGraphNode(item.dataset.nodeType,item.dataset.nodeId,true));
    }
    for(const item of svg.querySelectorAll('[data-edge-kind="emotion-transition"],[data-edge-hit]')){const select=()=>{graphReferenceID=null;referenceDeletion=null;graphFocus={type:'link',id:item.dataset.edgeId||item.dataset.edgeHit};graphCategory='emotion_state';graphSearch='';render();};item.addEventListener('click',select);item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}});}
    controls.append(all,fullRange,localRange,spanField);toolbar.append(controls);section.append(toolbar);
    const rangeControls=node('div','g-graph-window-control'),rangeLabel=node('output','g-graph-range-label'),track=node('div','g-graph-window-track'),windowBox=node('div','g-graph-window-box');
    rangeLabel.id='g-graph-range-label';rangeLabel.setAttribute('aria-live','polite');track.id='g-graph-window-track';windowBox.id='g-graph-window-box';windowBox.tabIndex=0;windowBox.setAttribute('role','slider');windowBox.setAttribute('aria-label','显示时间窗口，拖动平移，滚轮调整覆盖时长');windowBox.append(node('span','','⋮⋮'));
    const total=model.fullHigh-model.fullLow;let drag=null;
    const updateWindow=()=>{const span=graphRange==='full'?total:graphWindowSpan;windowBox.style.left=`min(${(graphWindowStart-model.fullLow)/total*100}%, calc(100% - 8px))`;windowBox.style.width=`${span/total*100}%`;windowBox.dataset.start=graphWindowStart;windowBox.dataset.end=graphWindowStart+span;windowBox.setAttribute('aria-valuemin',model.fullLow);windowBox.setAttribute('aria-valuemax',model.fullHigh-span);windowBox.setAttribute('aria-valuenow',graphWindowStart);windowBox.setAttribute('aria-valuetext',`${numberText(graphWindowStart)} 至 ${numberText(graphWindowStart+span)}`);rangeLabel.textContent=`${numberText(graphWindowStart)} → ${numberText(graphWindowStart+span)} · ${numberText(span)}`;};
    const previewWindow=()=>{updateWindow();const preview=fourLayerTimeline(materialWorkspace(ws()),{timeline:graphTimeline,focus:graphFocus,range:graphRange,windowStart:graphWindowStart,windowSpan:graphWindowSpan});preview.selectedReference=graphReferenceID;viewport.innerHTML=serializeTimelineSVG(preview);const svg=viewport.querySelector('svg');svg.dataset.rangeStart=preview.low;svg.dataset.rangeEnd=preview.high;};
    const finishWindow=()=>{drag=null;render();root.querySelector('#g-graph-window-box')?.focus({preventScroll:true});};
    track.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();const span=model.high-model.low,rect=track.getBoundingClientRect();drag={pointer:event.pointerId,x:event.clientX,start:graphWindowStart,span,width:rect.width};track.setPointerCapture(event.pointerId);if(!event.target.closest('.g-graph-window-box')){graphWindowStart=Math.max(model.fullLow,Math.min(model.fullHigh-span,model.fullLow+(event.clientX-rect.left)/rect.width*total-span/2));drag.start=graphWindowStart;previewWindow();}windowBox.classList.add('dragging');});
    track.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.pointer)return;graphWindowStart=Math.max(model.fullLow,Math.min(model.fullHigh-drag.span,drag.start+(event.clientX-drag.x)/drag.width*total));graphWindowSpan=drag.span;previewWindow();});
    track.addEventListener('pointerup',event=>{if(drag&&event.pointerId===drag.pointer)finishWindow();});
    track.addEventListener('pointercancel',()=>{if(drag){graphWindowStart=model.low;graphWindowSpan=model.high-model.low;finishWindow();}});
    track.addEventListener('lostpointercapture',()=>{if(drag)finishWindow();});
    windowBox.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const span=model.high-model.low,step=span*(event.shiftKey ? .25 : .05);graphWindowStart=Math.max(model.fullLow,Math.min(model.fullHigh-span,event.key==='Home'?model.fullLow:event.key==='End'?model.fullHigh-span:graphWindowStart+(event.key==='ArrowLeft'?-step:step)));render();root.querySelector('#g-graph-window-box')?.focus({preventScroll:true});});
    rangeControls.addEventListener('wheel',event=>{if(!drag)zoomWindow(event);else event.preventDefault();},{passive:false});
    track.append(windowBox);const ends=node('div','g-graph-window-ends');ends.append(node('span','',numberText(model.fullLow)),node('span','',numberText(model.fullHigh)));rangeControls.append(rangeLabel,track,ends);updateWindow();section.append(rangeControls);
    svg.dataset.rangeStart=model.low;svg.dataset.rangeEnd=model.high;
    if(graphFocus?.type==='link'){
      const edge=find('link',graphFocus.id);section.append(node('p','g-graph-focus',`已选关系：${RELATION_NAME[edge.type]||edge.type}`));
    } else if (graphFocus) {
      const display=annotationNodePresentation(ws(),graphFocus.type,find(graphFocus.type,graphFocus.id));
      const focus=node('div','g-graph-focus');focus.append(node('span','',`${display.heading} · ${display.content}`),button(graphFocus.type==='evidence'?'回放此证据':'编辑此节点',()=>openNode(graphFocus.type,graphFocus.id),'g-link'));section.append(focus);
    }
    section.append(viewport);
    if(graphFocus && graphFocus.type!=='link'){
      const direct=graph().links.filter(link=>link.to_type===graphFocus.type && link.to_id===graphFocus.id && link.type!=='transitions_to');
      if(direct.length){const parents=node('section','g-direct-parents');parents.append(node('h4','','直接上级'));for(const link of direct){const parent=find(link.from_type,link.from_id);if(!parent)continue;const display=annotationNodePresentation(ws(),link.from_type,parent),choice=button(`${display.heading} · ${display.content}`,()=>{graphReferenceID=link.id;referenceDeletion=null;render();},'g-direct-parent');choice.dataset.linkId=link.id;choice.setAttribute('aria-pressed',String(graphReferenceID===link.id));parents.append(choice);}section.append(parents);}
      if(graphReferenceID)section.append(node('p','g-reference-hint','退格解除此关联'));
    }
    if(graphFocus?.type==='link'){
      const edge=find('link',graphFocus.id),details=node('section','g-edge-state-summary');details.setAttribute('aria-label','情感转移前后状态');
      for(const side of ['from','to']){const state=edge?.[`${side}_type`]==='emotion_state'?find('emotion_state',edge[`${side}_id`]):null;if(!state)continue;const display=annotationNodePresentation(ws(),'emotion_state',state),entry=node('section','g-edge-state-panel');entry.dataset.stateId=state.id;entry.dataset.side=side;entry.append(node('strong','',display.heading),node('p','g-edge-state-label',state.label),node('small','',`${numberText(state.start_time)}–${numberText(state.end_time)}${state.intensity==null?'':` · 强度 ${state.intensity}/5`}`));if(details.childElementCount){const arrow=node('span','g-state-direction','→');arrow.setAttribute('role','img');arrow.setAttribute('aria-label','状态转移方向');details.append(arrow);}details.append(entry);}
      section.append(details);if(edge?.type==='transitions_to')section.append(emotionEdgeEditor(edge));
    }
    if(graphFocus && model.upstream.length) {
      const summaries=node('section','g-upstream-summary');summaries.append(node('h4','',`上游关联概要（${model.upstream.length}）`));
      const entries=node('div','g-upstream-summary-items');
      for(const track of model.tracks) {
        const upstream=model.upstream.filter(entry=>entry.type===track.type);if(!upstream.length)continue;
        const group=node('section','g-upstream-group');group.append(node('strong','',`${track.title} · ${upstream.length}`));
        for(const entry of upstream){const item=button('',()=>focusGraphNode(entry.type,entry.entry.id),'g-upstream-item');item.dataset.nodeType=entry.type;item.dataset.nodeId=entry.entry.id;item.append(node('strong','',entry.heading),node('span','',entry.content));group.append(item);}
        entries.append(group);
      }
      summaries.append(entries);section.append(summaries);
    }
    return section;
  }

  function graphPanel() {
    const panel = node('div', 'g-graph-panel');
    const columns = node('div', 'g-graph-columns'), categoryTabs=node('div','g-graph-category-tabs'); categoryTabs.setAttribute('role','tablist');categoryTabs.setAttribute('aria-label','节点分类');
    const data = [['证据', evidence().map(entry => ({ type: 'evidence', entry }))], ['事实', visibleGraph().facts.map(entry => ({ type: 'fact', entry }))], ['复合事件', visibleGraph().events.map(entry => ({ type: 'event', entry }))], ['情感脉络', visibleGraph().emotion_states.map(entry => ({ type: 'emotion_state', entry }))]];
    const neighbors = new Set();
    if(graphFocus?.type==='link'){
      const edge=find('link',graphFocus.id);for(const side of ['from','to'])if(edge?.[`${side}_type`]==='emotion_state')neighbors.add(JSON.stringify(['emotion_state',edge[`${side}_id`]]));
    } else if (graphFocus) for (const link of graph().links) {
      if(link.type==='transitions_to')continue;
      if (link.from_type === graphFocus.type && link.from_id === graphFocus.id) neighbors.add(JSON.stringify([link.to_type, link.to_id]));
      if (link.to_type === graphFocus.type && link.to_id === graphFocus.id) neighbors.add(JSON.stringify([link.from_type, link.from_id]));
    }
    for (const [index, [title, items]] of data.entries()) {
      const category=['evidence','fact','event','emotion_state'][index];
      const tab=button(`${['证据','事实','复合事件','情感'][index]} ${items.length}`,()=>{graphCategory=category;graphSearch='';graphListScroll=0;render();});
      tab.dataset.category=category;tab.id=`g-graph-category-${category}`;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(graphCategory===category));tab.setAttribute('aria-controls',`g-graph-nodes-${category}`);categoryTabs.append(tab);
      const column = node('section', 'g-graph-column');column.dataset.category=category;column.id=`g-graph-nodes-${category}`;column.setAttribute('role','tabpanel');column.setAttribute('aria-labelledby',tab.id); column.append(node('h4', '', `${title}（${items.length}）`));
      const scroll = node('div', 'g-graph-scroll');
      for (const { type, entry } of items) {
        const focused = graphFocus?.type === type && graphFocus?.id === entry.id;
        const item = button('', () => focusGraphNode(type,entry.id), 'g-graph-node' + (focused ? ' active' : neighbors.has(JSON.stringify([type, entry.id])) ? ' related' : ''));
        item.dataset.nodeType = type; item.dataset.nodeId = entry.id;
        const display = annotationNodePresentation(ws(),type,entry);
        item.style.setProperty('--node-color',display.color);
        if(display.tag&&type!=='evidence') item.append(node('small','g-node-type-tag',display.tag));
        item.append(node('strong','',type==='evidence'?display.id:display.cardHeading),node('span','g-node-description',display.content));
        if(type==='evidence')item.append(node('small','g-evidence-node-time',`${Math.round(entry.global_start_time)}s–${Math.round(entry.global_end_time)}s`));
        if(type==='fact'||type==='event') item.append(node('small','',`参与主体：${display.subjects}`));
        scroll.append(item);
      }
      if (!items.length) scroll.append(node('p', 'g-empty', '尚无节点')); column.append(scroll); columns.append(column);
    }
    const mapLayout=node('div','g-graph-layout'), nodeBrowser=node('aside','g-graph-browser');
    const search=input('g-graph-node-search',graphSearch);search.type='search';search.placeholder='搜索编号、主体或内容';search.setAttribute('aria-label','搜索图谱节点');
    const emptySearch=node('p','g-empty','本分类没有匹配节点');
    const filterNodes=()=>{graphSearch=search.value;const term=graphSearch.trim().toLocaleLowerCase();for(const item of columns.querySelectorAll('.g-graph-node')) item.hidden=!`${item.dataset.nodeId} ${item.textContent}`.toLocaleLowerCase().includes(term);for(const section of columns.querySelectorAll('.g-graph-column')) section.hidden=section.dataset.category!==graphCategory;emptySearch.hidden=!term || [...columns.querySelectorAll(`.g-graph-column[data-category="${graphCategory}"] .g-graph-node`)].some(item=>!item.hidden);};
    search.addEventListener('input',filterNodes);filterNodes();
    columns.append(emptySearch);nodeBrowser.append(node('h3','','节点列表'),categoryTabs,search,columns);columns.addEventListener('scroll',()=>{graphListScroll=columns.scrollTop;});
    mapLayout.append(directedGraph(data),nodeBrowser);panel.append(mapLayout);queueMicrotask(()=>{columns.scrollTop=graphListScroll;});
    return panel;
  }

  function render() {
    graphTypographyObserver?.disconnect();graphTypographyObserver=null;
    captureFields();
    const workspace = ws(); root.hidden = !workspace;
    undoButton.disabled = !workspace || !canUndo?.();
    if (!workspace) { fieldDrafts.clear(); fieldBaselines.clear(); dirtyFields.clear(); renderedContext = null; updateUnsavedNote(); return; }
    if (renderedContext && (renderedContext.workspace !== workspace.id || draftWorkspace !== workspace)) {
      stateSelection.clear();selectedEmotionEdge='';
      for (const view of Object.values(timelineViews)) for (const key of Object.keys(view)) delete view[key];
      activeStage = 'evidence'; graphFocus = null; graphPage = 0; factSeed = null;
      graphReferenceID=null;referenceDeletion=null;graphTimeline=null;graphRange='full';graphSearch='';graphListScroll=0;graphCategory='evidence';graphWindowStart=null;graphWindowSpan=60;
      for (const type of Object.keys(selected)) selected[type] = '';
      fieldDrafts.clear(); fieldBaselines.clear(); dirtyFields.clear(); renderedContext = null;
    }
    if (!workspace.graph) workspace.graph = blankGraph();
    if(draftWorkspace!==workspace){draftWorkspace=workspace;temporalConflicts.clear();for(const [key,entry] of workspace.ui_temporal_conflicts||[])if(typeof key==='string'&&entry?.message)temporalConflicts.set(key,{itemID:entry.itemID,error:new Error(entry.message)});for(const entry of workspace.ui_form_drafts || []){if(!Array.isArray(entry)||typeof entry[0]!=='string')continue;const [key,value,baseline]=entry;if(JSON.parse(key)[0]!==workspace.id)continue;fieldDrafts.set(key,value);fieldBaselines.set(key,baseline);dirtyFields.add(key);}}
    for (const id of stateSelection) if (!find('emotion_state', id)) stateSelection.delete(id);
    if (subjectWorkspace !== workspace) { subjectWorkspace = workspace; subjects = createSubjectResolver(workspace); }
    if (renderedContext?.itemID && renderedContext.itemID !== currentItemID()) {
      stateSelection.clear();selectedEmotionEdge='';
      for(const view of Object.values(timelineViews))for(const key of Object.keys(view))delete view[key];graphSearch='';graphListScroll=0;
      for (const type of ['fact', 'event', 'emotion_state', 'emotion_transition']) selected[type] = '';
      factSeed = null;
      graphFocus=null;graphReferenceID=null;referenceDeletion=null;graphTimeline=null;graphWindowStart=null;graphRange='full';
    }
    if (graphFocus && !find(graphFocus.type, graphFocus.id)) { graphFocus = null; graphPage = 0; }
    root.dataset.stage = activeStage;
    const counts = { evidence: evidence().length, facts: visibleGraph().facts.length, events: visibleGraph().events.length, emotions: visibleGraph().emotion_states.length };
    status.textContent = graph().status === 'complete' ? '四层已完成' : '四层待完成'; status.classList.toggle('complete', graph().status === 'complete');
    tabs.replaceChildren();
    for (const [id, text] of STAGES) {
      const tab = button(text, () => stage(id), 'g-tab' + (activeStage === id ? ' active' : ''));
      if(id in counts)tab.append(document.createTextNode(' '),node('span','g-tab-count',String(counts[id])));
      tab.dataset.stage = id; tab.setAttribute('aria-current', activeStage === id ? 'step' : 'false'); tabs.append(tab);
    }
    const editor = document.querySelector('.editor-grid'), footer = document.querySelector('.task-footer');
    const showTimeline = ['facts', 'events', 'emotions'].includes(activeStage);
    const preview = document.getElementById('shared-media-preview');
    const previewParent = showTimeline ? previewHost : document.querySelector('.media-column');
    if (preview && previewParent && preview.parentElement !== previewParent) previewParent.prepend(preview);
    layerView.hidden = !showTimeline;
    layerTimeline = null; timelineHost.replaceChildren();
    if (showTimeline) {
      layerTimeline = createAnnotationTimeline({ ws: materialWorkspace(workspace), stage: activeStage, selected, view: timelineViews[activeStage], onSelect: openNode, onSeek: seekFromTimeline, getPlaybackTime, onGestureStart: pausePlayback, onEdit: editTimeline, onCreate: (...args) => createTimelineDraft(activeStage, ...args), stateSelection, onToggleState: toggleStateSelection });
      timelineHost.append(layerTimeline.element);
    }
    if (editor) editor.hidden = activeStage !== 'evidence'; if (footer) footer.hidden = activeStage !== 'evidence';
    body.replaceChildren();
    if (activeStage === 'facts') body.append(factsPanel());
    else if (activeStage === 'events') body.append(eventsPanel());
    else if (activeStage === 'emotions') body.append(emotionsPanel());
    else if (activeStage === 'graph') body.append(graphPanel());
    const context = formContext();
    recordBaselines(context); restoreFields(context);
    for (const wrapper of body.querySelectorAll('.g-subject-lineage')) wrapper.refreshSubjects();
    restoreFields(context);
    const speaker = body.querySelector('#g-fact-speaker'); if (speaker) speaker.closest('.g-field').hidden = value('g-fact-kind') !== 'reported_speech';
    renderedContext = context; captureFields(); updateUnsavedNote();
    const conflict=[...temporalConflicts.values()].find(entry=>entry.itemID===currentItemID());if(conflict)report(conflict.error.message,true,true);
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
  function restoreAfterUndo() {
    captureFields();
    for (const [type, id] of Object.entries(selected)) if (id && COLLECTION[type] && !find(type, id)) selected[type] = '';
    pruneRemovedContexts(); renderedContext = null; subjectWorkspace = null; render();
  }
  function deleteSelectedReference(){
    if(activeStage==='graph' && graphReferenceID){const link=graph().links.find(link=>link.id===graphReferenceID);if(link)changedGraph(()=>removeGraphNode(ws(),'link',link.id),'已解除这一条上级关联，两端节点均保留',null);return true;}
    if(!referenceDeletion)return false;const type=activeStage==='facts'?'fact':activeStage==='events'?'event':'emotion_state',context=JSON.stringify([ws().id,activeStage,selected[type]||'',currentItemID()]);
    if(referenceDeletion.context!==context){referenceDeletion=null;return false;}const control=root.querySelector(`#${referenceDeletion.control}`);if(!control){referenceDeletion=null;return false;}
    const option=[...control.options].find(option=>option.value===referenceDeletion.id);if(!option?.selected)return true;option.selected=false;control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));autosave();if(referenceDeletion)referenceDeletion.context=JSON.stringify([ws().id,activeStage,selected[type]||'',currentItemID()]);report('已解除这一条上级关联，两端节点均保留');return true;
  }
  function deleteSelected(){if(deleteSelectedReference())return true;const focus=activeStage==='graph'?graphFocus:activeStage==='facts'?{type:'fact',id:selected.fact}:activeStage==='events'?{type:'event',id:selected.event}:activeStage==='emotions'?{type:'emotion_state',id:selected.emotion_state}:null;if(!focus?.id)return false;clearTimeout(autoTimer);if(focus.type==='evidence')deleteEvidence?.(focus.id);else {remove(focus.type,focus.id,false);graphFocus=null;}return true;}
  function assertReadyToExport(itemID) {
    captureFields();
    const temporalField=/^(g-fact-time-(mode|start-\d+|end-\d+)|g-fact-evidence|g-event-facts|g-state-(start|end|facts|events))$/;
    const pendingTime=renderedContext&&[...body.querySelectorAll('input[id],select[id]')].some(element=>temporalField.test(element.id)&&dirtyFields.has(draftKey(element,renderedContext)));
    if(temporalConflicts.size||pendingTime)autosave();
    const conflict = [...temporalConflicts.values()].find(entry => !itemID || entry.itemID === itemID);
    if (conflict) throw new Error(`请先调整时间冲突后再保存：${conflict.error.message}`);
  }
  return { render, restoreAfterUndo, openFactFromEvidence, hasUnsavedChanges, autosave,retainDrafts,deleteSelected,deleteSelectedReference, assertReadyToExport, setStage: stage, get stage() { return activeStage; } };
}
