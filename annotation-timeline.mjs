import { evidenceNodes, evidenceKey, factTimeRanges, eventTimeRanges, invalidateEvidence, invalidateFactDependents, nextAnnotationId, assertTemporalOrder } from './graph.mjs';
import { cleanSegment, MAX_SEGMENTS } from './core.mjs';
import { factColor, LAYER_COLORS } from './graph-view.mjs';

const names = { facts: '事实时间轴', events: '复合事件时间轴', emotions: '情感脉络时间轴' };
const seconds = value => `${Math.round(value * 1000) / 1000}s`;
const rangeText = range => `${seconds(range.start_time)} → ${seconds(range.end_time)}`;

export function packTimelineRows(rows, {groupBySubject=false} = {}) {
  const lanes=[];
  for(const row of [...rows].sort((a,b)=>a.time_ranges[0].start_time-b.time_ranges[0].start_time || a.id.localeCompare(b.id))){
    const footprint=['emotion_relation','emotion_transition'].includes(row.type)?[{start_time:Math.min(...row.time_ranges.map(r=>r.start_time)),end_time:Math.max(...row.time_ranges.map(r=>r.end_time))}]:row.time_ranges;
    const subject=row.subject_id || `unassigned:${row.id}`;
    let lane=groupBySubject?lanes.find(lane=>lane.subject_id===subject):lanes.find(lane=>footprint.every(r=>lane.ranges.every(other=>r.end_time<=other.start_time || r.start_time>=other.end_time)));
    if(!lane){lane={rows:[],ranges:[],...(groupBySubject?{subject_id:subject}:{})};lanes.push(lane);}lane.rows.push(row);lane.ranges.push(...footprint);
  }
  return lanes;
}

// Calculate all edits before writing anything. Each disjoint band edits only its contributors.
export function planAnnotationTimeEdit(ws, { type, id, range_index = 0, mode, delta }) {
  if(type==='event')throw new Error('复合事件时间由构成事实发生时间窗并集计算，请调整对应事实');
  if (!['move', 'start', 'end'].includes(mode) || !Number.isFinite(delta)) throw new Error('无效的时间框操作');
  if(type==='emotion_relation' || type==='emotion_transition'){
    const relation=type==='emotion_relation'?ws.graph.links.find(link=>link.id===id):ws.graph.emotion_transitions.find(link=>link.id===id);
    const stateID=relation?.[type==='emotion_relation'?(range_index?'to_id':'from_id'):(range_index?'to_state_id':'from_state_id')];
    if(!stateID)throw new Error('情感连接的状态不存在');return planAnnotationTimeEdit(ws,{type:'emotion_state',id:stateID,mode,delta});
  }
  const stage = type === 'fact' ? 'facts' : type === 'event' ? 'events' : 'emotions';
  const group = annotationTimelineData(ws, stage).groups.find(group => group.rows.some(row => row.id === id && row.type === type));
  const row = group?.rows.find(row => row.id === id && row.type === type), original = row?.time_ranges[range_index];
  if (!original) throw new Error('时间框已不存在或缺少支持证据');
  const length = original.end_time - original.start_time;
  const coefficient = time => mode === 'move' ? 1 : mode === 'start' ? (original.end_time - time) / length : (time - original.start_time) / length;
  let low = -Infinity, high = Infinity;
  const limit = (base, factor, min, max) => {
    if (Math.abs(factor) < 1e-12) { if (base < min - 1e-8 || base > max + 1e-8) throw new Error('原时间窗超出素材范围'); return; }
    const a = (min - base) / factor, b = (max - base) / factor;
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
  };
  const sources = [], states = [], factSources = [];
  if (type === 'fact') {
    const ids = new Set([id]);
    const times=factTimeRanges(ws);
    for(const factID of ids){const timing=times[factID];if(!timing || timing.timeline_id!==group.timeline_id)continue;
      const indices=timing.time_ranges.flatMap((r,index)=>r.start_time>=original.start_time-1e-8 && r.end_time<=original.end_time+1e-8?[index]:[]);
      if(!indices.length)continue;
      for(const index of indices){const r=timing.time_ranges[index];for(const time of [r.start_time,r.end_time])limit(time,coefficient(time),group.start_time,group.end_time);limit(r.end_time-r.start_time,coefficient(r.end_time)-coefficient(r.start_time),.001,Infinity);}
      factSources.push({id:factID,timing,indices});
    }
  } else {
    const stateID = type === 'emotion_transition' ? ws.graph.emotion_transitions.find(entry => entry.id === id)?.[range_index ? 'to_state_id' : 'from_state_id']
      : type === 'emotion_relation' ? ws.graph.links.find(entry => entry.id === id)?.[range_index ? 'to_id' : 'from_id'] : id;
    const state = ws.graph.emotion_states.find(entry => entry.id === stateID);
    if (!state) throw new Error('情感状态已不存在');
    states.push(state);
    for (const time of [original.start_time, original.end_time]) limit(time, coefficient(time), group.start_time, group.end_time);
  }
  limit(length, coefficient(original.end_time) - coefficient(original.start_time), .001, Infinity);
  if (low > high + 1e-8) throw new Error('支持证据没有可共同调整的时间范围');
  const amount = Math.max(low, Math.min(high, Math.round(delta * 1000) / 1000));
  const transform = time => time + coefficient(time) * amount;
  const rounded = value => Math.round(value * 1e6) / 1e6;
  return { timeline_id: group.timeline_id, range: { start_time: rounded(transform(original.start_time)), end_time: rounded(transform(original.end_time)) },
    evidence_updates: sources.map(node => ({ item_id: node.item_id, segment_id: node.segment_id,
      start_time: rounded(transform(node.global_start_time) - node.time_offset_s), end_time: rounded(transform(node.global_end_time) - node.time_offset_s) })),
    fact_updates: factSources.map(({id,timing,indices})=>({id,timeline_id:timing.timeline_id,time_ranges:timing.time_ranges.map((r,index)=>indices.includes(index)?{start_time:rounded(transform(r.start_time)),end_time:rounded(transform(r.end_time))}:{...r})})),
    event_updates:[],
    state_updates: states.map(state => ({ id: state.id, start_time: rounded(transform(state.start_time)), end_time: rounded(transform(state.end_time)) })) };
}

export function applyAnnotationTimePlan(ws, plan) {
  if(plan.event_updates?.length)throw new Error('复合事件时间只能由构成事实派生');
  const records = plan.evidence_updates.map(update => {
    const item = ws.manifest.items.find(item => item.id === update.item_id), record = ws.records[update.item_id];
    const index = record?.segments.findIndex(segment => segment.id === update.segment_id);
    if (!item || index === undefined || index < 0) throw new Error('支持证据已不存在');
    const old = record.segments[index], next = cleanSegment({ ...old, start_time: update.start_time, end_time: update.end_time }, item);
    return { record, index, old, next, ref: evidenceKey(item.id, old.id) };
  });
  const timing=factTimeRanges(ws);
  const facts=(plan.fact_updates || []).map(update=>{const fact=ws.graph.facts.find(fact=>fact.id===update.id);if(!fact || !update.timeline_id || !update.time_ranges.length || update.time_ranges.some(r=>!Number.isFinite(r.start_time)||!Number.isFinite(r.end_time)||r.end_time<=r.start_time))throw new Error('Invalid fact time update');return {fact,update};});

  const states = plan.state_updates.map(update => {
    const state = ws.graph.emotion_states.find(state => state.id === update.id);
    if (!state || !Number.isFinite(update.start_time) || !Number.isFinite(update.end_time) || update.end_time <= update.start_time) throw new Error('无效的情感状态时间');
    return { state, update };
  });
  const changed = records.filter(entry => entry.old.start_time !== entry.next.start_time || entry.old.end_time !== entry.next.end_time);
  const changedStates = states.filter(({ state, update }) => state.start_time !== update.start_time || state.end_time !== update.end_time);
  const changedFacts=facts.filter(({fact,update})=>timing[fact.id]?.timeline_id!==update.timeline_id || JSON.stringify(timing[fact.id]?.time_ranges)!==JSON.stringify(update.time_ranges));

  const factUpdates = new Map(facts.map(({fact, update}) => [fact.id, update]));
  const stateUpdates = new Map(states.map(({state, update}) => [state.id, update]));
  const candidate = { ...ws, records: { ...ws.records }, graph: { ...ws.graph,
    facts: ws.graph.facts.map(fact => ({ ...fact, ...factUpdates.get(fact.id) })),
    emotion_states: ws.graph.emotion_states.map(state => ({ ...state, ...stateUpdates.get(state.id) })) } };
  for (const [index, update] of plan.evidence_updates.entries()) {
    const current = candidate.records[update.item_id];
    candidate.records[update.item_id] = { ...current, segments: current.segments.map(segment => segment.id === update.segment_id
      ? records[index].next : segment) };
  }
  assertTemporalOrder(candidate);

  for(const {fact,update} of changedFacts){Object.assign(fact,update,{review_status:'needs_review'});invalidateFactDependents(ws,fact.id);}
  if(changedFacts.length)ws.graph.status='draft';

  for (const entry of changed) { entry.record.segments[entry.index] = entry.next; entry.record.status = 'draft'; }
  if (changed.length) invalidateEvidence(ws, changed.map(entry => entry.ref));
  for (const { state, update } of changedStates) {
    Object.assign(state, update, { review_status: 'needs_review' });
    for (const transition of ws.graph.emotion_transitions) if ([transition.from_state_id, transition.to_state_id].includes(state.id)) transition.review_status = 'needs_review';
  }
  if (changedStates.length) ws.graph.status = 'draft';
  return changed.length + changedStates.length + changedFacts.length;
}

export function createAnnotationDraft(ws, stage, timeline, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < .001) throw new Error('请选择至少 0.001 秒的有效区间');
  const id = nextAnnotationId(ws, stage === 'emotions' ? 'emotion_state' : stage === 'facts' ? 'fact' : 'event');
  if (stage === 'emotions') {
    ws.graph.emotion_states.push({ id, label: '', subject_id: '', timeline_id: timeline, start_time: start, end_time: end, intensity: null, review_status: 'draft', item_id: ws.manifest.items[ws.index || 0].id });
    ws.graph.status = 'draft'; return { type: 'emotion_state', id };
  }
  const current = ws.manifest.items[ws.index || 0];
  const item = [current, ...ws.manifest.items.filter(item => item !== current)].find(item => {
    if (!item || (item.timeline_id || item.source_id || item.id) !== timeline) return false;
    const offset = item.time_offset_s ?? item.clip_start_s ?? 0;
    return start >= offset && (!Number.isFinite(item.duration_s) || end <= offset + item.duration_s);
  });
  if (!item) throw new Error('该区间没有完整覆盖的素材，请调整区间或切换素材');
  const factID=stage==='facts'?id:nextAnnotationId(ws,'fact');
  ws.graph.facts.push({id:factID,text:'',subject_ids:[],kind:'observation',speaker_id:'',review_status:'draft',item_id:item.id,timeline_id:timeline,time_ranges:[{start_time:start,end_time:end}]});
  if (stage === 'events') {
    ws.graph.events.push({ id, title: '', subject_ids: [], timeline_id: timeline, review_status: 'draft', item_id: item.id });
    ws.graph.links.push({ id: nextAnnotationId(ws, 'link'), from_type: 'fact', from_id: factID, to_type: 'event', to_id: id, type: 'constitutes' });
  }
  ws.graph.status = 'draft'; return { type: stage === 'facts' ? 'fact' : 'event', id };
}

// Fact windows are independent annotations; initial windows can derive from support.
export function annotationTimelineData(ws, stage) {
  const graph = ws.graph, groups = new Map(), unresolved = [];
  const entities = new Map(graph.entities.map(entity => [entity.id, entity.name]));
  const groupFor = id => {
    if (!groups.has(id)) groups.set(id, { timeline_id: id, start_time: Infinity, end_time: -Infinity, rows: [], connections:[] });
    return groups.get(id);
  };
  const include = (id, start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const group = groupFor(id); group.start_time = Math.min(group.start_time, start); group.end_time = Math.max(group.end_time, end);
  };
  for (const item of ws.manifest.items) {
    const timeline = item.timeline_id || item.source_id || item.id;
    const offset = item.time_offset_s ?? item.clip_start_s ?? 0;
    include(timeline, offset, offset + item.duration_s);
  }
  for (const evidence of evidenceNodes(ws)) include(evidence.timeline_id, evidence.global_start_time, evidence.global_end_time);
  const add = (entry, type, title, time) => {
    const row = { id: entry.id, type, title, kind:entry.kind, color:type==='fact'?factColor(entry.kind):null, review_status: entry.review_status, subject_id: entry.subject_id || '',
      subjects: (entry.subject_ids || [entry.subject_id]).filter(Boolean).map(id => entities.get(id) || id).join('、') };
    row.title ||= type === 'fact' ? '待填写事实' : type === 'event' ? '待填写复合事件' : '待填写情感状态';
    if (!time || time.status === 'unresolved') { unresolved.push({ ...row, reason: time?.reason || '时间尚未确定' }); return; }
    const group = groupFor(time.timeline_id);
    group.rows.push({ ...row, time_ranges: time.time_ranges });
    for (const range of time.time_ranges) include(time.timeline_id, range.start_time, range.end_time);
  };
  if (stage === 'facts' || stage === 'events') {
    const times = stage === 'facts' ? factTimeRanges(ws) : eventTimeRanges(ws);
    for (const entry of graph[stage]) add(entry, stage === 'facts' ? 'fact' : 'event', entry.text || entry.title, times[entry.id]);
  } else if (stage === 'emotions') {
    const states = new Map(graph.emotion_states.map(state => [state.id, state]));
    for (const state of graph.emotion_states) add(state, 'emotion_state', `${state.label}${state.intensity == null ? '' : ` · ${state.intensity}/5`}`, { timeline_id: state.timeline_id, time_ranges: [{ start_time: state.start_time, end_time: state.end_time }] });
    const addConnection=(entry,type,fromID,toID)=>{
      const from=states.get(fromID),to=states.get(toID),valid=from && to && from.subject_id && from.subject_id===to.subject_id && from.timeline_id===to.timeline_id;
      if(!valid){unresolved.push({id:entry.id,type,title:entry.note||entry.id,reason:'连接的状态缺失或主体、时间不一致'});return;}
      groupFor(from.timeline_id).connections.push({id:entry.id,type,subject_id:from.subject_id,from_state_id:fromID,to_state_id:toID});
    };
    for(const entry of graph.emotion_transitions)addConnection(entry,'emotion_transition',entry.from_state_id,entry.to_state_id);
    for(const entry of graph.links.filter(link=>link.type==='transitions_to' && link.from_type==='emotion_state' && link.to_type==='emotion_state'))addConnection(entry,'emotion_relation',entry.from_id,entry.to_id);

  }
  for (const group of groups.values()) group.rows.sort((a, b) => a.time_ranges[0].start_time - b.time_ranges[0].start_time || a.id.localeCompare(b.id));
  const result = { groups: [...groups.values()].filter(group => Number.isFinite(group.start_time)), unresolved };
  return result;
}

const element = (tag, className, text) => {
  const item = document.createElement(tag); if (className) item.className = className;
  if (text !== undefined) item.textContent = text; return item;
};
const action = (label, fn) => { const item = element('button', 'g-button small', label); item.type = 'button'; item.addEventListener('click', fn); return item; };

function emotionConnectionsSVG(rows, connections, low, span, laneIndex){
  const ns='http://www.w3.org/2000/svg',make=(tag,attrs={},text='')=>{const node=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));if(text)node.textContent=text;return node;};
  const svg=make('svg',{class:'g-time-state-connections',viewBox:'0 0 1000 66',preserveAspectRatio:'none',role:'img','aria-label':'情感状态之间的连接'}),markerID=`emotion-lane-arrow-${laneIndex}`;
  const defs=make('defs'),marker=make('marker',{id:markerID,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'});marker.append(make('path',{d:'M0 0L10 5L0 10',fill:'none',stroke:LAYER_COLORS.emotion_state,'stroke-width':1.4}));defs.append(marker);svg.append(defs);
  const states=new Map(rows.map(row=>[row.id,row])),pairs=new Map();
  for(const connection of connections || []){if(!states.has(connection.from_state_id)||!states.has(connection.to_state_id))continue;const key=JSON.stringify([connection.from_state_id,connection.to_state_id]),existing=pairs.get(key);pairs.set(key,{...(existing||connection),...(connection.type==='emotion_relation'?connection:{}),ids:[...(existing?.ids||[]),connection.id]});}
  for(const connection of pairs.values()){
    const from=states.get(connection.from_state_id),to=states.get(connection.to_state_id),fromEnd=from.time_ranges.at(-1).end_time,toStart=to.time_ranges[0].start_time,x1=((toStart<fromEnd?from.time_ranges[0].start_time:fromEnd)-low)/span*1000,x2=(toStart-low)/span*1000,middle=(x1+x2)/2;
    const touch=Math.abs(x2-x1)<.1,arcStart=x1-(touch?6:0),arcEnd=x2+(touch?6:0);
    const d=x2-x1>12?`M${x1} 30C${middle} 30,${middle} 30,${x2} 30`:`M${arcStart} 8C${arcStart} 0,${arcEnd} 0,${arcEnd} 8`;
    const path=make('path',{'data-state-connection':connection.id,'data-connection-ids':JSON.stringify(connection.ids),'data-from-state':from.id,'data-to-state':to.id,d,fill:'none',stroke:LAYER_COLORS.emotion_state,'stroke-width':1.5,'vector-effect':'non-scaling-stroke','marker-end':`url(#${markerID})`});path.append(make('title',{},`${from.subjects}：${from.title} → ${to.title}`));svg.append(path);
  }
  return svg;
}

export function createAnnotationTimeline({ ws, stage, selected, view, onSelect, onSeek, getPlaybackTime, onEdit, onCreate, onGestureStart, stateSelection, onToggleState }) {
  const data = annotationTimelineData(ws, stage), section = element('section', 'g-layer-timeline');
  section.dataset.timelineStage = stage; section.setAttribute('aria-label', names[stage]);
  const header = element('div', 'g-time-header'); header.append(element('h3', '', names[stage]));
  const controls = element('div', 'g-time-controls');
  const current = ws.manifest.items[ws.index || 0];
  const preferred = current && (current.timeline_id || current.source_id || current.id);
  view.timeline = data.groups.some(g => g.timeline_id === preferred) ? preferred : data.groups[0]?.timeline_id || '';
  header.append(controls); section.append(header);
  const hint = stage === 'emotions' ? '勾选多个状态后连接；Ctrl／Cmd＋点击时间框也可多选。拖动框身或边缘调整观测时间，Esc 取消，撤回按钮可恢复上一步。' : stage==='events' ? '事件发生时间由构成事实的发生时间窗并集计算。点击选择或回看；调整时间请编辑构成事实。' : '拖动框身或左右边缘调整事实发生时间，不改动证据呈现时间；与证据不相交时请补充时间说明。划选新建，Esc 取消，撤回按钮可恢复上一步。';
  header.title = hint;
  const filter = element('input', 'g-time-search'); filter.type = 'search'; filter.placeholder = '搜索描述或主体'; filter.setAttribute('aria-label', '搜索时间轴条目'); filter.value = view.search || '';
  section.append(filter);
  const inputs = element('div', 'g-time-inputs');
  const startInput = element('input'), endInput = element('input');
  for (const [input, label] of [[startInput, '起点 / 秒'], [endInput, '终点 / 秒']]) {
    input.type = 'number'; input.step = '.001'; input.setAttribute('aria-label', label); input.placeholder = label;
    const field = element('label', '', label); field.append(input); inputs.append(field);
  }
  inputs.append(action('新建时间窗', () => onCreate?.(view.timeline, Number(startInput.value), Number(endInput.value)))); section.append(inputs);
  const viewport = element('div', 'g-time-scroll'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '标注时间轴，可横向滚动');
  const summary = element('p', 'g-time-summary'); summary.setAttribute('role', 'status');
  const paging = element('div', 'g-time-paging');
  section.append(viewport, summary, paging);
  let activeGroup, playhead, activeScale;
  const updatePlayhead = () => {
    if (!activeGroup || !playhead) return;
    const playback = getPlaybackTime?.(), { start_time: low, end_time: high } = activeGroup;
    const visible = playback?.timeline_id === activeGroup.timeline_id && playback.time >= low && playback.time <= high;
    playhead.hidden = !visible;
    if (visible) {
      playhead.style.left = `${(playback.time - low) / (high - low) * 100}%`;
      activeScale?.setAttribute('aria-valuenow', playback.time);
    }
  };
  const draw = () => {
    viewport.replaceChildren(); paging.replaceChildren();
    activeGroup = data.groups.find(group => group.timeline_id === view.timeline); playhead = null; activeScale = null;
    if (!activeGroup) { viewport.append(element('p', 'g-empty', '尚无可显示的时间范围。关联证据或填写情感状态起止时间后自动显示。')); summary.textContent = ''; return; }
    const group = activeGroup, span = group.end_time - group.start_time;
    const term = (view.search || '').trim().toLocaleLowerCase();
    const rows = group.rows.filter(row => `${row.title} ${row.subjects}`.toLocaleLowerCase().includes(term));
    const pageCount = Math.max(1, Math.ceil(rows.length / 80)); view.page = Math.min(Math.max(0, view.page || 0), pageCount - 1);
    const displayed = rows.slice(view.page * 80, (view.page + 1) * 80);
    const canvas = element('div', 'g-time-canvas'); canvas.style.width = `${(view.zoom || 1) * 100}%`;
    let gesture = null;
    const swallowClick = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const cancelGesture = () => {
      if (!gesture) return;
      const previous = gesture; gesture = null;
      if (previous.target.hasPointerCapture?.(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
      document.removeEventListener('keydown', escapeGesture, true);
      window.removeEventListener('blur', cancelGesture);
      if (previous.playback) onSeek?.(previous.playback.timeline_id, previous.playback.time);
      draw();
    };
    const escapeGesture = event => { if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')) { event.preventDefault(); event.stopImmediatePropagation(); cancelGesture(); } };
    const begin = (event, target, config) => {
      if (event.button !== 0 || gesture) return;
      event.preventDefault();
      const box = (config.geometry || target).getBoundingClientRect();
      gesture = { ...config, target, pointer: event.pointerId, x: event.clientX, box, moved: false, playback: getPlaybackTime?.() };
      onGestureStart?.();
      target.setPointerCapture(event.pointerId); document.addEventListener('keydown', escapeGesture, true); window.addEventListener('blur', cancelGesture);
    };
    const update = event => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      const edit = gesture;
      if (!edit.moved && Math.abs(event.clientX - edit.x) < 3) return;
      edit.moved = true;
      if (edit.kind === 'draw') {
        const time = x => group.start_time + Math.max(0, Math.min(1, (x - edit.box.left) / edit.box.width)) * span;
        edit.range = { start_time: Math.round(Math.min(time(edit.x), time(event.clientX)) * 1000) / 1000, end_time: Math.round(Math.max(time(edit.x), time(event.clientX)) * 1000) / 1000 };
      } else {
        edit.request.delta = (event.clientX - edit.x) / edit.box.width * span;
        try { edit.plan = planAnnotationTimeEdit(ws, edit.request); edit.range = edit.plan.range; }
        catch (error) { summary.textContent = error.message; return; }
      }
      const range = edit.range; edit.preview.style.left = `${(range.start_time - group.start_time) / span * 100}%`; edit.preview.style.width = `${(range.end_time - range.start_time) / span * 100}%`; edit.preview.hidden = false;
      summary.textContent = `预览 ${rangeText(range)} · 松开保存，Esc 取消`;
      if (getPlaybackTime?.()?.timeline_id === group.timeline_id) onSeek?.(group.timeline_id, edit.request?.mode === 'end' ? range.end_time : range.start_time);
    };
    canvas.addEventListener('pointermove', update);
    canvas.addEventListener('pointerup', event => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      update(event); const edit = gesture; gesture = null;
      document.removeEventListener('keydown', escapeGesture, true);
      window.removeEventListener('blur', cancelGesture);
      if (edit.target.hasPointerCapture?.(edit.pointer)) edit.target.releasePointerCapture(edit.pointer);
      if (!edit.moved) return;
      event.preventDefault(); document.addEventListener('click', swallowClick, true);
      setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
      if (edit.range?.end_time > edit.range?.start_time) {
        if (edit.kind === 'draw') { startInput.value = edit.range.start_time; endInput.value = edit.range.end_time; onCreate?.(group.timeline_id, edit.range.start_time, edit.range.end_time); }
        else if (edit.plan) onEdit?.(edit.request, edit.plan);
      }
      if (section.isConnected) draw();
    });
    canvas.addEventListener('pointercancel', cancelGesture); canvas.addEventListener('lostpointercapture', cancelGesture);
    const ruler = element('div', 'g-time-row g-time-ruler'); ruler.append(element('span', 'g-time-label', '时间 / 秒'));
    const scale = element('div', 'g-time-scale'); scale.setAttribute('aria-label', '点击定位播放');
    activeScale = scale;
    const seek = event => {
      const box = event.currentTarget.getBoundingClientRect();
      const time = group.start_time + Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * span;
      if (onSeek?.(group.timeline_id, time) === false) summary.textContent = '当前素材不覆盖该位置；可通过条目中的支持证据回看对应素材。';
    };
    scale.addEventListener('click', seek); scale.tabIndex = 0; scale.setAttribute('role', 'slider');
    scale.setAttribute('aria-label', '播放定位，左右方向键步进一秒，Home 和 End 跳转首尾');
    scale.setAttribute('aria-valuemin', group.start_time); scale.setAttribute('aria-valuemax', group.end_time);
    scale.setAttribute('aria-valuenow', group.start_time);
    scale.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const playback = getPlaybackTime?.();
      const currentTime = playback?.timeline_id === group.timeline_id ? playback.time : group.start_time;
      const time = event.key === 'Home' ? group.start_time : event.key === 'End' ? group.end_time : Math.min(group.end_time, Math.max(group.start_time, currentTime + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (onSeek?.(group.timeline_id, time) === false) summary.textContent = '当前素材不覆盖该位置；请从支持证据切换素材。';
      scale.setAttribute('aria-valuenow', time);
    });
    for (let n = 0; n <= 5; n++) { const tick = element('span', 'g-time-tick', seconds(group.start_time + span * n / 5)); tick.style.left = `${n * 20}%`; scale.append(tick); }
    ruler.append(scale); canvas.append(ruler);
    const drawRow = element('div', 'g-time-row g-time-create-row'); drawRow.append(element('span', 'g-time-label', '划选新建时间窗'));
    const drawTrack = element('div', 'g-time-draw'); drawTrack.setAttribute('aria-label', '拖动划选新建标注时间窗');
    const drawPreview = element('span', 'g-time-draw-preview'); drawPreview.hidden = true;
    drawTrack.append(element('span', 'g-time-draw-hint', '拖动新建 · 单击回放'), drawPreview);
    drawTrack.addEventListener('pointerdown', event => begin(event, drawTrack, { kind: 'draw', preview: drawPreview }));
    drawTrack.addEventListener('click', seek); drawRow.append(drawTrack); canvas.append(drawRow);
    const tracks = element('div', 'g-time-tracks');
    const line = element('div', 'g-time-playhead-lane'); playhead = element('i', 'g-time-playhead'); playhead.hidden = true; line.append(playhead); tracks.append(line);
    const packed=packTimelineRows(displayed,{groupBySubject:stage==='emotions'});
    for (const [laneIndex,lane] of packed.entries()) {
      const laneRow=element('div','g-time-row g-time-packed-lane'),laneTrack=element('div','g-time-lane-track');laneRow.dataset.lane=laneIndex;
      const laneLabel=element('span','g-time-label');if(stage==='emotions'){laneRow.dataset.subjectId=lane.rows[0].subject_id;laneLabel.classList.add('g-time-subject-label');laneLabel.append(element('strong','',lane.rows[0].subjects || '主体待补充'),element('small','',`${lane.rows[0].subject_id || ''} · ${lane.rows.length} 个状态`));}else laneLabel.textContent=`轨道 ${laneIndex+1} · ${lane.rows.length} 条`;laneRow.append(laneLabel,laneTrack);tracks.append(laneRow);
      if(stage==='emotions')laneTrack.append(emotionConnectionsSVG(lane.rows,group.connections,group.start_time,span,laneIndex));
    for (const row of lane.rows) {
      const trackRow = element('div', 'g-time-row g-time-packed-item'); trackRow.dataset.nodeId = row.id; trackRow.dataset.nodeType = row.type;
      if(row.type==='fact'){trackRow.dataset.factKind=row.kind||'observation';trackRow.style.setProperty('--g-accent',row.color);trackRow.style.setProperty('--g-soft',`${row.color}18`);}
      if (row.subject_id) trackRow.dataset.subjectId = row.subject_id;
      const active = selected[row.type] === row.id;
      const heading = `${row.id}_${row.subjects || '主体待补充'}`;
      const label = action(heading, () => onSelect(row.type, row.id)); label.className = 'g-time-label g-time-node-label'; label.title = `${heading} · ${row.title}`;
      label.setAttribute('aria-pressed', String(active));
      const detail = element('small', '', row.title); label.append(detail);
      const track = element('div', 'g-time-track');
      row.time_ranges.forEach((range, index) => {
        const bar = action(row.title, event => {
          if (row.type === 'emotion_state' && onToggleState && (event.ctrlKey || event.metaKey)) { onToggleState(row.id); return; }
          onSelect(row.type, row.id); onSeek?.(group.timeline_id, range.start_time);
        });
        bar.className = 'g-time-band' + (active ? ' active' : '');
        bar.textContent = ''; bar.append(element('strong','',heading),element('small','',row.title));
        bar.dataset.start = range.start_time; bar.dataset.end = range.end_time;
        bar.style.left = `${(range.start_time - group.start_time) / span * 100}%`; bar.style.width = `${(range.end_time - range.start_time) / span * 100}%`;
        bar.title = `${row.subjects} · ${row.title} · ${rangeText(range)}`;
        bar.setAttribute('aria-label', `${row.title}，${rangeText(range)}`);
        bar.setAttribute('aria-pressed', String(active)); track.append(bar);
        if(row.type==='event'){bar.dataset.timeDerived='true';bar.classList.add('g-time-derived');return;}
        const startHandle = element('span', 'g-time-handle start'), endHandle = element('span', 'g-time-handle end');
        startHandle.dataset.edge = 'start'; endHandle.dataset.edge = 'end'; startHandle.setAttribute('aria-hidden', 'true'); endHandle.setAttribute('aria-hidden', 'true'); bar.append(startHandle, endHandle);
        bar.addEventListener('pointerdown', event => {
          if (event.ctrlKey || event.metaKey) return;
          begin(event, bar, { kind: 'edit', geometry: track, preview: bar,
            request: { type: row.type, id: row.id, range_index: index, mode: event.target.closest('[data-edge]')?.dataset.edge || 'move', delta: 0 } });
        });
      });
      if (row.type === 'emotion_state' && onToggleState) {
        const choice = element('div', 'g-time-label g-time-choice-label'), check = element('input'); check.type = 'checkbox'; check.dataset.stateId = row.id; check.checked = !!stateSelection?.has(row.id);
        check.setAttribute('aria-label', `选择状态用于连边：${row.title} · ${row.subjects}`); check.addEventListener('change', () => onToggleState(row.id));
        label.className = 'g-time-node-label'; choice.append(label);check.className='g-time-state-pick';check.style.left=`${(row.time_ranges[0].start_time-group.start_time)/span*100}%`;track.append(check); trackRow.append(choice, track);
      } else trackRow.append(label, track);
      laneTrack.append(trackRow);
    }
    }
    if (!displayed.length) tracks.append(element('p', 'g-empty', term ? '没有匹配的条目。' : '暂无标注'));
    canvas.append(tracks); viewport.append(canvas); viewport.scrollLeft = view.scrollLeft || 0;
    summary.textContent = `${rangeText(group)} · ${rows.length} 条${data.unresolved.length ? `；另有 ${data.unresolved.length} 条时间待补充` : ''}`;
    if (pageCount > 1) paging.append(action('上一页', () => { view.page--; draw(); }), element('span', '', `${view.page + 1} / ${pageCount}`), action('下一页', () => { view.page = Math.min(pageCount - 1, view.page + 1); draw(); }));
    updatePlayhead();
  };
  controls.append(action('缩小', () => { view.zoom = Math.max(1, (view.zoom || 1) / 2); draw(); }), action('放大', () => { view.zoom = Math.min(16, (view.zoom || 1) * 2); draw(); }), action('全览', () => { view.zoom = 1; view.scrollLeft = 0; draw(); }));

  filter.addEventListener('input', () => { view.search = filter.value; view.page = 0; draw(); });
  viewport.addEventListener('scroll', () => { view.scrollLeft = viewport.scrollLeft; });
  if (data.unresolved.length) {
    const missing = element('details', 'g-time-unresolved'); missing.append(element('summary', '', `${data.unresolved.length} 条时间待补充`));
    for (const row of data.unresolved) { const open = action(`${row.title} · ${row.reason}`, () => onSelect(row.type, row.id)); missing.append(open); }
    section.append(missing);
  }
  draw();
  return { element: section, updatePlayhead };
}
