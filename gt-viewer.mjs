const VERSION = 'trace-label/1.0';
const GROUPS = [
  ['subjects', '主体（P）', 'name'],
  ['evidence', '原始证据（W）', 'content'],
  ['facts', '原子事实（F）', 'text'],
  ['events', '复合事件（E）', 'description'],
  ['emotion_states', '情感状态（S）', 'label'],
  ['emotion_transitions', '情感转折（T）', 'from_state_id'],
  ['event_influences', '事件与情感关系', 'relation'],
  ['ambiguities', '待核对项', 'issue'],
];

export function readGT(raw) {
  if (raw?.schema_version !== VERSION) throw new Error('GT 查看器支持 trace-label/1.0');
  const video = raw.video;
  if (typeof video?.video_id !== 'string' || !video.video_id.trim()
      || !Number.isFinite(video.duration_s) || video.duration_s <= 0) {
    throw new Error('GT 缺少有效的素材编号或时长');
  }
  for (const [key, label] of GROUPS) {
    if (key === 'ambiguities' && !Object.hasOwn(raw, key)) continue;
    if (!Array.isArray(raw[key]) || raw[key].some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`GT 的${label}列表无效`);
    }
  }
  return raw;
}

function element(tag, content) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

export function installGTViewer(dialog, parseJSON, maxBytes) {
  const input = dialog.querySelector('#gt-file');
  const mediaInput = dialog.querySelector('#gt-media');
  const video = dialog.querySelector('video');
  const status = dialog.querySelector('#gt-status');
  const content = dialog.querySelector('#gt-content');
  const layer = dialog.querySelector('#gt-layer');
  let source, file, mediaURL, selectedWindow, request = 0;

  for (const [key, label] of GROUPS) layer.add(new Option(label, key));
  layer.value = 'evidence';

  function clearMedia() {
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
    if (mediaURL) URL.revokeObjectURL(mediaURL);
    mediaURL = undefined;
    mediaInput.value = '';
  }

  function render() {
    content.replaceChildren();
    if (!source) return;
    if (layer.value === 'video') {
      content.append(element('pre', JSON.stringify(source.video, null, 2)));
      return;
    }
    const group = GROUPS.find(([key]) => key === layer.value);
    const rows = source[group[0]] ?? [];
    if (!rows.length) content.append(element('p', '此层没有记录。'));
    for (const row of rows) {
      const details = element('details');
      const summary = [row.id, row.event_id, row[group[2]], row.to_state_id, row.target_id]
        .filter(value => typeof value === 'string' && value.length).join(' · ');
      details.append(element('summary', summary || '查看记录'));
      details.append(element('pre', JSON.stringify(row, null, 2)));
      const ranges = row.time_ranges ?? (row.time_range ? [row.time_range] : []);
      if (Array.isArray(ranges)) for (const range of ranges) {
        if (!Number.isFinite(range?.start_s) || !Number.isFinite(range?.end_s)
            || range.start_s < 0 || range.start_s >= range.end_s || range.end_s > source.video.duration_s + .05) continue;
        const seek = element('button', `跳至 ${range.start_s}–${range.end_s} 秒`);
        seek.type = 'button';
        seek.addEventListener('click', () => {
          if (!mediaURL) {
            status.textContent = '请先选择与 GT 对应的本地视频。';
            mediaInput.focus();
            return;
          }
          selectedWindow = range;
          video.currentTime = range.start_s;
          video.focus();
        });
        details.append(seek);
      }
      content.append(details);
    }
  }

  async function openFile(candidate) {
    const generation = ++request;
    try {
      if (candidate.size > maxBytes) throw new Error('GT JSON 超过 20MB');
      const raw = readGT(parseJSON(await candidate.text()));
      if (generation !== request) return;
      clearMedia();
      selectedWindow = undefined;
      source = raw;
      file = candidate;
      layer.value = 'evidence';
      for (const [key, label] of GROUPS) {
        layer.querySelector(`option[value="${key}"]`).textContent = `${label} · ${source[key]?.length ?? 0}`;
      }
      status.textContent = `${source.video.video_id} · ${source.video.duration_s} 秒`;
      mediaInput.disabled = false;
      dialog.querySelector('#gt-download').disabled = false;
      render();
    } catch (error) {
      if (generation === request) status.textContent = file
        ? `${error.message}。正在显示 ${file.name}。` : error.message;
    }
  }

  input.addEventListener('change', () => {
    if (input.files[0]) void openFile(input.files[0]);
    input.value = '';
  });
  mediaInput.addEventListener('change', () => {
    const selected = mediaInput.files[0];
    if (!selected || !source) return;
    if (selected.name.toLowerCase() !== source.video.video_id.toLowerCase()) {
      status.textContent = `请绑定与 GT 同名的视频 ${source.video.video_id}。`;
      mediaInput.value = '';
      return;
    }
    clearMedia();
    selectedWindow = undefined;
    mediaURL = URL.createObjectURL(selected);
    video.src = mediaURL;
    video.hidden = false;
    status.textContent = `${source.video.video_id} · ${source.video.duration_s} 秒 · 已关联本地视频`;
  });
  video.addEventListener('timeupdate', () => {
    if (selectedWindow && video.currentTime >= selectedWindow.end_s) {
      video.pause();
      selectedWindow = undefined;
    }
  });
  video.addEventListener('error', () => {
    if (mediaURL) status.textContent = '浏览器无法播放所选视频，请检查格式或文件完整性。';
  });
  layer.addEventListener('change', render);

  dialog.querySelector('#gt-download').addEventListener('click', () => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = element('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  dialog.addEventListener('close', () => video.pause());
  return {
    show() { dialog.showModal(); },
    showFile(candidate) { dialog.showModal(); return openFile(candidate); },
  };
}
