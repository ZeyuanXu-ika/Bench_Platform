import assert from 'node:assert/strict';
import fs from 'node:fs';

// Persistence fixtures are separate from actual user downloads, which now contain one item.
export async function saveItemDownloadAndProjectSnapshot(download, page, fixturePath) {
  const downloadPath = fixturePath.replace(/\.json$/, '.item.json');
  await download.saveAs(downloadPath);
  const item = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
  assert.equal(item.items.length, 1, 'each downloaded annotation JSON belongs to one material');
  assert.equal(item.source_item_id, item.items[0].id);
  await page.waitForFunction(() => !document.getElementById('export-result').disabled);
  const project = await page.evaluate(async () => {
    const { listWorkspaces } = await import('./storage.mjs');
    const { makeExport } = await import('./core.mjs');
    const identity = ['batch-id', 'assignment-id', 'annotator-id'].map(id => document.getElementById(id).value);
    const drafts = await listWorkspaces();
    const draft = drafts.find(ws => ws.manifest.batch_id === identity[0] && ws.manifest.assignment_id === identity[1] && ws.manifest.annotator_id === identity[2]);
    if (!draft) throw new Error('Expected saved local project fixture');
    return makeExport(draft);
  });
  fs.writeFileSync(fixturePath, JSON.stringify(project));
  return project;
}
