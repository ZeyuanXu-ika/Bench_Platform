export const VERSION = '1.0';
export const MAX_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_ITEMS = 5000;
export const MAX_SEGMENTS = 1000;
export const LABELS = [
  { id: 'visual_observation', name: '视觉观察', color: '#377860', key: '1' },
  { id: 'speech_content', name: '言语内容', color: '#4d73a0', key: '2' },
  { id: 'acoustic_observation', name: '声学观察', color: '#b37a2f', key: '3' },
  { id: 'other', name: '其他证据', color: '#8c6c84', key: '4' },
];
export const ROLES = ['event_support', 'emotion_observation', 'both', 'uncertain'];
export const MEDIA_RE = /\.(mp4|webm|mov|m4v|wav|mp3|ogg|oga|flac|m4a|aac|opus)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

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
    clip_start_s: finite(raw.clip_start_s, '原片起始秒'),
    duration_s: finite(raw.duration_s ?? raw.media?.duration_s, '素材时长', null),
    video_fps: fps, text: text(raw.text, '任务说明'),
  };
}
export function parseManifest(input) {
  const raw = typeof input === 'string' ? parseJSON(input) : input;
  const list = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS) throw new Error('任务清单应包含 1–5000 条 items');
  if (!Array.isArray(raw) && raw.schema_version && raw.schema_version !== VERSION) throw new Error('任务清单版本不受支持');
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
    index: 0, revision: 0, exported_revision: -1, updated_at: new Date().toISOString() };
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
  return { id: identifier(raw.id, '片段 ID') || crypto.randomUUID(), start_time: start, end_time: end, label: raw.label,
    annotations: { subject_id: text(a.subject_id, '主体 ID', 500), observation: text(a.observation, '观察内容'),
      evidence_role: role, uncertainty: text(a.uncertainty, '不确定性', 5000) } };
}
export function completionErrors(item, record) {
  const errors = [];
  if (!record.segments.length) errors.push('至少创建一条证据片段');
  for (const [i, seg] of record.segments.entries()) {
    try { cleanSegment(seg, item); } catch (e) { errors.push(`片段 ${i + 1}：${e.message}`); }
    if (!seg.annotations.subject_id.trim()) errors.push(`片段 ${i + 1}：填写主体 ID，未知可填 unknown`);
    if (!seg.annotations.observation.trim()) errors.push(`片段 ${i + 1}：填写观察内容`);
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
  if (record.status === 'complete' && completionErrors(item, record).length) throw new Error(`${item.id} 标记为已完成，但必填字段不完整`);
  return record;
}
export function parseResults(input) {
  const raw = typeof input === 'string' ? parseJSON(input) : input;
  if (raw?.format !== 'trace-annotations' || raw.schema_version !== VERSION) throw new Error('请选择本平台导出的 1.0 版本结果文件');
  const manifest = parseManifest(raw);
  const ws = newWorkspace(manifest);
  for (let i = 0; i < manifest.items.length; i++) {
    const item = manifest.items[i]; ws.records[item.id] = cleanRecord(raw.items[i], item);
  }
  ws.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  ws.exported_revision = ws.revision;
  return ws;
}
export function makeExport(ws) {
  const m = ws.manifest;
  if (!m.batch_id || !m.assignment_id || !m.annotator_id) throw new Error('请先填写批次 ID、任务 ID 和标注员 ID');
  return { format: 'trace-annotations', schema_version: VERSION, batch_id: m.batch_id,
    assignment_id: m.assignment_id, annotator_id: m.annotator_id, revision: ws.revision, exported_at: new Date().toISOString(),
    items: m.items.map(item => ({ ...item, ...cleanRecord(ws.records[item.id], item) })) };
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
    return { id: path, title: f.name, media_path: path, media_type: VIDEO_RE.test(path) ? 'video' : 'audio', source_id: path, clip_start_s: 0, duration_s: null, video_fps: null, text: '' };
  });
  return parseManifest({ batch_id: 'local-batch', items });
}
export function safeFilename(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'result';
}
export function displayTime(n) {
  if (!Number.isFinite(n)) return '00:00.000';
  const ms = Math.round(n * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
