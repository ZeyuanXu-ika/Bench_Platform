import { LABELS, MAX_JSON_BYTES, MAX_ITEMS, MAX_SEGMENTS, MEDIA_RE, blankRecord, cleanSegment, completionErrors,
  displayTime, editInterval, identifier, makeExport, manifestFromFiles, matchFile, newWorkspace, parseManifest, parseResults, planMediaImport, safeFilename } from './core.mjs';
import { listWorkspaces, removeWorkspace, storeWorkspace } from './storage.mjs';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = `bench-settings-v1:${new URL('.', location.href).pathname}`;
const DEFAULT_SETTINGS = { height: 'auto', fit: 'contain', speed: '1', step: '0.1', export: 'picker' };
let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  for (const [key, values] of Object.entries({ height: ['auto', '320', '420', '540'], fit: ['contain', 'cover'], speed: ['0.5', '0.75', '1', '1.25', '1.5', '2'], step: ['0.04', '0.1', '0.5', '1'], export: ['picker', 'download'] })) {
    if (values.includes(saved?.[key])) settings[key] = saved[key];
  }
} catch { /* Storage can be unavailable; defaults remain usable. */ }
let ws = null;
let selected = null;
let activeLabel = 'unclassified';
let attached = new Map();
let mediaURL = null;
let currentMedia = null;
let loaded = false;
let toastTimer;
let draftTimer;
let saveQueue = Promise.resolve();
let busy = false;
let frameEdit = null;
let frameSeek = 0;
const item = () => ws?.manifest.items[ws.index];
const record = () => ws?.records[item()?.id];
const segment = () => record()?.segments.find(s => s.id === selected);
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function notify(message, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 12000 : 6000);
}
function status(message, error = false) { $('draft-status').textContent = message; if (error) notify(message, true); }
function run(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(e => notify(e.message || '操作失败，请重试', true)); }
function enqueueDraft() {
  if (!ws) return Promise.resolve();
  clearTimeout(draftTimer);
  ws.updated_at = new Date().toISOString();
  const snapshot = structuredClone(ws);
  status('正在保存浏览器草稿…');
  saveQueue = saveQueue.catch(() => {}).then(() => storeWorkspace(snapshot));
  return saveQueue.then(token => {
    if (ws?.id === snapshot.id) ws._storage_token = token;
    if (ws?.id === snapshot.id && ws.revision === snapshot.revision) status(ws.revision === ws.exported_revision ? '本地结果已导出 · 草稿已存浏览器' : '草稿已存浏览器 · 尚有未导出修改');
  }).catch(e => { status(e.message || '浏览器草稿不可用，请及时导出文件', true); });
}
function changed(invalidate = true) {
  if (!ws) return;
  if (invalidate) record().status = 'draft';
  ws.revision++; ws.updated_at = new Date().toISOString();
  status('修改尚未导出 · 正在记录草稿');
  clearTimeout(draftTimer); draftTimer = setTimeout(enqueueDraft, 350);
  renderProgress();
}
function renderProgress() {
  if (!ws) return;
  const completed = ws.manifest.items.filter(x => ws.records[x.id].status === 'complete').length;
  $('progress').max = ws.manifest.items.length; $('progress').value = completed;
  $('task-count').textContent = ws.manifest.items.length;
  $('progress-label').textContent = `${completed} / ${ws.manifest.items.length} 已完成`;
  $('progress-percent').textContent = `${Math.round(completed / ws.manifest.items.length * 100)}%`;
  renderTaskList();
}
function renderTaskList() {
  const scrollTop = $('task-list').scrollTop;
  const query = $('task-search').value.toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  for (const [index, task] of ws.manifest.items.entries()) {
    if (query && !`${task.id} ${task.title}`.toLocaleLowerCase().includes(query)) continue;
    const rec = ws.records[task.id];
    const b = el('button', `task-item${index === ws.index ? ' active' : ''}${rec.status === 'complete' ? ' complete' : ''}`);
    b.dataset.mediaType = task.media_type;
    b.type = 'button'; b.setAttribute('aria-current', index === ws.index ? 'true' : 'false');
    b.append(el('span', 'task-dot', rec.status === 'complete' ? '✓' : String(index + 1).padStart(2, '0')));
    const info = el('span'); info.append(el('span', 'task-name', task.title), el('span', 'task-meta', `${task.media_type === 'video' ? '视频' : '音频'} · ${task.id}`));
    b.append(info); b.addEventListener('click', run(() => switchItem(index))); fragment.append(b);
  }
  $('task-list').replaceChildren(fragment);
  $('task-list').scrollTop = scrollTop;
}
function renderLabels() {
  const fragment = document.createDocumentFragment();
  for (const label of LABELS.filter(l => item().media_type === 'video' || l.id !== 'visual_observation')) {
    const b = el('button', 'label-button' + (activeLabel === label.id ? ' active' : ''));
    b.type = 'button'; b.dataset.label = label.id; b.setAttribute('aria-pressed', String(activeLabel === label.id));
    const dot = el('span', 'label-dot'); dot.style.backgroundColor = label.color;
    b.append(dot, el('span', '', label.name), el('kbd', '', label.key));
    b.addEventListener('click', () => chooseLabel(label.id)); fragment.append(b);
  }
  $('labels').replaceChildren(fragment);
}
function chooseLabel(id) {
  if (!ws || !LABELS.some(x => x.id === id) || (item().media_type === 'audio' && id === 'visual_observation')) return;
  activeLabel = id;
  if (segment()) { segment().label = id; changed(); renderSegments(); renderDetail(); }
  renderLabels();
}
function renderTimeline() {
  if (frameEdit) cancelFrameEdit();
  const frag = document.createDocumentFragment();
  const duration = item()?.duration_s;
  $('timeline-draw').setAttribute('aria-disabled', String(!loaded));
  $('timeline-duration').textContent = duration ? `0:00 — ${displayTime(duration)}` : '等待加载素材';
  if (duration) for (const seg of record().segments) {
    const b = el('button', 'timeline-segment' + (seg.id === selected ? ' active' : ''));
    b.dataset.segmentId = seg.id;
    b.style.left = `${Math.min(100, seg.start_time / duration * 100)}%`;
    b.style.width = `${Math.max(0.2, Math.min(100, (seg.end_time - seg.start_time) / duration * 100))}%`;
    b.style.backgroundColor = LABELS.find(x => x.id === seg.label).color;
    b.title = `${LABELS.find(x => x.id === seg.label).name} ${displayTime(seg.start_time)}–${displayTime(seg.end_time)}`;
    b.append(el('span', 'timeline-segment-label', LABELS.find(x => x.id === seg.label).name));
    if (seg.id === selected && loaded) {
      b.title += ' · 拖动框身整体移动，拖动左右边缘调整起止点';
      for (const edge of ['start', 'end']) {
        const handle = el('span', `timeline-handle timeline-handle-${edge}`);
        handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true');
        b.append(handle);
      }
    }
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', e => { if (!e.detail || !loaded) selectSegment(seg.id); });
    const lane = el('div', 'timeline-lane'); lane.append(b); frag.append(lane);
  }
  $('timeline').replaceChildren(frag);
}
function renderSegments() {
  const scrollTop = $('segment-list').scrollTop;
  $('segment-count').textContent = record().segments.length;
  const fragment = document.createDocumentFragment();
  if (!record().segments.length) fragment.append(el('div', 'empty-segments', '还没有片段。标记起止位置，创建第一条证据。'));
  for (const seg of record().segments) {
    const label = LABELS.find(x => x.id === seg.label);
    const b = el('button', 'segment-row' + (selected === seg.id ? ' active' : '')); b.type = 'button'; b.dataset.segmentId = seg.id;
    b.style.setProperty('--category-color', label.color);
    b.style.setProperty('--category-tint', `${label.color}18`);
    const info = el('span'); const main = el('span', 'segment-main'); const dot = el('span', 'label-dot'); dot.style.backgroundColor = label.color;
    main.append(dot, el('span', '', label.name)); info.append(main);
    if (seg.annotations.local_fact || seg.annotations.observation) info.append(el('div', 'segment-note', seg.annotations.local_fact || seg.annotations.observation));
    b.setAttribute('aria-pressed', String(selected === seg.id));
    b.append(info, el('span', 'segment-times', `${displayTime(seg.start_time)} → ${displayTime(seg.end_time)}`));
    b.addEventListener('click', () => selectSegment(seg.id)); fragment.append(b);
  }
  $('segment-list').replaceChildren(fragment); $('segment-list').scrollTop = scrollTop; renderTimeline();
}
function renderDetail() {
  const seg = segment();
  $('segment-detail').hidden = !seg; $('detail-empty').hidden = Boolean(seg);
  $('delete-segment').disabled = !seg;
  if (!seg) return;
  $('detail-label').textContent = LABELS.find(x => x.id === seg.label).name;
  const category = $('segment-category');
  category.replaceChildren(...LABELS.filter(l => item().media_type === 'video' || l.id !== 'visual_observation').map(l => {
    const option = el('option', '', l.name); option.value = l.id; return option;
  }));
  category.value = seg.label;
  $('detail-time').textContent = `${displayTime(seg.start_time)} → ${displayTime(seg.end_time)}`;
  for (const [id, key] of [['subject-id', 'subject_id'], ['local-fact', 'local_fact'], ['observation', 'observation'], ['evidence-role', 'evidence_role']]) $(id).value = seg.annotations[key] || '';
}
function selectSegment(id) {
  selected = id; const seg = segment(); if (!seg) return;
  activeLabel = seg.label; $('segment-start').value = seg.start_time.toFixed(3); $('segment-end').value = seg.end_time.toFixed(3);
  if (loaded) currentMedia.currentTime = seg.start_time;
  renderLabels(); renderSegments(); renderDetail();
}
function previewFrameEdit(times, seek = true) {
  const edit = frameEdit;
  edit.preview = times;
  edit.node.style.left = `${times.start_time / edit.duration * 100}%`;
  edit.node.style.width = `${Math.max(.2, (times.end_time - times.start_time) / edit.duration * 100)}%`;
  const text = `${displayTime(times.start_time)} → ${displayTime(times.end_time)}`;
  $('segment-start').value = times.start_time.toFixed(3); $('segment-end').value = times.end_time.toFixed(3);
  $('detail-time').textContent = text;
  const row = [...$('segment-list').children].find(node => node.dataset.segmentId === edit.id);
  if (row) row.querySelector('.segment-times').textContent = text;
  $('timeline-selection').textContent = `${text} · 松开保存，Esc 取消`;
  if (seek && !frameSeek) frameSeek = requestAnimationFrame(() => {
    frameSeek = 0;
    if (!frameEdit || !loaded || ws?.id !== edit.workspace || item()?.id !== edit.task) return;
    const time = edit.mode === 'end' ? edit.preview.end_time : edit.preview.start_time;
    currentMedia.currentTime = time;
    $('current-time').textContent = displayTime(time); $('seek').value = time;
  });
}
function cancelFrameEdit() {
  if (!frameEdit) return;
  const edit = frameEdit;
  previewFrameEdit(edit.original, false);
  cancelAnimationFrame(frameSeek); frameSeek = 0;
  if (loaded && ws?.id === edit.workspace && item()?.id === edit.task) {
    currentMedia.currentTime = edit.playhead;
    $('current-time').textContent = displayTime(edit.playhead); $('seek').value = edit.playhead;
  }
  edit.node.classList.remove('dragging');
  frameEdit = null;
  if ($('timeline').hasPointerCapture(edit.pointer)) $('timeline').releasePointerCapture(edit.pointer);
  $('timeline-selection').textContent = '选中时间框后，拖动框身移动；拖动左右边缘调整起止时间。';
}
function newSegment() {
  if (!ws) return;
  activeLabel = 'unclassified';
  selected = null; $('segment-start').value = ''; $('segment-end').value = '';
  renderLabels(); renderSegments(); renderDetail();
}
function markStart() {
  if (!loaded) return notify('请先选择并加载本地素材', true);
  if (selected) newSegment();
  $('segment-start').value = currentMedia.currentTime.toFixed(3);
}
function markEnd() {
  if (!loaded) return notify('请先选择并加载本地素材', true);
  if (selected) newSegment();
  $('segment-end').value = currentMedia.currentTime.toFixed(3);
}
function addSegment() {
  if (!ws || !loaded) throw new Error('请先选择并加载本地素材');
  if ($('segment-start').value === '' || $('segment-end').value === '') throw new Error('请先标记起点和终点');
  if (record().segments.length >= MAX_SEGMENTS) throw new Error('单条素材最多支持 1000 个时间窗，请拆分任务');
  const next = cleanSegment({ id: crypto.randomUUID(), start_time: Number($('segment-start').value), end_time: Number($('segment-end').value),
    label: 'unclassified', annotations: {} }, item());
  record().segments.push(next);
  selected = next.id; activeLabel = next.label; changed(); renderSegments(); renderDetail();
  $('segment-category').focus();
  enqueueDraft();
}
function updateSelectedTimes() {
  const old = segment();
  if (!old) return;
  try {
    if ($('segment-start').value === '' || $('segment-end').value === '') throw new Error('起点和终点不能为空');
    const next = cleanSegment({ ...old, start_time: Number($('segment-start').value), end_time: Number($('segment-end').value) }, item());
    if (next.start_time !== old.start_time || next.end_time !== old.end_time) {
      record().segments[record().segments.indexOf(old)] = next;
      changed(); renderSegments(); renderDetail();
      if (loaded) currentMedia.currentTime = next.start_time;
    }
    $('time-edit-hint').textContent = '选中时间窗的起止时间已保存。新建将使用当前区间创建独立的空白时间窗。';
    enqueueDraft();
  } catch (error) {
    $('time-edit-hint').textContent = `时间未保存：${error.message}`;
    notify(error.message, true);
  }
}
function releaseMedia() {
  cancelFrameEdit();
  loaded = false;
  for (const m of [$('video'), $('audio')]) { m.pause(); m.removeAttribute('src'); m.load(); }
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = null; currentMedia = null;
  $('seek').disabled = true;
  $('current-time').textContent = displayTime(0); $('seek').value = 0; $('play-toggle').textContent = '▶';
}
function loadMedia() {
  releaseMedia();
  const task = item(); const file = attached.get(task.id);
  $('video').hidden = true; $('audio-stage').hidden = true; $('media-empty').hidden = false;
  $('missing-path').textContent = task.media_path;
  $('media-name').textContent = file?.name || '未关联本地文件'; $('media-duration').textContent = '—';
  if (!file) return;
  mediaURL = URL.createObjectURL(file); currentMedia = task.media_type === 'video' ? $('video') : $('audio');
  currentMedia.src = mediaURL; currentMedia.playbackRate = Number($('playback-rate').value);
  $('media-empty').hidden = true; $('video').hidden = task.media_type !== 'video'; $('audio-stage').hidden = task.media_type !== 'audio';
}
function renderWorkspace() {
  $('welcome').hidden = true; $('workspace').hidden = false;
  for (const [id, key] of [['batch-id', 'batch_id'], ['assignment-id', 'assignment_id'], ['annotator-id', 'annotator_id']]) $(id).value = ws.manifest[key];
  renderCurrent();
}
function renderCurrent() {
  selected = null; activeLabel = 'unclassified';
  $('item-title').textContent = item().title;
  $('task-description').textContent = item().text; $('task-description').hidden = !item().text;
  $('segment-start').value = ''; $('segment-end').value = '';
  $('item-position').textContent = `${String(ws.index + 1).padStart(2, '0')} / ${String(ws.manifest.items.length).padStart(2, '0')}`;
  $('previous-item').disabled = ws.index === 0; $('next-item').disabled = ws.index === ws.manifest.items.length - 1;
  renderProgress(); renderLabels(); renderSegments(); renderDetail(); loadMedia();
}
async function switchItem(index) {
  if (!ws || index < 0 || index >= ws.manifest.items.length) return;
  await enqueueDraft(); ws.index = index; renderCurrent(); await enqueueDraft();
}
async function activate(next, message) {
  await enqueueDraft(); ws = next; attached = new Map(); selected = null;
  renderWorkspace(); await enqueueDraft(); if (message) notify(message);
}
async function readJSON(file) {
  if (!file) return null;
  if (file.size > MAX_JSON_BYTES) throw new Error('JSON 文件超过 20MB，请拆分批次');
  return file.text();
}
async function importManifest(file) {
  if (!file) return;
  const next = newWorkspace(parseManifest(await readJSON(file)));
  await activate(next, '任务清单已导入，请选择对应的本地素材文件或文件夹');
}
async function importResults(file) {
  if (!file) return;
  const next = parseResults(await readJSON(file));
  await activate(next, '结果已恢复。片段和详情已保留，请重新选择本地素材以继续播放');
}
async function attachFiles(list) {
  const files = Array.from(list).filter(f => MEDIA_RE.test(f.name));
  if (!files.length) throw new Error('未找到支持的音视频文件。建议使用 MP4、WebM、WAV 或 MP3');
  if (files.length > MAX_ITEMS) throw new Error('一次最多选择 5000 个素材，请拆分批次');
  if (!ws) { ws = newWorkspace(manifestFromFiles(files)); renderWorkspace(); }
  let matched = 0; const errors = []; const matchedIDs = new Set();
  const bindings = new Map(attached);
  for (const task of ws.manifest.items) {
    try {
      const file = matchFile(task, files);
      if (!file) continue;
      const old = ws.records[task.id].media;
      if (old && ws.records[task.id].segments.length && old.size && old.size !== file.size) {
        errors.push(`${task.id}：文件大小与已保存记录不一致，未关联`); continue;
      }
      bindings.set(task.id, file); matched++; matchedIDs.add(task.id);
    } catch (e) { errors.push(e.message); }
  }
  if (!matched) throw new Error(errors[0] || '所选素材不匹配当前任务。请用“导入素材”直接建立新的素材任务，或选择清单对应的文件');
  attached = bindings;
  if (!matchedIDs.has(item().id)) { ws.index = ws.manifest.items.findIndex(task => matchedIDs.has(task.id)); renderCurrent(); }
  else loadMedia();
  await enqueueDraft();
  if (errors.length) notify(`已关联 ${matched} 条任务。\n${errors.slice(0, 3).join('\n')}`, true);
  else notify(`已关联 ${matched} / ${ws.manifest.items.length} 条任务。素材仅在当前浏览器中读取`);
}
async function importMediaFiles(list) {
  const files = Array.from(list).filter(file => MEDIA_RE.test(file.name));
  if (!files.length) throw new Error('未找到支持的音视频文件。请选择 WAV、MP3、M4A、MP4 或 WebM 等素材');
  if (files.length > MAX_ITEMS) throw new Error('一次最多选择 5000 个素材，请拆分批次');
  const plan = planMediaImport(ws?.manifest, files);
  if (!ws) await activate(newWorkspace(parseManifest({ batch_id: 'local-batch', items: plan.added })));
  else if (plan.added.length) {
    ws.manifest.items.push(...plan.added);
    for (const task of plan.added) ws.records[task.id] = blankRecord(task);
    changed(false);
  }
  let reload = false; const errors = [];
  for (const { file, ids } of plan.bindings) for (const id of ids) {
    if (attached.has(id)) continue;
    const rec = ws.records[id];
    if (rec.media?.size && rec.segments.length && rec.media.size !== file.size) {
      errors.push(`${file.name}：文件大小与已有标注记录不一致，未重新关联`); continue;
    }
    attached.set(id, file);
    if (item().id === id) reload = true;
  }
  renderProgress();
  if (reload) loadMedia();
  await enqueueDraft();
  notify(`已新增 ${plan.added.length} 条素材，跳过 ${plan.skipped} 条已有素材。${errors.length ? '\n' + errors.join('\n') : ''}`, Boolean(errors.length));
}
async function deleteTask() {
  if (!ws || !item()) return;
  const workspace = ws, target = item();
  if (!window.confirm(`从任务清单移除「${target.title}」及其标注？本地原文件不会被删除。`)) return;
  $('delete-task').disabled = true;
  try {
    await enqueueDraft();
    if (ws !== workspace) return;
    if (ws.manifest.items.length === 1) {
      await removeWorkspace(ws);
      releaseMedia(); ws = null; selected = null; attached = new Map();
      $('workspace').hidden = true; $('welcome').hidden = false; $('task-search').value = '';
    } else {
      const currentID = item().id, index = ws.manifest.items.findIndex(task => task.id === target.id);
      if (index < 0) return;
      releaseMedia();
      ws.manifest.items.splice(index, 1); delete ws.records[target.id]; attached.delete(target.id);
      ws.index = currentID === target.id ? Math.min(index, ws.manifest.items.length - 1) : ws.manifest.items.findIndex(task => task.id === currentID);
      changed(false); renderCurrent(); await enqueueDraft();
    }
    notify('已从任务清单移除素材及其标注，本地原文件保留');
  } finally { $('delete-task').disabled = false; }
}
async function exportResults(forceDownload = false) {
  if (!ws || busy) return;
  const payload = makeExport(ws);
  const body = JSON.stringify(payload, null, 2) + '\n';
  const name = `${safeFilename(payload.batch_id)}_${safeFilename(payload.assignment_id)}_${safeFilename(payload.annotator_id)}_r${payload.revision}.json`;
  const exportID = ws.id; const revision = ws.revision;
  busy = true; $('export-result').disabled = true; $('download-result').disabled = true;
  try {
    if (window.showSaveFilePicker && !forceDownload && settings.export !== 'download') {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '标注结果 JSON', accept: { 'application/json': ['.json'] } }] });
      const stream = await handle.createWritable(); await stream.write(body); await stream.close();
      notify(`已保存到本地：${handle.name}`);
    } else {
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json;charset=utf-8' }));
      const link = el('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notify(`已发起下载：${name}\n请确认文件下载完成后，再上传飞书。`);
    }
    if (ws?.id === exportID) { ws.exported_revision = revision; await enqueueDraft(); }
  } catch (e) {
    if (e.name === 'AbortError') notify('已取消导出，草稿仍保留在当前浏览器');
    else throw new Error(`导出未完成：${e.message}。可更换保存位置，或使用浏览器下载方式。`);
  } finally { busy = false; $('export-result').disabled = false; $('download-result').disabled = false; }
}
async function completeItem() {
  if (!attached.has(item().id) || !loaded) throw new Error('请先关联并确认这条任务的本地素材');
  const errors = completionErrors(item(), record());
  if (errors.length) throw new Error(errors.slice(0, 5).join('\n'));
  record().status = 'complete'; changed(false); renderProgress(); await enqueueDraft();
  if (ws.index < ws.manifest.items.length - 1) await switchItem(ws.index + 1);
  else notify('本次任务已标记完成。请导出本地结果文件，再提交到飞书');
}
async function showDrafts() {
  await enqueueDraft();
  const drafts = await listWorkspaces(); const frag = document.createDocumentFragment();
  if (!drafts.length) frag.append(el('p', '', '当前浏览器还没有保存的草稿。'));
  for (const draft of drafts) {
    const b = el('button', 'draft-row', `${draft.manifest.batch_id} · ${draft.manifest.annotator_id || '未填写标注员'} · ${draft.manifest.assignment_id || '未填写任务 ID'}`);
    b.append(el('small', '', `${draft.manifest.items.length} 条素材 · ${new Date(draft.updated_at).toLocaleString()} · 版本 ${draft.revision}`));
    b.addEventListener('click', run(async () => { $('draft-dialog').close(); await activate(validateDraft(draft), '已恢复草稿，请重新选择本地素材'); })); frag.append(b);
  }
  $('draft-list').replaceChildren(frag); $('draft-dialog').showModal();
}
for (const [mediaID, kind] of [['video', 'video'], ['audio', 'audio']]) {
  const media = $(mediaID);
  media.addEventListener('loadedmetadata', () => {
    if (currentMedia !== media || item()?.media_type !== kind) return;
    const file = attached.get(item().id);
    if (!file || !Number.isFinite(media.duration) || media.duration <= 0) return;
    if (item().duration_s !== null && Math.abs(item().duration_s - media.duration) > 0.5) {
      notify('文件时长与任务清单不一致，已暂停关联。请确认选择了正确素材', true); attached.delete(item().id); loadMedia(); return;
    }
    const metadata = { path: item().media_path, type: kind, name: file.name, size: file.size, last_modified: file.lastModified, duration_s: media.duration };
    const metadataChanged = item().duration_s !== media.duration || JSON.stringify(record().media) !== JSON.stringify(metadata);
    item().duration_s = media.duration;
    record().media = metadata;
    loaded = true; $('seek').max = media.duration; $('seek').disabled = false;
    $('media-duration').textContent = `${displayTime(media.duration)}${item().video_fps ? ` · ${item().video_fps} fps 参考` : ''}`;
    renderTimeline();
    if (metadataChanged) changed(false);
    enqueueDraft();
  });
  media.addEventListener('error', () => { if (currentMedia === media && media.hasAttribute('src')) notify('当前浏览器无法解码这份素材。请确认文件完整，或使用兼容的 MP4 / WebM / WAV / MP3 编码', true); });
  media.addEventListener('timeupdate', () => { if (currentMedia === media) { $('current-time').textContent = displayTime(media.currentTime); $('seek').value = media.currentTime; } });
  media.addEventListener('play', () => { if (currentMedia === media) $('play-toggle').textContent = 'Ⅱ'; });
  media.addEventListener('pause', () => { if (currentMedia === media) $('play-toggle').textContent = '▶'; });
}
async function togglePlay() {
  if (!loaded) return notify('请先选择本地素材', true);
  if (currentMedia.paused) await currentMedia.play(); else currentMedia.pause();
}
function step(direction) {
  if (!loaded) return;
  currentMedia.pause(); const delta = item().video_fps ? 1 / item().video_fps : Number(settings.step);
  currentMedia.currentTime = Math.max(0, Math.min(currentMedia.duration, currentMedia.currentTime + delta * direction));
}
for (const id of ['import-manifest', 'welcome-manifest']) $(id).addEventListener('click', () => $('manifest-input').click());
for (const id of ['import-result', 'welcome-result']) $(id).addEventListener('click', () => $('result-input').click());
for (const id of ['attach-media', 'welcome-media']) $(id).addEventListener('click', () => $('media-input').click());
const attachButton = el('button', 'quiet', '关联素材'); attachButton.id = 'attach-existing';
$('attach-media').after(attachButton);
for (const id of ['attach-current', 'attach-existing']) $(id).addEventListener('click', () => $('attach-input').click());
$('attach-folder').addEventListener('click', () => $('folder-input').click());
for (const [id, fn] of [['manifest-input', files => importManifest(files[0])], ['result-input', files => importResults(files[0])], ['media-input', importMediaFiles], ['attach-input', attachFiles], ['folder-input', attachFiles]]) {
  $(id).addEventListener('change', run(async e => { const files = Array.from(e.target.files); e.target.value = ''; if (files.length) await fn(files); }));
}
for (const [id, key] of [['batch-id', 'batch_id'], ['assignment-id', 'assignment_id'], ['annotator-id', 'annotator_id']]) {
  $(id).addEventListener('input', run(() => { if (ws) { ws.manifest[key] = identifier($(id).value, key); changed(false); } }));
}
for (const [id, key] of [['subject-id', 'subject_id'], ['local-fact', 'local_fact'], ['observation', 'observation'], ['evidence-role', 'evidence_role']]) {
  const update = () => { if (segment() && segment().annotations[key] !== $(id).value) { segment().annotations[key] = $(id).value; changed(); renderSegments(); } };
  $(id).addEventListener('input', update);
  $(id).addEventListener('change', () => { update(); enqueueDraft(); });
}
$('task-search').addEventListener('input', () => { if (ws) renderTaskList(); });
$('previous-item').addEventListener('click', run(() => switchItem(ws.index - 1)));
$('next-item').addEventListener('click', run(() => switchItem(ws.index + 1)));
$('complete-item').addEventListener('click', run(completeItem));
$('export-result').addEventListener('click', exportResultsHandler);
$('download-result').addEventListener('click', () => { exportResults(true).catch(e => notify(e.message, true)); });
function exportResultsHandler() { exportResults().catch(e => notify(e.message, true)); }
$('drafts-button').addEventListener('click', run(showDrafts));
$('delete-task').addEventListener('click', run(deleteTask));
for (const id of ['segment-start', 'segment-end']) $(id).addEventListener('change', updateSelectedTimes);
$('add-segment').addEventListener('click', run(addSegment));
$('delete-segment').addEventListener('click', () => {
  if (!segment()) return;
  if (!window.confirm('删除选中的时间窗及其标注内容？')) return;
  record().segments = record().segments.filter(s => s.id !== selected); selected = null; changed(); renderSegments(); renderDetail();
  enqueueDraft();
});
$('play-toggle').addEventListener('click', run(togglePlay));
$('step-back').addEventListener('click', () => step(-1)); $('step-forward').addEventListener('click', () => step(1));
$('seek').addEventListener('input', () => { if (loaded) currentMedia.currentTime = Number($('seek').value); });
$('playback-rate').addEventListener('change', () => { if (currentMedia) currentMedia.playbackRate = Number($('playback-rate').value); });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('segment-category').addEventListener('change', () => chooseLabel($('segment-category').value));
const draw = $('timeline-draw');
let drag = null;
function timeAt(x) {
  const rect = draw.getBoundingClientRect();
  return Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * currentMedia.duration;
}
draw.addEventListener('pointerdown', e => {
  if (!loaded || e.button !== 0) return;
  currentMedia.pause();
  drag = { pointer: e.pointerId, x: e.clientX, time: timeAt(e.clientX), task: item().id };
  draw.setPointerCapture(e.pointerId);
});
draw.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointer || !loaded) return;
  const a = Math.min(drag.time, timeAt(e.clientX)), b = Math.max(drag.time, timeAt(e.clientX));
  const preview = $('timeline-preview'); preview.hidden = false;
  preview.style.left = `${a / currentMedia.duration * 100}%`;
  preview.style.width = `${(b - a) / currentMedia.duration * 100}%`;
  $('timeline-selection').textContent = `${displayTime(a)} → ${displayTime(b)} · 松开创建时间框`;
});
function cancelDrag() {
  drag = null; $('timeline-preview').hidden = true;
  $('timeline-selection').textContent = '拖动创建时间框；选中列表中的框后修改类别。';
}
draw.addEventListener('pointerup', run(e => {
  if (!drag || e.pointerId !== drag.pointer) return;
  const start = drag; const end = loaded ? timeAt(e.clientX) : 0;
  cancelDrag();
  if (!loaded || item().id !== start.task) return;
  if (Math.abs(e.clientX - start.x) < 5) { currentMedia.currentTime = end; return; }
  const a = Math.round(Math.min(start.time, end) * 1000) / 1000;
  const b = Math.round(Math.max(start.time, end) * 1000) / 1000;
  if (b <= a) return;
  newSegment(); $('segment-start').value = a; $('segment-end').value = b;
  addSegment();
}));
draw.addEventListener('pointercancel', cancelDrag);
draw.addEventListener('lostpointercapture', () => { if (drag) cancelDrag(); });
const timeline = $('timeline');
timeline.addEventListener('pointerdown', e => {
  const target = e.target.closest('.timeline-segment');
  if (!target || e.button !== 0 || !loaded || frameEdit) return;
  e.preventDefault();
  const mode = e.target.closest('[data-edge]')?.dataset.edge || 'move';
  const id = target.dataset.segmentId;
  if (selected !== id) selectSegment(id);
  const node = [...timeline.querySelectorAll('.timeline-segment')].find(b => b.dataset.segmentId === id);
  const original = segment();
  if (!node || !original) return;
  currentMedia.pause(); node.focus({ preventScroll: true });
  frameEdit = { id, pointer: e.pointerId, x: e.clientX, mode, node,
    original: { start_time: original.start_time, end_time: original.end_time },
    preview: { start_time: original.start_time, end_time: original.end_time },
    width: node.parentElement.getBoundingClientRect().width, duration: item().duration_s,
    workspace: ws.id, task: item().id, moved: false, playhead: currentMedia.currentTime };
  timeline.setPointerCapture(e.pointerId);
});
function updateFrameEdit(e) {
  if (!frameEdit || frameEdit.pointer !== e.pointerId) return;
  const edit = frameEdit;
  if (!edit.moved && Math.abs(e.clientX - edit.x) < 3) return;
  edit.moved = true; edit.node.classList.add('dragging');
  previewFrameEdit(editInterval(edit.original, (e.clientX - edit.x) / edit.width * edit.duration, edit.mode, edit.duration));
}
timeline.addEventListener('pointermove', updateFrameEdit);
timeline.addEventListener('pointerup', e => {
  if (!frameEdit || frameEdit.pointer !== e.pointerId) return;
  updateFrameEdit(e);
  const edit = frameEdit; const nextTimes = edit.preview;
  cancelFrameEdit();
  if (ws?.id !== edit.workspace || item()?.id !== edit.task) return;
  if (!edit.moved) { if (loaded) currentMedia.currentTime = edit.mode === 'end' ? edit.original.end_time : edit.original.start_time; return; }
  const old = record().segments.find(s => s.id === edit.id);
  if (!old || (old.start_time === nextTimes.start_time && old.end_time === nextTimes.end_time)) return;
  try {
    const next = cleanSegment({ ...old, ...nextTimes }, item());
    record().segments[record().segments.indexOf(old)] = next;
    changed(); renderSegments(); renderDetail();
    $('segment-start').value = next.start_time.toFixed(3); $('segment-end').value = next.end_time.toFixed(3);
    currentMedia.currentTime = edit.mode === 'end' ? next.end_time : next.start_time;
  } catch (error) { notify(error.message, true); }
});
timeline.addEventListener('pointercancel', cancelFrameEdit);
timeline.addEventListener('lostpointercapture', cancelFrameEdit);
const setupButton = el('button', 'quiet', '设置');
setupButton.id = 'settings-button';
document.querySelector('.top-actions').prepend(setupButton);
function applySettings() {
  const stage = document.querySelector('.media-stage');
  stage.style.height = settings.height === 'auto' ? '' : `${settings.height}px`;
  $('video').style.objectFit = settings.fit;
  $('playback-rate').value = settings.speed;
  if (currentMedia) currentMedia.playbackRate = Number(settings.speed);
}
function fillSettings() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) $(`setting-${key}`).value = settings[key];
}
setupButton.addEventListener('click', () => {
  fillSettings();
  $('deployment-mode').textContent = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    ? `本机运行 · ${location.origin} · 素材与结果保留在本机`
    : '浏览器本地文件模式 · 素材与结果保留在当前设备';
  $('setup-input-summary').textContent = ws ? `当前任务 ${ws.manifest.items.length} 条，已关联本地素材 ${attached.size} 条。` : '尚未导入任务。也可以在首页直接选择音视频，自动建立任务。';
  $('settings-dialog').showModal();
});
for (const [button, input] of [['setup-manifest', 'manifest-input'], ['setup-folder', 'folder-input'], ['setup-result', 'result-input']]) {
  $(button).addEventListener('click', () => { $('settings-dialog').close(); $(input).click(); });
}
$('save-settings').addEventListener('click', () => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = $(`setting-${key}`).value;
  applySettings();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); notify('设置已保存并应用'); }
  catch { notify('设置已应用，但当前浏览器无法持久保存设置', true); }
  $('settings-dialog').close();
});
$('reset-settings').addEventListener('click', () => { for (const key of Object.keys(DEFAULT_SETTINGS)) $(`setting-${key}`).value = DEFAULT_SETTINGS[key]; });
applySettings();
document.querySelectorAll('.close-dialog').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d && e.offsetX >= 0 && e.offsetY >= 0) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }));
document.addEventListener('keydown', e => {
  if (frameEdit) { if (e.key === 'Escape') { e.preventDefault(); cancelFrameEdit(); } return; }
  if (!ws || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (e.key === '[') { e.preventDefault(); markStart(); }
  else if (e.key === ']') { e.preventDefault(); markEnd(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(addSegment)(); }
  else if (e.key === ' ') { e.preventDefault(); run(togglePlay)(); }
  else if (e.key === ',') { e.preventDefault(); step(-1); }
  else if (e.key === '.') { e.preventDefault(); step(1); }
  else { const label = LABELS.find(x => x.key === e.key); if (label) { e.preventDefault(); chooseLabel(label.id); } }
});
window.addEventListener('beforeunload', e => { if (ws && ws.revision !== ws.exported_revision && ws.revision > 0) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => { enqueueDraft(); });

function validateDraft(saved) {
  const identity = saved.manifest;
  const clean = parseResults(makeExport({ ...saved, manifest: { ...identity, batch_id: identity.batch_id || 'draft', assignment_id: identity.assignment_id || 'draft', annotator_id: identity.annotator_id || 'draft' } }));
  clean.id = identifier(saved.id, '草稿 ID');
  for (const key of ['batch_id', 'assignment_id', 'annotator_id']) clean.manifest[key] = identifier(identity[key], key);
  clean.index = Math.max(0, Math.min(saved.index || 0, clean.manifest.items.length - 1));
  clean.exported_revision = Number.isSafeInteger(saved.exported_revision) ? saved.exported_revision : -1;
  if (saved._storage_token) clean._storage_token = identifier(saved._storage_token, '草稿版本令牌');
  return clean;
}
async function boot() {
  try {
    const drafts = await listWorkspaces();
    if (drafts.length) {
      const saved = drafts[0];
      // Revalidate IndexedDB records through the same whitelist as imported JSON.
      const clean = validateDraft(saved);
      ws = clean; renderWorkspace();
      status('已恢复浏览器草稿 · 请重新选择素材'); notify('已恢复最近的草稿。请重新选择本地素材，或导入另一份任务清单');
    }
  } catch { notify('无法恢复浏览器草稿；可导入之前导出的本地 JSON 继续标注', true); }
}
boot();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
