import { evidenceNodes, factTimeRanges, eventTimeRanges } from './graph.mjs';
import { LABELS } from './core.mjs';
// View-only graph projection. Never truncate or mutate the authoritative graph.
const keyOf = (type, id) => JSON.stringify([type, id]);
export const FACT_COLORS = Object.freeze({observation:'#708b60',reported_speech:'#597fa6'});
export const LAYER_COLORS = Object.freeze({evidence:'#6285a0',fact:FACT_COLORS.observation,event:'#b48a48',emotion_state:'#97718d'});
export const factColor = kind => FACT_COLORS[kind] || FACT_COLORS.observation;

export function annotationNodePresentation(ws, type, entry) {
  const segment = type === 'evidence' ? ws.records[entry.item_id]?.segments.find(s => s.id === entry.segment_id) : null;
  const subjectIDs = type === 'emotion_state' ? [entry.subject_id] : segment?.annotations?.subject_ids || entry.subject_ids || [];
  const subjects = subjectIDs.map(id => ws.graph.entities.find(e => e.id === id)?.name || id).filter(Boolean).join('、') || segment?.annotations?.subject_id || '主体待补充';
  const id = entry.segment_id || entry.id;
  const category = type === 'evidence' ? LABELS.find(label => label.id === entry.modality) : null;
  const content = type === 'evidence' ? segment?.annotations?.observation || segment?.annotations?.local_fact || '证据内容待补充' : entry.text || entry.title || entry.label || entry.note || '';
  return { id, subjects, content, heading: `${id}_${subjects}`, tag: category?.name || (type === 'fact' ? entry.kind === 'reported_speech' ? '转述事实' : '观察事实' : ''), color: category?.color || (type==='fact'?factColor(entry.kind):LAYER_COLORS[type]) || LAYER_COLORS.evidence, cardHeading: type === 'evidence' ? `${id}_${entry.global_start_time}s–${entry.global_end_time}s` : type === 'emotion_state' ? subjects : id };
}

// The layout is independent of focus: selecting a node never moves any time band.
export function fourLayerTimeline(ws, { timeline, focus = null, range = 'full', windowStart = null, windowSpan = 60 } = {}) {
  const evidence = evidenceNodes(ws), facts = factTimeRanges(ws), events = eventTimeRanges(ws);
  const layers = [['evidence','证据',evidence],['fact','事实',ws.graph.facts],['event','复合事件',ws.graph.events],['emotion_state','情感脉络',ws.graph.emotion_states]];
  const all = layers.flatMap(([type,,entries]) => entries.map(entry => {
    const timing = type === 'evidence' ? {timeline_id:entry.timeline_id,time_ranges:[{start_time:entry.global_start_time,end_time:entry.global_end_time}]} : type === 'fact' ? facts[entry.id] : type === 'event' ? events[entry.id] : {timeline_id:entry.timeline_id,time_ranges:[entry]};
    return {type,entry,...annotationNodePresentation(ws,type,entry),timeline_id:timing?.timeline_id,ranges:(timing?.time_ranges || []).filter(r => Number.isFinite(r.start_time) && r.end_time > r.start_time)};
  }));
  const timelines = [...new Set([...ws.manifest.items.map(i => i.timeline_id || i.source_id || i.id),...all.map(n => n.timeline_id)].filter(Boolean))];
  timeline = timelines.includes(timeline) ? timeline : timelines[0];
  const focusedNode = focus && all.find(n => n.type === focus.type && n.entry.id === focus.id && n.ranges.length);
  if (focusedNode) timeline = focusedNode.timeline_id;
  const nodes = all.filter(n => n.timeline_id === timeline && n.ranges.length);
  const extents = ws.manifest.items.filter(i => (i.timeline_id || i.source_id || i.id) === timeline).flatMap(i => { const start = Number(i.time_offset_s ?? i.clip_start_s ?? 0); return [start,start + Number(i.duration_s || 0)]; });
  const starts=nodes.flatMap(n=>n.ranges.map(r=>r.start_time)), ends=nodes.flatMap(n=>n.ranges.map(r=>r.end_time));
  let low = Math.min(0,...extents,...starts), high = Math.max(low+1,...extents,...ends);
  const fullLow=low,fullHigh=high;
  if(range==='local'){
    const span=Math.min(fullHigh-fullLow,Math.max(.1,Number.isFinite(windowSpan)?windowSpan:60));
    low=Math.max(fullLow,Math.min(fullHigh-span,Number.isFinite(windowStart)?windowStart:fullLow));high=low+span;
  }else if (range !== 'full' && nodes.length) {
    const first=Math.min(...starts),last=Math.max(...ends),padding=Math.max(.1,(last-first)*0.04);
    low=Math.max(low,first-padding);high=Math.min(high,last+padding);
  }
  const x = time => 154 + (time-low)/(high-low)*1236;
  let top = 48;
  const tracks = layers.map(([type,title]) => {
    const entries = nodes.filter(n=>n.type===type).sort((a,b)=>a.ranges[0].start_time-b.ranges[0].start_time || a.id.localeCompare(b.id));
    const lanes=[],subjectLanes=new Map();
    for (const n of entries) {
      const start=x(n.ranges[0].start_time),end=Math.max(start+8,...n.ranges.map(r=>x(r.end_time)));
      let lane;if(type==='emotion_state'){const subject=n.entry.subject_id||n.entry.id;if(!subjectLanes.has(subject))subjectLanes.set(subject,subjectLanes.size);lane=subjectLanes.get(subject);}else{lane=lanes.findIndex(last=>last+6<start);if(lane<0)lane=lanes.length;}lanes[lane]=Math.max(lanes[lane]||0,end);
      const offset=[0,-13,13,-26,26][lane%5];
      n.x=start; n.y=top+70+offset; n.labelX=Math.max(154,Math.min(n.x,1185));
    }
    const height = 112; const track={type,title,top,height,count:entries.length}; top+=height+18; return track;
  });
  const related = new Set(), relatedEdges = new Set(), upstreamKeys = new Set(), links = graphViewLinks(ws.graph);
  if(focus?.type==='link'){
    const link=links.find(link=>link.id===focus.id);
    if(link){relatedEdges.add(link.id);for(const side of ['from','to'])if(link[`${side}_type`]==='emotion_state')related.add(keyOf('emotion_state',link[`${side}_id`]));}
  } else if (focus) for(const forward of [true,false]) {
    const queue=[keyOf(focus.type,focus.id)], visited=new Set(queue);
    for(let i=0;i<queue.length;i++) { const key=queue[i]; related.add(key); if(!forward && key!==keyOf(focus.type,focus.id)) upstreamKeys.add(key); for(const link of links) {
      if(['transitions_to','before_state','after_state'].includes(link.type))continue;
      const from=keyOf(link.from_type,link.from_id), to=keyOf(link.to_type,link.to_id);
      if((forward?from:to)!==key) continue;
      relatedEdges.add(link.id); const next=forward?to:from; if(!visited.has(next)){visited.add(next);queue.push(next);}
    }}
  }
  for(const n of nodes) { n.focused=focus?.type===n.type && focus?.id===n.entry.id; n.related=!focus || related.has(keyOf(n.type,n.entry.id)); }
  return {nodes,tracks,links,timeline,timelines,range,low,high,fullLow,fullHigh,height:top+8,x,relatedEdges,focus,upstream:all.filter(n=>upstreamKeys.has(keyOf(n.type,n.entry.id))),unresolved:all.filter(n=>!n.ranges.length).length};
}

export function serializeTimelineSVG(model) {
  const {nodes,tracks,x,low,high,height,focus,relatedEdges}=model, out=[];
  const text=(px,y,value,attrs='')=>`<text x="${px}" y="${y}" ${attrs}>${escapeXML(value)}</text>`;
  const short=value=>[...String(value)].slice(0,18).join('')+([...String(value)].length>18?'…':'');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" id="g-directed-svg" width="1450" height="${height}" viewBox="0 0 1450 ${height}" role="group" aria-label="四层时间轴关联图" font-family="Microsoft YaHei, sans-serif" font-size="12" fill="#344c40"><rect width="1450" height="${height}" fill="#fcfcf9"/><defs><marker id="timeline-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#537663" stroke-width="1.4"/></marker></defs>`);
  out.push(text(24,30,'时间 / 秒','fill="#829086" font-size="11"'));
  for(let i=0;i<=8;i++){const time=low+(high-low)*i/8,px=x(time);out.push(`<path d="M${px} 48V${height-25}" stroke="#e9ede7" stroke-dasharray="2 5"/>`,text(px,30,`${Math.round(time*10)/10}s`,'text-anchor="middle" fill="#829086" font-size="11"'));}
  for(const track of tracks) out.push(`<g data-timeline-layer="${track.type}">`,text(24,track.top+70,track.title,'font-size="15" font-weight="600"'),text(24,track.top+90,`${track.count} 个节点`,'fill="#929b93" font-size="11"'),`<path d="M154 ${track.top+76}H1390" stroke="#dfe6dc"/></g>`);
  const index=new Map(nodes.map(n=>[keyOf(n.type,n.entry.id),n]));
  out.push(`<defs><clipPath id="graph-time-clip"><rect x="148" y="45" width="1250" height="${height-45}"/></clipPath></defs><g data-graph-layer="edges" clip-path="url(#graph-time-clip)">`);
  let edgeSerial=0;
  for(const link of model.links){const a=index.get(keyOf(link.from_type,link.from_id)),b=index.get(keyOf(link.to_type,link.to_id));if(!a||!b)continue;
    const x1=x(a.ranges[0].start_time),x2=x(b.ranges[0].start_time),same=a.type===b.type, y1=a.y+6,y2=b.y+6,bend=same?Math.min(y1,y2)-30:(y1+y2)/2,active=relatedEdges.has(link.id);
    const selectable=link.type==='transitions_to' && link.from_type==='emotion_state' && link.to_type==='emotion_state';
    const selected=selectable && focus?.type==='link'&&focus.id===link.id, bindingSelected=model.selectedReference===link.id, mapped=!!focus && focus.type!=='link' && active && !same;
    const opacity=selected || bindingSelected ? 1 : mapped ? 0.95 : (!same && focus && focus.type!=='link') ? 0.4 : 0.7;
    const interactive=selectable?`role="button" tabindex="0" aria-pressed="${selected}" aria-label="${escapeXML(`${a.id} ${labels[link.type]||link.type} ${b.id}`)}" cursor="pointer"`:'';
    const serial=edgeSerial++,gradient=`graph-edge-color-${serial}`,arrow=`graph-edge-arrow-${serial}`;
    out.push(`<defs><linearGradient id="${gradient}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0%" stop-color="${escapeXML(a.color)}"/><stop offset="100%" stop-color="${escapeXML(b.color)}"/></linearGradient><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="${escapeXML(b.color)}" stroke-width="1.4"/></marker></defs>`);
    out.push(`<path data-edge-id="${escapeXML(link.id)}" data-edge-kind="${selectable?'emotion-transition':'mapping'}" data-binding-selected="${bindingSelected}" data-related="${active}" ${interactive} d="M${x1} ${y1}C${x1} ${bend},${x2} ${bend},${x2} ${y2}" fill="none" stroke="${a.color===b.color?escapeXML(a.color):`url(#${gradient})`}" stroke-width="${bindingSelected?2.6:selected?2:mapped?1.8:1.25}" opacity="${opacity}" ${link.type==='associated_with'||same?'stroke-dasharray="4 4"':''} marker-end="url(#${arrow})"><title>${escapeXML(`${a.id} — ${labels[link.type]||link.type} → ${b.id}${link.note?': '+link.note:''}`)}</title></path>`);
    if(selectable)out.push(`<path data-edge-hit="${escapeXML(link.id)}" d="M${x1} ${y1}C${x1} ${bend},${x2} ${bend},${x2} ${y2}" fill="none" stroke="transparent" stroke-width="12" pointer-events="stroke" cursor="pointer"/>`);
  }
  out.push('</g><g data-graph-layer="nodes" clip-path="url(#graph-time-clip)">');
  const labelEnd=new Map();
  for(const n of [...nodes].sort((a,b)=>Number(a.focused)-Number(b.focused))){out.push(`<g role="button" tabindex="0" cursor="pointer" data-node-type="${n.type}" data-node-id="${escapeXML(n.entry.id)}" data-related="${n.related}" aria-pressed="${n.focused}" aria-label="${escapeXML(n.heading+' '+n.content)}" opacity="${n.related?1:.22}"><title>${escapeXML(n.heading+'\n'+n.content+'\n'+n.ranges.map(r=>`${r.start_time}s–${r.end_time}s`).join(' ∪ '))}</title>`);
    const binding=model.links.find(link=>link.id===model.selectedReference);if(binding?.from_type===n.type && binding.from_id===n.entry.id)out.push(`<circle data-binding-node="true" cx="${n.x}" cy="${n.y+6}" r="8" fill="none" stroke="#b28a43" stroke-width="2"/>`);
    for(const r of n.ranges)out.push(`<path d="M${x(r.start_time)} ${n.y+6}H${x(r.end_time)}" stroke="transparent" stroke-width="16"/>`);
    for(const r of n.ranges)out.push(`<path d="M${x(r.start_time)} ${n.y+6}H${x(r.end_time)}" stroke="${escapeXML(n.color)}" stroke-width="${n.focused?6:3}" stroke-linecap="round"/>`);
    if(n.focused)out.push(`<circle cx="${n.x}" cy="${n.y+6}" r="9" fill="none" stroke="${escapeXML(n.color)}" opacity=".35"/>`);
    out.push(`<circle cx="${n.x}" cy="${n.y+6}" r="3.5" fill="${escapeXML(n.color)}"/>`);
    if((n.focused || (focus?.type==='link' && n.related && n.type==='emotion_state')) && n.ranges.some(range=>range.end_time>=low && range.start_time<=high)) {
      const edge=model.links.find(link=>link.id===focus?.id),after=focus?.type==='link' && edge?.to_id===n.entry.id,offset=after?36:0;
      out.push(text(n.labelX,n.y-24+offset,short(n.heading),'data-state-label="heading" font-size="14" font-weight="600" stroke="#fcfcf9" stroke-width="4" paint-order="stroke"'),text(n.labelX,n.y-8+offset,short(n.content),'data-state-label="content" font-size="13" fill="#768277" stroke="#fcfcf9" stroke-width="4" paint-order="stroke"'));
    }
    else if(!focus && n.x>=154 && n.x>(labelEnd.get(n.type)||0)){out.push(text(n.x,n.y-6,n.id,'font-size="12" fill="#697b6b"'));labelEnd.set(n.type,n.x+65);}
    out.push('</g>');
  }
  out.push('</g></svg>');return out.join('');
}

export function graphViewLinks(graph) {
  const links = [...(graph.links || [])];
  for (const state of graph.emotion_transitions || []) {
    links.push({ id: `before-${state.id}`, from_type: 'emotion_state', from_id: state.from_state_id, to_type: 'emotion_transition', to_id: state.id, type: 'before_state' });
    links.push({ id: `after-${state.id}`, from_type: 'emotion_transition', from_id: state.id, to_type: 'emotion_state', to_id: state.to_state_id, type: 'after_state' });
  }
  return links;
}

export function projectGraphView(data, links, focus = null, { page = 0, pageSize = 50 } = {}) {
  const size = Number.isInteger(pageSize) && pageSize >= 2 ? Math.min(pageSize, 200) : 50;
  const index = new Map(), forward = new Map(), backward = new Map();
  for (const [, entries] of data) for (const node of entries) index.set(keyOf(node.type, node.entry.id), node);
  for (const link of links) {
    const from = keyOf(link.from_type, link.from_id), to = keyOf(link.to_type, link.to_id);
    if (!index.has(from) || !index.has(to)) continue;
    if (!forward.has(from)) forward.set(from, []); forward.get(from).push(to);
    if (!backward.has(to)) backward.set(to, []); backward.get(to).push(from);
  }
  const focusKey = focus && keyOf(focus.type, focus.id);
  let related = null;
  if (focusKey && index.has(focusKey)) {
    related = new Set([focusKey]);
    for (const adjacency of [forward, backward]) {
      const queue = [focusKey], visited = new Set([focusKey]);
      for (let cursor = 0; cursor < queue.length; cursor++) for (const next of adjacency.get(queue[cursor]) || []) {
        if (visited.has(next)) continue;
        visited.add(next); related.add(next); queue.push(next);
      }
    }
  }
  const candidates = data.map(([title, entries]) => [title, related ? entries.filter(node => related.has(keyOf(node.type, node.entry.id))) : entries]);
  const pagesFor = entries => {
    if (entries.length <= size) return 1;
    const pinned = related && entries.some(node => keyOf(node.type, node.entry.id) === focusKey);
    return Math.ceil((entries.length - (pinned ? 1 : 0)) / (size - (pinned ? 1 : 0)));
  };
  const pageCount = Math.max(1, ...candidates.map(([, entries]) => pagesFor(entries)));
  const current = Math.max(0, Math.min(pageCount - 1, Number.isFinite(page) ? Math.floor(page) : 0));
  const displayed = candidates.map(([title, entries]) => {
    if (entries.length <= size) return [title, [...entries]];
    const pinned = related ? entries.find(node => keyOf(node.type, node.entry.id) === focusKey) : null;
    const rest = pinned ? entries.filter(node => node !== pinned) : entries;
    const slots = size - (pinned ? 1 : 0), localPage = Math.min(current, pagesFor(entries) - 1);
    return [title, [...(pinned ? [pinned] : []), ...rest.slice(localPage * slots, (localPage + 1) * slots)]];
  });
  const visible = new Set(displayed.flatMap(([, entries]) => entries.map(node => keyOf(node.type, node.entry.id))));
  return {
    data: displayed,
    links: links.filter(link => visible.has(keyOf(link.from_type, link.from_id)) && visible.has(keyOf(link.to_type, link.to_id))),
    total: index.size, shown: visible.size, scopeTotal: candidates.reduce((sum, [, entries]) => sum + entries.length, 0),
    page: current, pageCount, mode: related ? 'focus' : 'all'
  };
}

const escapeXML = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const colors = { evidence: '#eef2f6', fact: '#edf3e7', event: '#f7f1e4', emotion_state: '#f2edf4', emotion_transition: '#f2edf4' };
const labels = { supports: '支持', constitutes: '构成', grounds: '情感判断依据', associated_with: '关联', causes: '因果判断', transitions_to: '情感变化', before_state: '变化前', after_state: '变化后' };

export function serializeFullGraphSVG(data, links, { labelFor = (_type, id) => id, reviewNames = {}, relationNames = {} } = {}) {
  const height = Math.max(260, 80 + Math.max(0, ...data.map(([, entries]) => entries.length)) * 88);
  const positions = new Map(), nodeWidth = 265, out = [];
  const text = (x, y, content, extra = '') => `<text x="${x}" y="${y}" font-family="sans-serif" font-size="12" fill="#294330" ${extra}>${escapeXML(content)}</text>`;
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1450" height="${height}" viewBox="0 0 1450 ${height}" data-export-scope="full" role="img" aria-label="完整四层关联图谱">`);
  out.push(`<rect width="1450" height="${height}" fill="#fbfcf8"/><defs><marker id="full-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#657d64"/></marker></defs>`);
  data.forEach(([title, entries], column) => {
    const x = 24 + column * 345;
    out.push(text(x, 28, `${title}（${entries.length}）`, 'font-weight="600"'));
    entries.forEach(({ type, entry }, row) => positions.set(keyOf(type, entry.id), { x, y: 52 + row * 88, type, entry }));
  });
  out.push('<g data-graph-layer="edges">');
  for (const link of links) {
    const from = positions.get(keyOf(link.from_type, link.from_id)), to = positions.get(keyOf(link.to_type, link.to_id));
    if (!from || !to) continue;
    const x1 = from.x + nodeWidth, y1 = from.y + 34, same = from.x === to.x, x2 = same ? to.x + nodeWidth : to.x, y2 = to.y + 34;
    const bend = same ? Math.max(x1, x2) + 78 : (x1 + x2) / 2, relation = { ...labels, ...relationNames }[link.type] || link.type;
    const dashed = same || link.type === 'associated_with' ? 'stroke-dasharray="5 4"' : '';
    out.push(`<path data-edge-id="${escapeXML(link.id)}" d="M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}" fill="none" stroke="#71836b" stroke-width="1.6" ${dashed} marker-end="url(#full-graph-arrow)"><title>${escapeXML(labelFor(link.from_type, link.from_id))} — ${escapeXML(relation)} → ${escapeXML(labelFor(link.to_type, link.to_id))}</title></path>`);
    out.push(text(same ? bend - 8 : (x1 + x2) / 2, (y1 + y2) / 2 - 6, relation, 'text-anchor="middle" stroke="#fbfcf8" stroke-width="3" paint-order="stroke"'));
  }
  out.push('</g><g data-graph-layer="nodes">');
  for (const { x, y, type, entry } of positions.values()) {
    const content = String(labelFor(type, entry.id)), characters = [...content], visible = characters.length > 40 ? [...characters.slice(0, 39), '…'] : characters;
    out.push(`<g data-node-type="${escapeXML(type)}" data-node-id="${escapeXML(entry.id)}"><rect x="${x}" y="${y}" width="${nodeWidth}" height="68" rx="4" fill="${colors[type] || '#f2f3ee'}" stroke="#b4c3ac"/>`);
    out.push(text(x + 10, y + 21, visible.slice(0, 20).join('')));
    if (visible.length > 20) out.push(text(x + 10, y + 39, visible.slice(20).join('')));
    const meta = type === 'evidence' ? `${entry.global_start_time}s → ${entry.global_end_time}s` : reviewNames[entry.review_status] || '';
    out.push(text(x + 10, y + 57, meta), `<title>${escapeXML(content)}</title></g>`);
  }
  out.push('</g></svg>');
  return out.join('');
}
