import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAnnotationId, annotationIdCounters } from '../graph.mjs';
import { newWorkspace, parseManifest, makeExport, parseResults } from '../core.mjs';
import { createAnnotationDraft } from '../annotation-timeline.mjs';

function workspace() { return newWorkspace(parseManifest({ batch_id: 'IDs', assignment_id: 'A', annotator_id: 'annotator', items: [{ id: 'video', media_path: 'video.mp4', duration_s: 30 }] })); }

test('annotation IDs use independent readable sequences and avoid all occupied graph identifiers', () => {
  const ws = workspace(), before = structuredClone(ws);
  assert.equal(nextAnnotationId(ws, 'entity'), 'P001'); assert.equal(nextAnnotationId(ws, 'entity'), 'P002');
  assert.equal(nextAnnotationId(ws, 'fact'), 'F001'); assert.equal(nextAnnotationId(ws, 'event'), 'E001');
  assert.equal(nextAnnotationId(ws, 'emotion_state'), 'S001'); assert.equal(nextAnnotationId(ws, 'link'), 'R001');
  assert.deepEqual(ws, before, 'allocating planned IDs must not mutate annotation data');
  ws.graph.facts.push({ id: 'P010' }); assert.equal(nextAnnotationId(ws, 'entity'), 'P011');
  assert.equal(nextAnnotationId(ws, 'mention', new Set(['M001'])), 'M002');
});

test('new temporal drafts use type-coded state, fact, event, evidence and relationship IDs', () => {
  const ws = workspace();
  assert.equal(createAnnotationDraft(ws, 'emotions', 'video', 1, 2).id, 'S001');
  assert.equal(createAnnotationDraft(ws, 'facts', 'video', 3, 4).id, 'F001');
  assert.equal(createAnnotationDraft(ws, 'events', 'video', 5, 6).id, 'E001');
  assert.deepEqual(ws.graph.facts.map(fact => fact.id), ['F001', 'F002']);
  assert.deepEqual(ws.records.video.segments.map(segment => segment.id), []);
  assert.ok(ws.graph.links.every(link => /^R\d{3,}$/.test(link.id)));
});

test('counters survive deletion and export/import so removed numbers are not reassigned', () => {
  const ws = workspace(); createAnnotationDraft(ws, 'emotions', 'video', 1, 2); createAnnotationDraft(ws, 'emotions', 'video', 3, 4);
  ws.graph.emotion_states.pop();
  const payload = makeExport(ws); assert.equal(payload.id_counters.S, 2);
  const reopened = parseResults(payload); assert.equal(nextAnnotationId(reopened, 'emotion_state'), 'S003');
  assert.equal(annotationIdCounters(reopened).S, 3);
  const bad = structuredClone(payload); bad.id_counters.S = -1; assert.throws(() => parseResults(bad), /计数无效/);
});
