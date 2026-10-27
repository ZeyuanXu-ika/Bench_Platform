import test from 'node:test';
import assert from 'node:assert/strict';
import { graphViewLinks, projectGraphView, serializeFullGraphSVG } from '../graph-view.mjs';

function fixture(count = 201) {
  const evidence = Array.from({ length: count }, (_, n) => ({ type: 'evidence', entry: { id: `w${n}`, global_start_time: n, global_end_time: n + 1 } }));
  const facts = Array.from({ length: count }, (_, n) => ({ type: 'fact', entry: { id: `f${n}`, text: `Fact ${n}`, review_status: 'confirmed' } }));
  const events = [{ type: 'event', entry: { id: 'e1', review_status: 'confirmed' } }];
  const links = evidence.flatMap((node, n) => [
    { id: `supports_${n}`, from_type: 'evidence', from_id: node.entry.id, to_type: 'fact', to_id: facts[n].entry.id, type: 'supports' },
    { id: `constitutes_${n}`, from_type: 'fact', from_id: facts[n].entry.id, to_type: 'event', to_id: 'e1', type: 'constitutes' }
  ]);
  return { data: [['证据', evidence], ['事实', facts], ['事件', events], ['情感', []]], links };
}

test('graph pages reach the final records and keep small-layer context visible', () => {
  const { data, links } = fixture();
  const first = projectGraphView(data, links), last = projectGraphView(data, links, null, { page: 99 });
  assert.equal(first.pageCount, 5); assert.equal(first.data[0][1].length, 50);
  assert.equal(last.page, 4); assert.equal(last.data[1][1][0].entry.id, 'f200');
  assert.equal(last.data[2][1][0].entry.id, 'e1');
  assert.ok(last.links.some(edge => edge.from_id === 'f200' && edge.to_id === 'e1'));
  assert.equal(data[0][1].length, 201);
});

test('focusing a late node includes its actual ancestors and descendants instead of the first fifty', () => {
  const { data, links } = fixture();
  const focused = projectGraphView(data, links, { type: 'fact', id: 'f200' });
  assert.equal(focused.mode, 'focus'); assert.equal(focused.scopeTotal, 3);
  assert.deepEqual(focused.data[0][1].map(node => node.entry.id), ['w200']);
  assert.deepEqual(focused.data[1][1].map(node => node.entry.id), ['f200']);
  assert.equal(focused.links.length, 2);
});

test('a high-fanout focus remains pinned on every page and does not erase its shared context', () => {
  const { data, links } = fixture();
  for (const page of [0, 1, 4]) {
    const view = projectGraphView(data, links, { type: 'event', id: 'e1' }, { page });
    assert.equal(view.data[2][1][0].entry.id, 'e1'); assert.ok(view.shown > 1);
  }
  assert.equal(projectGraphView(data, links, { type: 'fact', id: 'deleted' }).mode, 'all');
});

test('full SVG contains every record and edge, escapes text and declares its complete scope', () => {
  const { data, links } = fixture();
  const svg = serializeFullGraphSVG(data, links, { labelFor: (_type, id) => `<script>${id} & "text"</script>` });
  assert.ok(svg.includes('data-export-scope="full"'));
  assert.ok(svg.includes('data-node-id="f200"')); assert.ok(svg.includes('data-node-id="w200"'));
  assert.equal((svg.match(/data-node-id=/g) || []).length, 403);
  assert.equal((svg.match(/data-edge-id=/g) || []).length, 402);
  assert.ok(svg.includes('&lt;script&gt;')); assert.ok(!svg.includes('<script>'));
});

test('virtual emotion sequence links are included without changing stored graph relations', () => {
  const graph = { links: [], emotion_transitions: [{ id: 't', from_state_id: 's1', to_state_id: 's2' }] };
  const edges = graphViewLinks(graph);
  assert.equal(edges.length, 2); assert.equal(graph.links.length, 0);
  const svg = serializeFullGraphSVG([['证据', []], ['事实', []], ['事件', []], ['情感', []]], edges);
  assert.ok(svg.includes('height="260"')); assert.equal((svg.match(/data-edge-id=/g) || []).length, 0);
});
