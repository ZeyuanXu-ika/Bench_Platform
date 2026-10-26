import { LABELS, MAX_JSON_BYTES, MAX_ITEMS, MAX_SEGMENTS, MEDIA_RE, blankRecord, cleanSegment, completionErrors,
  displayTime, identifier, makeExport, manifestFromFiles, matchFile, newWorkspace, parseManifest, parseResults, safeFilename } from './core.mjs';
import { listWorkspaces, storeWorkspace } from './storage.mjs';

const $ = id => document.getElementById(id);
let ws = null;
let selected = null;
let activeLabel = 'visual_observation';
let attached = new Map();
let mediaURL = null;
let currentMedia = null;
let loaded = false;
let toastTimer;
let draftTimer;
let saveQueue = Promise.resolve();
let busy = false;
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
function status(message, error = false) { $('draft-status').textContent = message; $('draft-status').classList.toggle('warning', error); }
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
  $('item-status').textContent = record().status === 'complete' ? '已完成' : '待标注';
  $('item-status').classList.toggle('complete', record().status === 'complete');
  renderTaskList();
}
function renderTaskList() {
  const query = $('task-search').value.toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  for (const [index, task] of ws.manifest.items.entries()) {
    if (query && !`${task.id} ${task.title}`.toLocaleLowerCase().includes(query)) continue;
    const rec = ws.records[task.id];
    const b = el('button', `task-item${index === ws.index ? ' active' : ''}${rec.status === 'complete' ? ' complete' : ''}`);
    b.type = 'button'; b.setAttribute('aria-current', index === ws.index ? 'true' : 'false');
    b.append(el('span', 'task-dot', rec.status === 'complete' ? '✓' : String(index + 1).padStart(2, '0')));
    const info = el('span'); info.append(el('span', 'task-name', task.title), el('span', 'task-meta', `${task.media_type === 'video' ? '视频' : '音频'} · ${task.id}`));
    b.append(info); b.addEventListener('click', run(() => switchItem(index))); fragment.append(b);
  }
  $('task-list').replaceChildren(fragment);
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
  const add = el('button', 'text-button', '新片段 ↗'); add.id = 'new-segment'; add.addEventListener('click', newSegment);
  fragment.append(add); $('labels').replaceChildren(fragment);
}
function chooseLabel(id) {
  if (!ws || !LABELS.some(x => x.id === id) || (item().media_type === 'audio' && id === 'visual_observation')) return;
  activeLabel = id;
  if (segment()) { segment().label = id; changed(); renderSegments(); renderDetail(); }
  renderLabels();
}
function renderTimeline() {
  const frag = document.createDocumentFragment();
  const duration = item()?.duration_s;
  if (duration) for (const seg of record().segments) {
    const b = el('button', 'timeline-segment' + (seg.id === selected ? ' active' : ''));
    b.style.left = `${Math.min(100, seg.start_time / duration * 100)}%`;
    b.style.width = `${Math.max(0.2, Math.min(100, (seg.end_time - seg.start_time) / duration * 100))}%`;
    b.style.backgroundColor = LABELS.find(x => x.id === seg.label).color;
    b.title = `${LABELS.find(x => x.id === seg.label).name} ${displayTime(seg.start_time)}–${displayTime(seg.end_time)}`;
    b.setAttribute('aria-label', b.title); b.addEventListener('click', () => selectSegment(seg.id)); frag.append(b);
  }
  $('timeline').replaceChildren(frag);
}
function renderSegments() {
  $('segment-count').textContent = record().segments.length;
  const fragment = document.createDocumentFragment();
  if (!record().segments.length) fragment.append(el('div', 'empty-segments', '还没有片段。标记起止位置，创建第一条证据。'));
  for (const seg of record().segments) {
    const label = LABELS.find(x => x.id === seg.label);
    const b = el('button', 'segment-row' + (selected === seg.id ? ' active' : '')); b.type = 'button'; b.dataset.segmentId = seg.id;
    const info = el('span'); const main = el('span', 'segment-main'); const dot = el('span', 'label-dot'); dot.style.backgroundColor = label.color;
    main.append(dot, el('span', '', label.name)); info.append(main);
    if (seg.annotations.observation) info.append(el('div', 'segment-note', seg.annotations.observation));
    b.append(info, el('span', 'segment-times', `${displayTime(seg.start_time)} → ${displayTime(seg.end_time)}`));
    b.addEventListener('click', () => selectSegment(seg.id)); fragment.append(b);
  }
  $('segment-list').replaceChildren(fragment); renderTimeline();
}
function renderDetail() {
  const seg = segment();
  $('segment-detail').hidden = !seg; $('detail-empty').hidden = Boolean(seg);
  $('add-segment').textContent = seg ? '更新片段区间' : '＋ 创建片段';
  if (!seg) return;
  $('detail-label').textContent = LABELS.find(x => x.id === seg.label).name;
  $('detail-time').textContent = `${displayTime(seg.start_time)} → ${displayTime(seg.end_time)}`;
  for (const [id, key] of [['subject-id', 'subject_id'], ['observation', 'observation'], ['evidence-role', 'evidence_role'], ['uncertainty', 'uncertainty']]) $(id).value = seg.annotations[key];
}
function selectSegment(id) {
  selected = id; const seg = segment(); if (!seg) return;
  activeLabel = seg.label; $('segment-start').value = seg.start_time.toFixed(3); $('segment-end').value = seg.end_time.toFixed(3);
  if (loaded) currentMedia.currentTime = seg.start_time;
  renderLabels(); renderSegments(); renderDetail();
}
function newSegment() {
  if (!ws) return;
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
  if (!selected && record().segments.length >= MAX_SEGMENTS) throw new Error('单条素材最多支持 1000 个片段，请拆分任务');
  const old = segment();
  const next = cleanSegment({ id: old?.id || crypto.randomUUID(), start_time: Number($('segment-start').value), end_time: Number($('segment-end').value),
    label: activeLabel, annotations: old?.annotations || {} }, item());
  if (old) record().segments[record().segments.indexOf(old)] = next;
  else record().segments.push(next);
  selected = next.id; changed(); renderSegments(); renderDetail();
  if (!old) $('subject-id').focus();
}
function releaseMedia() {
  loaded = false;
  for (const m of [$('video'), $('audio')]) { m.pause(); m.removeAttribute('src'); m.load(); }
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = null; currentMedia = null;
  $('waveform').hidden = true; $('waveform-button').disabled = true; $('seek').disabled = true;
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
  selected = null; activeLabel = item().media_type === 'video' ? 'visual_observation' : 'acoustic_observation';
  $('item-kind').textContent = item().media_type === 'video' ? 'VIDEO EVIDENCE' : 'AUDIO EVIDENCE';
  $('item-title').textContent = item().title; $('item-id').textContent = `${item().id} · 原片偏移 ${item().clip_start_s}s`;
  $('task-description').textContent = item().text; $('task-description').hidden = !item().text;
  $('fact-notes').value = record().local_fact_notes; $('task-notes').value = record().task_notes;
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
  let matched = 0; const errors = [];
  const bindings = new Map(attached);
  for (const task of ws.manifest.items) {
    try {
      const file = matchFile(task, files);
      if (!file) continue;
      const old = ws.records[task.id].media;
      if (old && ws.records[task.id].segments.length && old.size && old.size !== file.size) {
        errors.push(`${task.id}：文件大小与已保存记录不一致，未关联`); continue;
      }
      bindings.set(task.id, file); matched++;
    } catch (e) { errors.push(e.message); }
  }
  attached = bindings; loadMedia(); await enqueueDraft();
  if (errors.length) notify(`已关联 ${matched} 条任务。\n${errors.slice(0, 3).join('\n')}`, true);
  else notify(`已关联 ${matched} / ${ws.manifest.items.length} 条任务。素材仅在当前浏览器中读取`);
}
async function exportResults(forceDownload = false) {
  if (!ws || busy) return;
  const payload = makeExport(ws);
  const body = JSON.stringify(payload, null, 2) + '\n';
  const name = `${safeFilename(payload.batch_id)}_${safeFilename(payload.assignment_id)}_${safeFilename(payload.annotator_id)}_r${payload.revision}.json`;
  const exportID = ws.id; const revision = ws.revision;
  busy = true; $('export-result').disabled = true; $('download-result').disabled = true;
  try {
    if (window.showSaveFilePicker && !forceDownload) {
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
async function generateWaveform() {
  if (!loaded || !attached.has(item().id)) return;
  const file = attached.get(item().id);
  if (file.size > 40 * 1024 * 1024 || currentMedia.duration > 600) throw new Error('本地波形支持不超过 40MB、10 分钟的素材。较长素材请先切片；播放器和区间标注仍可使用');
  const taskID = item().id; const workspaceID = ws.id;
  const context = new AudioContext(); $('waveform-button').disabled = true;
  try {
    notify('正在本地生成波形，素材不会上传…');
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (item()?.id !== taskID || ws?.id !== workspaceID) return;
    const canvas = $('waveform'); canvas.hidden = false;
    const width = Math.max(320, Math.round(canvas.getBoundingClientRect().width)); canvas.width = width;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, 96); ctx.strokeStyle = '#648257'; ctx.lineWidth = 1;
    const samples = decoded.getChannelData(0); const stride = Math.max(1, Math.floor(samples.length / width));
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      let low = 0; let high = 0;
      for (let j = x * stride; j < Math.min(samples.length, (x + 1) * stride); j++) { low = Math.min(low, samples[j]); high = Math.max(high, samples[j]); }
      ctx.moveTo(x + .5, 48 + low * 44); ctx.lineTo(x + .5, 48 + high * 44);
    }
    ctx.stroke(); notify('波形已在本地生成，点击波形可以跳转播放位置');
  } catch (e) { throw new Error(`无法生成波形：${e.message}。仍可使用播放器和时间区间标注`); }
  finally { await context.close(); if (item()?.id === taskID && ws?.id === workspaceID) $('waveform-button').disabled = !loaded; }
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
    loaded = true; $('seek').max = media.duration; $('seek').disabled = false; $('waveform-button').disabled = false;
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
  currentMedia.pause(); const delta = item().video_fps ? 1 / item().video_fps : .1;
  currentMedia.currentTime = Math.max(0, Math.min(currentMedia.duration, currentMedia.currentTime + delta * direction));
}
for (const id of ['import-manifest', 'welcome-manifest']) $(id).addEventListener('click', () => $('manifest-input').click());
for (const id of ['import-result', 'welcome-result']) $(id).addEventListener('click', () => $('result-input').click());
for (const id of ['attach-media', 'attach-current', 'welcome-media']) $(id).addEventListener('click', () => $('media-input').click());
$('attach-folder').addEventListener('click', () => $('folder-input').click());
for (const [id, fn] of [['manifest-input', files => importManifest(files[0])], ['result-input', files => importResults(files[0])], ['media-input', attachFiles], ['folder-input', attachFiles]]) {
  $(id).addEventListener('change', run(async e => { const files = Array.from(e.target.files); e.target.value = ''; if (files.length) await fn(files); }));
}
for (const [id, key] of [['batch-id', 'batch_id'], ['assignment-id', 'assignment_id'], ['annotator-id', 'annotator_id']]) {
  $(id).addEventListener('input', run(() => { if (ws) { ws.manifest[key] = identifier($(id).value, key); changed(false); } }));
}
for (const [id, key] of [['subject-id', 'subject_id'], ['observation', 'observation'], ['evidence-role', 'evidence_role'], ['uncertainty', 'uncertainty']]) {
  const update = () => { if (segment() && segment().annotations[key] !== $(id).value) { segment().annotations[key] = $(id).value; changed(); renderSegments(); } };
  $(id).addEventListener('input', update);
  $(id).addEventListener('change', update);
}
for (const [id, key] of [['fact-notes', 'local_fact_notes'], ['task-notes', 'task_notes']]) $(id).addEventListener('input', () => { if (ws) { record()[key] = $(id).value; changed(); } });
$('task-search').addEventListener('input', () => { if (ws) renderTaskList(); });
$('previous-item').addEventListener('click', run(() => switchItem(ws.index - 1)));
$('next-item').addEventListener('click', run(() => switchItem(ws.index + 1)));
$('complete-item').addEventListener('click', run(completeItem));
$('export-result').addEventListener('click', exportResultsHandler);
$('download-result').addEventListener('click', () => { exportResults(true).catch(e => notify(e.message, true)); });
function exportResultsHandler() { exportResults().catch(e => notify(e.message, true)); }
$('drafts-button').addEventListener('click', run(showDrafts));
$('mark-start').addEventListener('click', markStart); $('mark-end').addEventListener('click', markEnd);
$('add-segment').addEventListener('click', run(addSegment));
$('delete-segment').addEventListener('click', () => {
  if (!segment()) return;
  if (!window.confirm('删除这个证据片段及其详情？')) return;
  record().segments = record().segments.filter(s => s.id !== selected); selected = null; changed(); renderSegments(); renderDetail();
});
$('play-toggle').addEventListener('click', run(togglePlay));
$('step-back').addEventListener('click', () => step(-1)); $('step-forward').addEventListener('click', () => step(1));
$('seek').addEventListener('input', () => { if (loaded) currentMedia.currentTime = Number($('seek').value); });
$('playback-rate').addEventListener('change', () => { if (currentMedia) currentMedia.playbackRate = Number($('playback-rate').value); });
$('waveform-button').addEventListener('click', run(generateWaveform));
$('waveform').addEventListener('click', e => { if (loaded) { const rect = e.target.getBoundingClientRect(); currentMedia.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * currentMedia.duration; } });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d && e.offsetX >= 0 && e.offsetY >= 0) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }));
document.addEventListener('keydown', e => {
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
