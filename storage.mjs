const DB_NAME = 'bench-platform-local-v1:' + new URL('.', import.meta.url).pathname;
const WRITER = crypto.randomUUID();
let opened;
function database() {
  if (!opened) opened = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('workspaces', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opened = null; reject(req.error); };
  });
  return opened;
}
export async function storeWorkspace(workspace) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaces', 'readwrite');
    const store = tx.objectStore('workspaces');
    const token = crypto.randomUUID();
    let failure;
    const current = store.get(workspace.id);
    current.onsuccess = () => {
      const existing = current.result;
      if (existing && existing._writer !== WRITER && existing._storage_token !== workspace._storage_token) {
        failure = new Error('该任务已在另一个标签页更新。请先导出本页结果，再恢复最新草稿');
        tx.abort(); return;
      }
      store.put({ ...workspace, _writer: WRITER, _storage_token: token });
    };
    tx.oncomplete = () => resolve(token);
    tx.onerror = () => reject(failure || tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error('草稿写入中断'));
  });
}
export async function listWorkspaces() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('workspaces').objectStore('workspaces').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    req.onerror = () => reject(req.error);
  });
}
export async function removeWorkspace(workspace) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces');
    let failure;
    const current = store.get(workspace.id);
    current.onsuccess = () => {
      const existing = current.result;
      if (existing && existing._writer !== WRITER && existing._storage_token !== workspace._storage_token) {
        failure = new Error('该任务已在另一个标签页更新，无法删除旧草稿。请先恢复最新草稿'); tx.abort(); return;
      }
      store.delete(workspace.id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('草稿移除失败'));
  });
}
