// View-only graph projection. Never truncate or mutate the authoritative graph.
const keyOf = (type, id) => JSON.stringify([type, id]);

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
const labels = { supports: '支持', constitutes: '构成', grounds: '情感判断依据', associated_with: '关联', causes: '因果判断', before_state: '变化前', after_state: '变化后' };

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
