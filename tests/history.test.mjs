import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceHistory } from '../core.mjs';

const workspace = () => ({ id: 'test', revision: 8, _storage_token: 'latest', index: 0,
  manifest: { items: [{ id: 'video', time_offset_s: 2 }] }, records: { video: { status: 'complete', segments: [{ id: 's', start_time: 1, end_time: 3 }] } },
  graph: { status: 'complete', facts: [{ id: 'f', review_status: 'confirmed' }], links: [] } });

test('undo restores the complete temporal transaction but retains monotonic revision and storage identity', () => {
  const ws = workspace(), history = createWorkspaceHistory(); history.reset(ws);
  const before = structuredClone(ws);
  ws.records.video.segments[0].start_time = 4; ws.records.video.status = 'draft';
  ws.graph.status = 'draft'; ws.graph.facts[0].review_status = 'needs_review';
  ws.graph.links.push({ id: 'edge', type: 'transitions_to' });
  assert.equal(history.record(ws), true); ws.revision = 9;
  assert.equal(history.undo(ws), true);
  assert.deepEqual(ws.records, before.records); assert.deepEqual(ws.graph, before.graph); assert.deepEqual(ws.manifest, before.manifest);
  assert.equal(ws.revision, 9); assert.equal(ws._storage_token, 'latest'); assert.equal(history.canUndo, false);
  assert.equal(history.record(ws), false, 'restoring a snapshot must not create another history step');
});

test('bounded multi-step history ignores no-op edits and cannot cross workspace boundaries', () => {
  const ws = workspace(), history = createWorkspaceHistory({ maxSteps: 2 }); history.reset(ws);
  assert.equal(history.record(ws), false);
  for (const start of [2, 3, 4]) { ws.records.video.segments[0].start_time = start; history.record(ws); }
  assert.equal(history.size, 2);
  history.undo(ws); assert.equal(ws.records.video.segments[0].start_time, 3);
  history.undo(ws); assert.equal(ws.records.video.segments[0].start_time, 2);
  assert.equal(history.undo(ws), false);
  ws.records.video.segments[0].start_time = 5; history.record(ws);
  const other = { ...workspace(), id: 'other' }; assert.equal(history.undo(other), false);
  history.reset(other); assert.equal(history.canUndo, false);
});

test('undo refuses an uncommitted concurrent mutation without discarding history', () => {
  const ws = workspace(), history = createWorkspaceHistory(); history.reset(ws);
  ws.graph.status = 'draft'; history.record(ws);
  ws.manifest.items[0].time_offset_s = 99;
  assert.throws(() => history.undo(ws), /修改中/);
  assert.equal(ws.manifest.items[0].time_offset_s, 99); assert.equal(history.size, 1);
  const limited = createWorkspaceHistory({ maxBytes: 1 }); limited.reset(ws);
  ws.graph.status = 'complete'; limited.record(ws); assert.equal(limited.canUndo, false);
});
