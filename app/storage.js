// ---------- Storage ----------
// Received files are written to the browser's private storage as they arrive (store.js), not held in memory.
// Each tab writes into its own folder and holds a lock on it while it's open, and IndexedDB keeps a note of each
// unfinished transfer. Nothing runs while no WebSend tab is open, so disk use is kept short:
// - a cancelled, declined or failed file is removed at once, and Disconnect removes all of the tab's files;
// - closing or reloading the tab removes all of its files, so a download resumes after a reload only if the tab
//   crashed or the browser discarded it in the background. The browser may stop the removal partway, so the tab
//   also marks its folders closed in localStorage, which is written at once, and the next visit removes the rest;
// - every visit removes whatever no open tab is using, except unfinished downloads touched within KEEP, which it
//   takes over to resume;
// - nothing asks for persistent storage, so the browser may also clear it when the disk runs low.
// Files being sent are noted too (a few bytes, no disk), so after a reload they resume once they're added again.
import { KEEP } from './config.js';
import { rid, why } from './util.js';
import { log } from './log.js';
import { send } from './protocol.js';
import { out, inc, prefix } from './transfer.js';
import { group, addRow, askAccept } from './list.js';

export const TAB = rid(); // this tab: its folder in storage, and its name to other WebSend tabs
const db = self.indexedDB && navigator.locks ? idbKeyval.createStore('websend', 'transfers') : null;
export const owned = new Set([TAB]); // folders this tab holds
const CLOSED = 'websend-closed:'; // + a folder whose tab closed normally
let worker, calls = 0;
const waits = new Map();
// The page's CSP enforces Trusted Types, so script URLs need a policy. This one only ever gives out the worker's.
const STORE = self.trustedTypes ? trustedTypes.createPolicy('websend', { createScriptURL: () => 'store.js' }).createScriptURL('store.js') : 'store.js';
export function rpc(op, a, xfer = []) {
  if (!worker) {
    worker = new Worker(STORE);
    worker.onmessage = ({ data: { n, v, e } }) => { const [r, j] = waits.get(n); waits.delete(n); e ? j(new Error(e)) : r(v); };
  }
  return new Promise((r, j) => { waits.set(++calls, [r, j]); worker.postMessage({ n: calls, op, ...a }, xfer); });
}
// Holds the lock until the tab closes, if no other tab holds it. Resolves whether it got it.
const lock = name => new Promise(r => navigator.locks.request('websend:' + name, { ifAvailable: true }, l => { r(!!l); return l && new Promise(() => {}); }));
const key = it => `${it.dir}/${it.up ? 'o' : 'i'}/${it.id}`;

// What carries on after a reload or crash: files still to send (they have to be added again), and downloads part
// stored (after a crash only, since closing the tab removes them).
export function remember(it) {
  const live = it.up ? ['queued', 'offered', 'sending', 'missing'].includes(it.state) : it.state === 'receiving' && it.to === 'disk';
  if (!db || !live) return forget(it);
  it.rec = true;
  const { dir, id, path, size } = it;
  idbKeyval.set(key(it), it.up ? { dir, id, path, size, up: true, mod: it.mod, t: Date.now() }
    : { dir, id, path, size, name: it.name, auto: it.auto, k: prefix(it), t: Date.now() }, db).catch(() => {});
}
export function forget(it) {
  if (it.rec) idbKeyval.del(key(it), db).catch(() => {});
  it.rec = false;
}

// Takes over the folders and notes of tabs that have gone: downloads in one that crashed come back to resume, and
// the rest is removed. Sends come back from any (they store nothing). Resolves whether this browser can store files.
async function sweep() {
  if (!db) return false;
  await lock(TAB);
  const recs = await idbKeyval.values(db), dirs = await rpc('ls', {}).catch(() => null);
  const all = new Set([...recs.map(r => r.dir), ...Object.keys(dirs || {})]);
  for (const dir of all) {
    if (dir === TAB || !await lock(dir)) continue; // a tab that's still open uses it
    owned.add(dir);
    let closed = false;
    try { closed = localStorage.getItem(CLOSED + dir) !== null; localStorage.removeItem(CLOSED + dir); } catch {}
    try {
      const files = dirs?.[dir] ? await rpc('ls', { dir }) : {}, mine = recs.filter(r => r.dir === dir);
      const keep = mine.filter(r => Date.now() - r.t < KEEP && (r.up || !closed && files[r.name] >= r.k));
      mine.filter(r => !keep.includes(r)).forEach(r => idbKeyval.del(key(r), db));
      if (!keep.some(r => !r.up)) await rpc('rm', { dir });
      else for (const name in files) if (!keep.some(r => r.name === name)) await rpc('rm', { dir, name });
      restore(keep);
    } catch (e) { log(`Storage: couldn't tidy up ${dir}: ${why(e)}`, 'warn'); }
  }
  // Marks for folders the closing tab managed to remove itself.
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(CLOSED) && !all.has(k.slice(CLOSED.length))) localStorage.removeItem(k); } catch {}
  if (inc.size || out.size) log(`Storage: ${inc.size} download${inc.size === 1 ? '' : 's'} and ${out.size} send${out.size === 1 ? '' : 's'} to resume from before`);
  return !!dirs;
}

function restore(recs) {
  const ins = [], outs = [];
  for (const r of recs) {
    if (r.up ? out.has(r.id) : inc.has(r.id)) continue;
    if (r.up) outs.push({ ...r, n: 0, state: 'missing', rec: true });
    else ins.push({ ...r, n: r.k, v: r.k, state: 'receiving', to: 'disk', held: false, bad: 0, rec: true, segs: new Map(r.k ? [[0, { at: 0, n: r.k, ok: true }]] : []) });
  }
  if (outs.length) {
    const grp = group('↑ Unfinished: add these files again to carry on');
    outs.forEach(o => { out.set(o.id, o); addRow(grp, o); });
  }
  if (ins.length) {
    ins.forEach(it => inc.set(it.id, it));
    askAccept('before', ins, '↓ Unfinished: connect to the same device again to carry on');
  }
}
export const disk = sweep().catch(e => (log('Storage: ' + why(e), 'warn'), false));

// Closing or reloading the tab also removes every file it stored, unfinished ones too.
addEventListener('pagehide', e => {
  send({ t: 'bye' });
  if (e.persisted) return;
  inc.forEach(forget);
  owned.forEach(dir => {
    try { localStorage.setItem(CLOSED + dir, ''); } catch {}
    rpc('rm', { dir }).catch(() => {});
  });
});
