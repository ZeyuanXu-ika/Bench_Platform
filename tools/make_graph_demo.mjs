// Synthetic structure example; no real people, speech, or emotional judgments.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseManifest, newWorkspace, makeExport } from '../core.mjs';
import { evidenceKey } from '../graph.mjs';

const ws = newWorkspace(parseManifest({ schema_version: '2.0', batch_id: 'graph_demo', assignment_id: 'demo_A', annotator_id: 'demo', items: [
  { id: 'demo_video', title: '四层结构演示 · 合成视频', media_path: 'media/demo.mp4', media_type: 'video', duration_s: 12, source_id: 'demo_scene', timeline_id: 'demo_scene', time_offset_s: 0, video_fps: 25,
    text: '本示例只演示图谱结构。素材为合成测试信号，没有真实人物；以下情感状态为占位示例，不能作为真实情感数据。' },
  { id: 'demo_audio', title: '四层结构演示 · 合成音频', media_path: 'media/demo.wav', media_type: 'audio', duration_s: 12.032, source_id: 'demo_scene', timeline_id: 'demo_scene', time_offset_s: 0,
    text: '合成测试音，用于演示同一事实关联多模态证据。人物与情感信息均为结构占位。' },
] }));
const window = (id, start, end, label, observation) => ({ id, start_time: start, end_time: end, label,
  annotations: { subject_id: 'demo_subject', observation, local_fact: '', evidence_role: 'both', uncertainty: '' } });
ws.records.demo_video.segments = [window('v1', 1, 3, 'visual_observation', '第一段合成画面；结构演示'), window('v2', 6, 8, 'visual_observation', '第二段合成画面；结构演示')];
ws.records.demo_audio.segments = [window('a1', 1, 3, 'acoustic_observation', '合成测试音；结构演示')];
const v1 = evidenceKey('demo_video', 'v1'), v2 = evidenceKey('demo_video', 'v2'), a1 = evidenceKey('demo_audio', 'a1');
const review_status = 'needs_review';
ws.graph = { status: 'draft', entities: [{ id: 'demo_subject', name: '虚构演示主体（非真实人物）', aliases: [] }],
  mentions: [v1, v2, a1].map((id, index) => ({ id: `mention_${index}`, entity_id: 'demo_subject', evidence_id: id, description: '仅用于演示共指映射，不代表实际人物身份' })),
  facts: [{ id: 'fact_1', text: '演示事实 A：第一组测试信号出现。', subject_ids: ['demo_subject'], speaker_id: '', kind: 'observation', review_status },
    { id: 'fact_2', text: '演示事实 B：后续测试画面发生变化。', subject_ids: ['demo_subject'], speaker_id: '', kind: 'observation', review_status }],
  events: [{ id: 'event_1', title: '结构演示：测试信号出现并变化', subject_ids: ['demo_subject'], timeline_id: 'demo_scene', review_status }],
  emotion_states: [{ id: 'state_1', subject_id: 'demo_subject', label: '占位状态 A', timeline_id: 'demo_scene', start_time: 1, end_time: 3, intensity: null, review_status },
    { id: 'state_2', subject_id: 'demo_subject', label: '占位状态 B', timeline_id: 'demo_scene', start_time: 6, end_time: 8, intensity: null, review_status }],
  emotion_transitions: [{ id: 'transition_1', subject_id: 'demo_subject', from_state_id: 'state_1', to_state_id: 'state_2', note: '仅展示状态前后关系，不表示从合成素材推断出了真实情绪。', review_status }],
  links: [] };
const edge = (from_type, from_id, to_type, to_id, type) => ws.graph.links.push({ id: `link_${ws.graph.links.length + 1}`, from_type, from_id, to_type, to_id, type });
edge('evidence', v1, 'fact', 'fact_1', 'supports'); edge('evidence', a1, 'fact', 'fact_1', 'supports'); edge('evidence', v2, 'fact', 'fact_2', 'supports');
edge('fact', 'fact_1', 'event', 'event_1', 'constitutes'); edge('fact', 'fact_2', 'event', 'event_1', 'constitutes');
edge('fact', 'fact_1', 'emotion_state', 'state_1', 'grounds'); edge('fact', 'fact_2', 'emotion_state', 'state_2', 'grounds');
edge('event', 'event_1', 'emotion_transition', 'transition_1', 'associated_with');
const output = fileURLToPath(new URL('../samples/demo-graph.json', import.meta.url));
fs.writeFileSync(output, JSON.stringify(makeExport(ws), null, 2) + '\n');
console.log('Synthetic graph demo generated.');
