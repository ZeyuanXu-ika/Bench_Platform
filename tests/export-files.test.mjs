import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { newWorkspace, parseManifest, makeItemExport, makeItemExportFiles, packAnnotationFiles, parseResults } from '../core.mjs';
import { evidenceKey, graphIssues } from '../graph.mjs';

function workspace() {
  const ws = newWorkspace(parseManifest({ batch_id: 'split', assignment_id: 'A', annotator_id: 'annotator', items: [1, 2].map(n => ({ id: `video${n}`, title: `视频${n}`, media_path: `part${n}/片段.mp4`, media_type: 'video', duration_s: 10, timeline_id: `scene${n}` })) }));
  for (const n of [1, 2]) {
    const id = `video${n}`, p = `P00${n}`, f = `F00${n}`, e = `E00${n}`, s = `S00${n}`, w = `W00${n}`;
    ws.records[id].segments.push({ id: w, start_time: 1, end_time: 3, label: 'visual_observation', annotations: { subject_ids: [p], fact_id: f, local_fact: `事实${n}`, observation: `事实${n}`, evidence_role: 'both' } });
    ws.graph.entities.push({ id: p, name: `人物${n}`, aliases: [] });
    ws.graph.mentions.push({ id: `M00${n}`, entity_id: p, evidence_id: evidenceKey(id, w), description: '画面主体' });
    ws.graph.facts.push({ id: f, text: `事实${n}`, subject_ids: [p], kind: 'observation', speaker_id: '', review_status: 'needs_review' });
    ws.graph.events.push({ id: e, title: `事件${n}`, subject_ids: [p], timeline_id: `scene${n}`, review_status: 'needs_review' });
    ws.graph.emotion_states.push({ id: s, label: '平静', subject_id: p, timeline_id: `scene${n}`, start_time: 1, end_time: 3, intensity: null, review_status: 'needs_review' });
    for (const [k, from_type, from_id, to_type, to_id, type] of [
      [1, 'evidence', evidenceKey(id, w), 'fact', f, 'supports'], [2, 'fact', f, 'event', e, 'constitutes'],
      [3, 'fact', f, 'emotion_state', s, 'grounds'], [4, 'event', e, 'emotion_state', s, 'associated_with']]) ws.graph.links.push({ id: `R${n}${k}`, from_type, from_id, to_type, to_id, type });
  }
  ws.graph.status = 'complete'; return ws;
}

test('each material exports exactly one item and a self-contained graph with stable IDs', () => {
  const ws = workspace(), before = structuredClone(ws), files = makeItemExportFiles(ws);
  assert.equal(files.length, 2); assert.equal(new Set(files.map(file => file.name)).size, 2);
  for (const [n, file] of files.entries()) {
    const payload = file.payload, restored = parseResults(payload);
    assert.equal(payload.items.length, 1); assert.equal(payload.source_item_id, `video${n + 1}`);
    assert.deepEqual(payload.graph.facts.map(node => node.id), [`F00${n + 1}`]);
    assert.deepEqual(payload.graph.emotion_states.map(node => node.id), [`S00${n + 1}`]);
    assert.equal(payload.graph.status, 'complete'); assert.equal(graphIssues(restored).filter(issue => issue.severity === 'error').length, 0);
    assert.equal(payload.graph.mentions[0].evidence_id, evidenceKey(`video${n + 1}`, `W00${n + 1}`));
  }
  assert.deepEqual(ws, before); assert.throws(() => makeItemExport(ws, 'missing'), /有效素材/);
});

test('cross-material references are retained outside the local graph without dangling evidence links', () => {
  const ws = workspace(); ws.graph.status = 'draft';
  ws.graph.links.push({ id: 'cross-source', from_type: 'evidence', from_id: evidenceKey('video2', 'W002'), to_type: 'fact', to_id: 'F001', type: 'supports' });
  const payload = makeItemExport(ws, 'video1');
  assert.ok(payload.cross_material_references.links.some(link => link.id === 'cross-source'));
  assert.ok(!payload.graph.links.some(link => link.id === 'cross-source'));
  const restored = parseResults(payload); assert.deepEqual(restored.cross_material_references, payload.cross_material_references);
});

test('material ownership retains disconnected drafts in the corresponding JSON', () => {
  const ws = workspace(); ws.graph.status = 'draft';
  ws.graph.facts[0].item_id = 'video1'; ws.graph.events[0].item_id = 'video1'; ws.graph.emotion_states[0].item_id = 'video1';
  ws.graph.links = ws.graph.links.filter(link => link.id !== 'R11'); delete ws.records.video1.segments[0].annotations.fact_id;
  const payload = makeItemExport(ws, 'video1');
  assert.ok(payload.graph.facts.some(fact => fact.id === 'F001'));
  assert.equal(payload.graph.facts[0].item_id, 'video1');
  assert.equal(payload.graph.status, 'draft'); assert.doesNotThrow(() => parseResults(payload));
});

test('new cross-material links do not discard previously retained external references', () => {
  const ws = workspace(); ws.graph.status = 'draft';
  ws.cross_material_references = { links: [{ id: 'earlier-external', from_id: 'outside', to_id: 'F001' }], emotion_transitions: [] };
  ws.graph.links.push({ id: 'new-external', from_type: 'evidence', from_id: evidenceKey('video2', 'W002'), to_type: 'fact', to_id: 'F001', type: 'supports' });
  const payload = makeItemExport(ws, 'video1');
  assert.deepEqual(new Set(payload.cross_material_references.links.map(link => link.id)), new Set(['earlier-external', 'new-external']));
});

test('emotion change content references export locally and retain external references separately',()=>{
  const ws=workspace();ws.graph.status='draft';ws.graph.emotion_states.push({...ws.graph.emotion_states[0],id:'later',start_time:4,end_time:5});
  ws.graph.links.push({id:'change',from_type:'emotion_state',from_id:ws.graph.emotion_states[0].id,to_type:'emotion_state',to_id:'later',type:'transitions_to',content_refs:[{node_type:'fact',node_id:'F001',relation:'influences',note:'本片依据'},{node_type:'fact',node_id:'F002',relation:'insufficient_evidence',note:'另一素材'}]});
  const payload=makeItemExport(ws,'video1');assert.doesNotThrow(()=>parseResults(payload));assert.deepEqual(payload.graph.links.find(link=>link.id==='change').content_refs.map(ref=>ref.node_id),['F001']);assert.equal(payload.cross_material_references.links.find(link=>link.id==='change').content_refs.length,2);assert.equal(ws.graph.links.at(-1).content_refs.length,2);
});

test('the batch ZIP contains separate UTF-8 JSON files readable by an independent ZIP implementation', () => {
  const files = makeItemExportFiles(workspace()), bytes = packAnnotationFiles(files);
  const output = execFileSync('python', ['-c', 'import io,sys,zipfile,json;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None;print(json.dumps({n:json.loads(z.read(n)) for n in z.namelist()}))'], { input: bytes, encoding: 'utf8' });
  const contents = JSON.parse(output); assert.deepEqual(Object.keys(contents), files.map(file => file.name));
  assert.ok(Object.values(contents).every(payload => payload.items.length === 1));
});
