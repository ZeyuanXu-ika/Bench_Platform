import { blankGraph, normalizeGraph, migrateLegacyGraph, eventTimeRanges, factTemporalDetails, annotationIdCounters, evidenceKey, graphIssues, assertTemporalOrder } from './graph.mjs';
import { materialWorkspace } from './material-scope.mjs';

export const VERSION = '2.0';

// Session-only history. Files, revisions and storage tokens stay outside snapshots.
export function createWorkspaceHistory({ maxSteps = 30, maxBytes = 32 * 1024 * 1024 } = {}) {
  const serialize = ws => JSON.stringify({ manifest: ws.manifest, records: ws.records, graph: ws.graph });
  let workspaceID, baseline = '', entries = [], bytes = 0;
  function reset(ws) { workspaceID = ws?.id; baseline = ws ? serialize(ws) : ''; entries = []; bytes = 0; }
  function record(ws) {
    if (!ws || workspaceID !== ws.id) { reset(ws); return false; }
    const next = serialize(ws);
    if (next === baseline) return false;
    entries.push(baseline); bytes += baseline.length * 2; baseline = next;
    while (entries.length && (entries.length > maxSteps || bytes > maxBytes)) bytes -= entries.shift().length * 2;
    return true;
  }
  function undo(ws) {
    if (!ws || workspaceID !== ws.id || !entries.length) return false;
    if (serialize(ws) !== baseline) throw new Error('当前数据尚在修改中，请完成或取消本次操作后撤回');
    const previous = entries.at(-1), restored = JSON.parse(previous);
    Object.assign(ws, restored); entries.pop(); bytes -= previous.length * 2; baseline = previous;
    return true;
  }
  return { reset, record, undo, get canUndo() { return entries.length > 0; }, get size() { return entries.length; } };
}
export const MAX_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_ITEMS = 5000;
export const MAX_SEGMENTS = 1000;
export const LABELS = [
  { id: 'unclassified', name: '待分类', color: '#687684', key: '0' },
  { id: 'visual_observation', name: '视觉观察', color: '#377860', key: '1' },
  { id: 'speech_content', name: '言语内容', color: '#4d73a0', key: '2' },
  { id: 'acoustic_observation', name: '声学观察', color: '#b37a2f', key: '3' },
  { id: 'other', name: '其他证据', color: '#8c6c84', key: '4' },
];
export const ROLES = ['event_support', 'emotion_observation', 'both', 'uncertain'];
export const MEDIA_RE = /\.(mp4|webm|mov|m4v|wav|mp3|ogg|oga|flac|m4a|aac|opus|weba)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
function canonicalSubjects(value, name) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name}必须是最多 100 项的列表`);
  const result = value.map(value => { const id = identifier(value, `${name} ID`); if (!id) throw new Error(`${name} ID 不能为空`); return id; });
  if (new Set(result).size !== result.length) throw new Error(`${name} ID 重复`);
  return result;
}

export function text(value, name, max = 20000, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} 必须是长度不超过 ${max} 的文本`);
  return value;
}
export function identifier(value, name, fallback = '') {
  const s = text(value, name, 200, fallback).trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`${name} 含有控制字符`);
  return s;
}
export function mediaPath(value) {
  const s = text(value, '素材相对路径', 1024).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!s || /[:\u0000-\u001f]/.test(s) || s.split('/').some(x => x === '..' || x === '.')) {
    throw new Error('素材必须使用任务包内的相对路径，不能使用网址、绝对磁盘路径或 ..');
  }
  if (!MEDIA_RE.test(s)) throw new Error(`不支持的素材扩展名：${s}`);
  return s;
}
function finite(value, name, fallback = 0, min = 0) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`${name} 不是有效数字`);
  return value;
}
export function parseJSON(source) {
  if (new TextEncoder().encode(source).length > MAX_JSON_BYTES) throw new Error('JSON 文件超过 20MB，请拆分任务批次');
  try { return JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error('无法解析 JSON，请确认文件完整且使用 UTF-8 编码'); }
}
function cleanItem(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`第 ${index + 1} 条任务格式不正确`);
  const id = identifier(raw.id, '素材 ID');
  if (!id) throw new Error(`第 ${index + 1} 条任务缺少 id`);
  const path = mediaPath(raw.media_path ?? raw.media?.path ?? raw.video_url ?? raw.audio_url);
  const type = raw.media_type ?? raw.media?.type ?? (VIDEO_RE.test(path) ? 'video' : 'audio');
  if (!['video', 'audio'].includes(type)) throw new Error(`${id} 的 media_type 只能是 video 或 audio`);
  const fps = finite(raw.video_fps, '参考帧率', null);
  if (fps !== null && (fps <= 0 || fps > 240)) throw new Error('参考帧率应大于 0 且不超过 240');
  return {
    id, title: text(raw.title, '素材标题', 500, id), media_path: path, media_type: type,
    source_id: identifier(raw.source_id, '原片 ID', id),
    timeline_id: identifier(raw.timeline_id, '共同时间轴 ID', raw.source_id || id),
    time_offset_s: (() => {
      const offset = raw.time_offset_s ?? raw.clip_start_s ?? 0;
      if (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > 1e9) throw new Error('共同时间轴偏移必须是有效秒数');
      return offset;
    })(),
    clip_start_s: finite(raw.clip_start_s, '原片起始秒'),
    duration_s: finite(raw.duration_s ?? raw.media?.duration_s, '素材时长', null),
    video_fps: fps, text: text(raw.text, '任务说明'), ...(Object.hasOwn(raw, 'subject_ids') ? { subject_ids: canonicalSubjects(raw.subject_ids, '任务主体') } : {}),
  };
}
export function parseManifest(input) {
  const raw = typeof input === 'string' ? parseJSON(input) : input;
  const list = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS) throw new Error('任务清单应包含 1–5000 条 items');
  if (!Array.isArray(raw) && raw.schema_version && !['1.0', VERSION].includes(raw.schema_version)) throw new Error('任务清单版本不受支持');
  const items = list.map(cleanItem);
  if (new Set(items.map(x => x.id)).size !== items.length) throw new Error('任务清单存在重复素材 ID');
  return {
    batch_id: identifier(raw.batch_id, '批次 ID', 'local-batch'),
    assignment_id: identifier(raw.assignment_id, '任务 ID'),
    annotator_id: identifier(raw.annotator_id, '标注员 ID'), items,
  };
}
export function blankRecord(item) {
  return { id: item.id, status: 'draft', segments: [], local_fact_notes: '', task_notes: '', media: null };
}
export function newWorkspace(manifest) {
  return { id: crypto.randomUUID(), manifest, records: Object.fromEntries(manifest.items.map(x => [x.id, blankRecord(x)])),
    graph: blankGraph(), index: 0, revision: 0, exported_revision: -1, updated_at: new Date().toISOString() };
}
export function cleanSegment(raw, item) {
  if (!raw || typeof raw !== 'object') throw new Error('片段不是有效对象');
  const start = finite(raw.start_time, '片段起点');
  const end = finite(raw.end_time, '片段终点');
  if (end <= start) throw new Error('片段终点必须大于起点');
  if (item.duration_s !== null && end > item.duration_s + 0.05) throw new Error('片段超出素材时长');
  if (!LABELS.some(x => x.id === raw.label) || (item.media_type === 'audio' && raw.label === 'visual_observation')) throw new Error('片段标签不受支持');
  const a = raw.annotations ?? {};
  const role = text(a.evidence_role, '证据用途', 50);
  if (role && !ROLES.includes(role)) throw new Error('证据用途不受支持');
  const additions = {};
  if (Object.hasOwn(a, 'subject_ids')) {
    additions.subject_ids = canonicalSubjects(a.subject_ids, '证据主体');
  }
  if (Object.hasOwn(a, 'fact_id')) additions.fact_id = identifier(a.fact_id, '证据事实 ID');
  if(Object.hasOwn(a,'observation_kind')){if(!['observation','reported_speech'].includes(a.observation_kind))throw new Error('证据描述类型无效');additions.observation_kind=a.observation_kind;}
  if(Object.hasOwn(a,'speaker_id'))additions.speaker_id=identifier(a.speaker_id,'证据发言者');
  if(Object.hasOwn(a,'fact_seeded')){if(typeof a.fact_seeded!=='boolean')throw new Error('证据初始事实标记无效');additions.fact_seeded=a.fact_seeded;}
  return { id: identifier(raw.id, '片段 ID') || crypto.randomUUID(), start_time: start, end_time: end, label: raw.label,
    annotations: { subject_id: text(a.subject_id, '主体 ID', 500), observation: text(a.observation, '观察内容'), local_fact: text(a.local_fact, '局部事实'),
      evidence_role: role, uncertainty: text(a.uncertainty, '不确定性', 5000), ...additions } };
}
export function editInterval(segment, delta, mode, duration) {
  if (!Number.isFinite(delta) || !Number.isFinite(duration) || duration <= 0) throw new Error('无效的时间轴位置');
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const round = value => Math.round(value * 1000) / 1000;
  let start = segment.start_time, end = segment.end_time;
  if (mode === 'move') {
    const length = end - start;
    start = clamp(round(start + delta), 0, Math.max(0, duration - length));
    end = start + length;
  } else if (mode === 'start') start = clamp(round(start + delta), 0, Math.max(0, end - .001));
  else if (mode === 'end') end = clamp(round(end + delta), Math.min(duration, start + .001), duration);
  else throw new Error('无效的时间框操作');
  return { start_time: start, end_time: end };
}
export function completionErrors(item, record) {
  const errors = [];
  if (!record.segments.length) errors.push('至少创建一条证据片段');
  for (const [i, seg] of record.segments.entries()) {
    if (seg.label === 'unclassified') errors.push(`片段 ${i + 1}：请选择归属类别`);
    try { cleanSegment(seg, item); } catch (e) { errors.push(`片段 ${i + 1}：${e.message}`); }
    if (Object.hasOwn(seg.annotations, 'subject_ids') ? !seg.annotations.subject_ids?.length : !(seg.annotations.subject_id || '').trim()) errors.push(`片段 ${i + 1}：请选择主体或新建主体`);
    if (!(seg.annotations.local_fact || '').trim() && !(seg.annotations.observation || '').trim()) errors.push(`片段 ${i + 1}：填写局部事实或观察内容`);
    if (!seg.annotations.evidence_role) errors.push(`片段 ${i + 1}：选择证据用途`);
  }
  return errors;
}
export function cleanRecord(raw, item) {
  if (!Array.isArray(raw.segments) || raw.segments.length > MAX_SEGMENTS) throw new Error('片段列表无效或超过 1000 条');
  const segments = raw.segments.map(s => cleanSegment(s, item));
  if (new Set(segments.map(s => s.id)).size !== segments.length) throw new Error('片段 ID 重复');
  const record = { id: item.id, status: raw.status === 'complete' ? 'complete' : 'draft', segments,
    local_fact_notes: text(raw.local_fact_notes, '事实草稿'), task_notes: text(raw.task_notes, '操作备注'), media: null };
  if (raw.media) record.media = {
    name: text(raw.media.name, '文件名', 1024), path: mediaPath(raw.media.path ?? item.media_path), type: item.media_type,
    size: finite(raw.media.size, '文件大小'), last_modified: finite(raw.media.last_modified, '文件修改时间'),
    duration_s: finite(raw.media.duration_s, '媒体实际时长', null),
  };
  if(raw.annotation_source)record.annotation_source={file_name:text(raw.annotation_source.file_name,'标注文件名',1024),material_id:identifier(raw.annotation_source.material_id,'标注素材 ID'),annotation_id:identifier(raw.annotation_source.annotation_id,'标注 ID')};
  if (record.status === 'complete' && completionErrors(item, record).length) throw new Error(`${item.id} 标记为已完成，但必填字段不完整`);
  return record;
}
export function parseResults(input) {
  const raw = typeof input === 'string' ? parseJSON(input) : input;
  if (raw?.format !== 'trace-annotations' || !['1.0', VERSION].includes(raw.schema_version)) throw new Error('请选择本平台导出的 1.0 或 2.0 版本结果文件');
  const manifest = parseManifest(raw);
  if(raw.export_scope==='item'&&(manifest.items.length!==1||raw.source_item_id!==manifest.items[0].id))throw new Error('标注的 source_item_id 与素材编号不一致');
  const ws = newWorkspace(manifest);
  if (raw.id_counters !== undefined) {
    if (!raw.id_counters || typeof raw.id_counters !== 'object' || Array.isArray(raw.id_counters)) throw new Error('标注 ID 计数无效');
    ws.id_counters = annotationIdCounters({ id_counters: raw.id_counters });
  }
  for (let i = 0; i < manifest.items.length; i++) {
    const item = manifest.items[i]; ws.records[item.id] = cleanRecord(raw.items[i], item);
  }
  if (raw.schema_version === '1.0') ws.graph = migrateLegacyGraph(ws);
  else {
    if (!raw.graph || typeof raw.graph !== 'object') throw new Error('2.0 结果文件缺少四层图谱数据');
    ws.graph = normalizeGraph(raw.graph, ws);
  }
  ws.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  ws.exported_revision = ws.revision;
  if (raw.cross_material_references && typeof raw.cross_material_references === 'object') ws.cross_material_references = structuredClone(raw.cross_material_references);
  return ws;
}
export function makeExport(ws, { validateTemporal = true } = {}) {
  const m = ws.manifest;
  if (!m.batch_id || !m.assignment_id || !m.annotator_id) throw new Error('请先填写批次 ID、任务 ID 和标注员 ID');
  const graph = normalizeGraph(ws.graph || migrateLegacyGraph(ws), ws);
  if (validateTemporal) assertTemporalOrder(ws, graph);
  return { format: 'trace-annotations', schema_version: VERSION, batch_id: m.batch_id,
    assignment_id: m.assignment_id, annotator_id: m.annotator_id, revision: ws.revision, exported_at: new Date().toISOString(),
    items: m.items.map(item => ({ ...item, ...cleanRecord(ws.records[item.id], item) })),
    graph, id_counters: annotationIdCounters(ws), time_semantics:{unit:'seconds',evidence:'presentation',fact:'occurrence',event:'union_of_constituent_facts',emotion_state:'observation',segment_time_basis:'media_seconds',graph_time_basis:'timeline_seconds',alignment:'timeline_seconds = media_seconds + time_offset_s'},derived: { event_time_ranges: eventTimeRanges(ws, graph),fact_temporal:factTemporalDetails(ws,graph) },
    ...(ws.cross_material_references ? { cross_material_references: structuredClone(ws.cross_material_references) } : {}) };
}

function itemExport(base, itemID) {
  const item=base.items.find(item=>item.id===itemID);if(!item)throw new Error('请选择有效素材');
  const local=materialWorkspace({manifest:{items:base.items},records:Object.fromEntries(base.items.map(item=>[item.id,item])),graph:base.graph},itemID);
  if(local.graph.status==='complete'&&graphIssues(local).some(issue=>issue.severity==='error'))local.graph.status='draft';
  const output={...base,export_scope:'item',source_item_id:itemID,items:[{...item,...local.records[itemID]}],graph:local.graph,derived:{event_time_ranges:eventTimeRanges(local),fact_temporal:factTemporalDetails(local)}};
  const localKeys=new Set(local.graph.links.map(link=>link.id)),localNodes=new Set(['facts','events','emotion_states','emotion_transitions'].flatMap(key=>local.graph[key].map(node=>node.id)));
  const external=base.graph.links.filter(link=>(!localKeys.has(link.id)&&(localNodes.has(link.from_id)||localNodes.has(link.to_id)))||(localKeys.has(link.id)&&link.content_refs?.length!==local.graph.links.find(entry=>entry.id===link.id)?.content_refs?.length));
  if(external.length||base.cross_material_references)output.cross_material_references={...(base.cross_material_references||{}),links:[...new Map([...(base.cross_material_references?.links||[]),...external].map(link=>[link.id,link])).values()]};
  else delete output.cross_material_references;return output;
}

export function makeItemExport(ws, itemID) {
  const result = itemExport(makeExport(ws, { validateTemporal: false }), itemID);
  assertTemporalOrder({ manifest: { items: result.items }, records: Object.fromEntries(result.items.map(item => [item.id, item])), graph: result.graph });
  return result;
}
export function makeItemExportFiles(ws) {
  const base = makeExport(ws), names = new Set();
  return base.items.map((item, index) => {
    const stem = safeFilename(item.media_path.replaceAll('\\', '/').split('/').pop().replace(/\.[^.]+$/, ''));
    let name = `${stem}.json`;
    if (names.has(name.toLocaleLowerCase())) name = `${stem}__${safeFilename(item.id)}_${index + 1}.json`;
    names.add(name.toLocaleLowerCase());
    return { item_id: item.id, name, payload: itemExport(base, item.id) };
  });
}

// Store-only ZIP: one independent UTF-8 JSON file per material, without extra dependencies.
export function packAnnotationFiles(files) {
  if (files.length > 65535) throw new Error('批量导出文件过多，请拆分任务');
  const encoder = new TextEncoder(), table = Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
    return n >>> 0;
  });
  const parts = [], directory = []; let offset = 0;
  const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };
  for (const file of files) {
    const name = encoder.encode(file.name), data = encoder.encode(JSON.stringify(file.payload, null, 2) + '\n'), crc = crc32(data);
    if (name.length > 65535 || offset + data.length + name.length + 30 > 0xffffffff) throw new Error('导出包过大，请拆分任务');
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    parts.push(header, data); directory.push(central); offset += header.length + data.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  if (offset + directorySize + end.length > 0xffffffff) throw new Error('导出包过大，请拆分任务');
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + directorySize + end.length); let cursor = 0;
  for (const part of [...parts, ...directory, end]) { result.set(part, cursor); cursor += part.length; }
  return result;
}
export function matchFile(item, files) {
  const target = item.media_path.toLocaleLowerCase();
  const entries = files.map(file => ({ file, path: (file.webkitRelativePath || file.name).replaceAll('\\', '/').toLocaleLowerCase() }));
  let found = entries.filter(x => x.path === target || x.path.endsWith('/' + target));
  if (!found.length) found = entries.filter(x => x.path.split('/').pop() === target.split('/').pop());
  if (found.length > 1) throw new Error(`${item.media_path} 匹配到多个同名文件，请使用清单中的完整相对路径或只选择所属文件夹`);
  return found[0]?.file ?? null;
}
export function manifestFromFiles(files) {
  const items = files.map(f => {
    const path = mediaPath(f.webkitRelativePath || f.name);
    return { id: path, title: f.name, media_path: path, media_type: f.type?.startsWith('audio/') ? 'audio' : VIDEO_RE.test(path) ? 'video' : 'audio', source_id: path, clip_start_s: 0, duration_s: null, video_fps: null, text: '' };
  });
  return parseManifest({ batch_id: 'local-batch', items });
}
export function planMediaImport(manifest, files) {
  const items = [...(manifest?.items || [])];
  const added = [], bindings = [];
  const ids = new Set(items.map(task => task.id));
  const pathOf = value => value.replaceAll('\\', '/').toLocaleLowerCase();
  let skipped = 0;
  for (const file of files) {
    const candidate = manifestFromFiles([file]).items[0];
    const path = pathOf(candidate.media_path);
    let matches = items.filter(task => path === pathOf(task.media_path) || path.endsWith('/' + pathOf(task.media_path)));
    if (!matches.length && !file.webkitRelativePath) {
      matches = items.filter(task => pathOf(task.media_path).split('/').pop() === path);
      if (new Set(matches.map(task => pathOf(task.media_path))).size > 1) throw new Error(`${file.name} 对应多个不同路径，请选择所属素材文件夹后导入`);
    }
    if (matches.length) {
      skipped++; bindings.push({ file, ids: matches.map(task => task.id) }); continue;
    }
    const base = candidate.id; let suffix = 2;
    while (ids.has(candidate.id)) candidate.id = `${base.slice(0, 185)}_${suffix++}`;
    ids.add(candidate.id); items.push(candidate); added.push(candidate);
    bindings.push({ file, ids: [candidate.id] });
  }
  if (items.length > MAX_ITEMS) throw new Error(`补充后超过 ${MAX_ITEMS} 条任务，请拆分批次`);
  return { added, bindings, skipped };
}
export function safeFilename(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'result';
}
export function displayTime(n) {
  if (!Number.isFinite(n)) return '00:00.000';
  const ms = Math.round(n * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
