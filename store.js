'use strict';
// Worker: keeps received files in the browser's private storage (OPFS) while they arrive, so big files never sit in
// memory. Each tab writes into its own folder under incoming/. Sync access handles write in place and each write is
// flushed, so what the page has been told is stored survives a reload or crash. Calls run one at a time, in order.
const open = new Map(); // 'dir/name' -> FileSystemSyncAccessHandle
let top;
const root = async () => top ||= await (await navigator.storage.getDirectory()).getDirectoryHandle('incoming', { create: true });
const folder = async (dir, create = false) => (await root()).getDirectoryHandle(dir, { create });

async function handle(dir, name) {
  let h = open.get(dir + '/' + name);
  if (!h) open.set(dir + '/' + name, h = await (await (await folder(dir, true)).getFileHandle(name, { create: true })).createSyncAccessHandle());
  return h;
}

// Closes the file's handle, or every handle in the folder when no name is given.
async function shut(dir, name) {
  for (const [k, h] of open) if (name ? k === dir + '/' + name : k.startsWith(dir + '/')) { open.delete(k); await h.close(); }
}

const ops = {
  async write({ dir, name, at, buf }) {
    const h = await handle(dir, name);
    await h.write(buf, { at });
    await h.flush();
  },
  // Returns the finished file, which the page can save or zip straight from disk.
  async close({ dir, name }) {
    await handle(dir, name); // an empty file was never written
    await shut(dir, name);
    return (await (await folder(dir)).getFileHandle(name)).getFile();
  },
  // Removes a file, or a whole folder when no name is given.
  async rm({ dir, name }) {
    await shut(dir, name);
    try { await (name ? (await folder(dir)).removeEntry(name) : (await root()).removeEntry(dir, { recursive: true })); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
  },
  // Lists the tab folders, or the files in one folder with their sizes.
  async ls({ dir }) {
    const list = {};
    for await (const [n, h] of (dir ? await folder(dir) : await root()).entries())
      if (dir) { if (h.kind === 'file') list[n] = (await h.getFile()).size; } else if (h.kind === 'directory') list[n] = true;
    return list;
  },
};

let q = Promise.resolve();
onmessage = ({ data: { n, op, ...a } }) => q = q.then(() => ops[op](a)).then(v => postMessage({ n, v }), e => postMessage({ n, e: `${e.name}: ${e.message}` }));
