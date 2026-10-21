// ---------- Saving ----------
// Checked segments are stored where the file is going: it.to is 'disk' (browser storage, see storage.js),
// 'folder' (one the user picked) or 'mem' (memory, when the browser has no storage for files).
import { SEG } from './config.js';
import { el, rid, why } from './util.js';
import { log } from './log.js';
import { send } from './protocol.js';
import { dirty, detach, fault } from './transfer.js';
import { rpc, disk, TAB } from './storage.js';

export function keep(it, seg, bytes) {
  if (it.to === 'disk') return rpc('write', { dir: it.dir, name: it.name, at: seg.at, buf: bytes }, [bytes]);
  if (it.to === 'folder') return write(it, w => w.write({ type: 'write', position: seg.at, data: bytes }));
  seg.parts = [new Blob([bytes])]; // so the browser can page it out of memory
}

export async function finish(it) {
  detach(it);
  try {
    if (it.to === 'folder') await write(it).then(() => it.w.close());
    else it.blob = it.to === 'disk' ? await rpc('close', { dir: it.dir, name: it.name })
      : new Blob([...it.segs.values()].sort((a, b) => a.at - b.at).flatMap(s => s.parts));
  } catch (e) { return fault(it, `Saving ${it.path} failed: ${why(e)}`); }
  if (it.state !== 'receiving') return; // cancelled meanwhile
  send({ t: 'got', id: it.id });
  it.segs = null;
  it.state = 'done';
  dirty.add(it);
  if (it.blob) {
    it.a = el('a', { href: URL.createObjectURL(it.blob), download: it.path.replace(/[/\\]/g, '_'), textContent: 'Save', onclick: savedOnce });
    it.note.after(' ', it.a);
    if (it.auto) it.a.click();
  }
  zipReady(it.grp);
}

// Save links fire for automatic downloads too, so after the first one they offer to save again.
function savedOnce() { if (!this.textContent.endsWith(' again')) this.textContent += ' again'; }

export async function saveEach(items) {
  for (const it of items) {
    it.a.click();
    await new Promise(r => setTimeout(r, 250)); // browsers drop downloads fired in the same instant
  }
}

// Zips the files picked for it once none of them are still arriving.
export function zipReady(grp) {
  const set = grp.zipSet;
  if (!set || set.some(it => it.state === 'receiving')) return;
  grp.zipSet = null;
  saveZip(grp, set.filter(it => it.blob));
}

async function saveZip(grp, got) {
  if (!got.length) return;
  // Name the archive after the folder when everything was sent from one.
  const tops = new Set(got.map(it => it.path.split(/[/\\]/)[0]));
  const name = tops.size === 1 && /[/\\]/.test(got[0].path) ? [...tops][0] : 'websend';
  const files = got.map(it => ({ name: it.path.split(/[/\\]/).filter(s => s && s !== '.' && s !== '..').join('/') || 'file', input: it.blob }));
  // The archive stays as a link too: browsers may block a download the page starts by itself.
  const show = x => { if (grp.zipOut?.href) URL.revokeObjectURL(grp.zipOut.href); grp.zipOut ? grp.zipOut.replaceWith(x) : grp.btns.append(' ', x); grp.zipOut = x; };
  show(el('small', { textContent: 'Zipping…' }));
  if (grp.zipDisk) rpc('rm', grp.zipDisk).catch(() => {}); // the archive from last time
  try {
    const zip = downloadZip(files);
    const blob = await disk ? await spool(zip.body, grp.zipDisk = { dir: TAB, name: 'zip-' + rid() }) : await zip.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: name + '.zip', textContent: `Save ${name}.zip`, onclick: savedOnce });
    show(a);
    a.click();
  } catch (e) { show(el('small', { textContent: 'Zip failed: ' + e.message })); log('Zip failed: ' + why(e), 'err'); }
}

// Writes a stream into browser storage a segment at a time, and returns it as a file.
async function spool(stream, to) {
  const r = stream.getReader();
  let pos = 0, parts = [], n = 0;
  const put = async () => {
    const buf = await new Blob(parts).arrayBuffer();
    await rpc('write', { ...to, at: pos, buf }, [buf]);
    pos += n; parts = []; n = 0;
  };
  for (let c; !(c = await r.read()).done;) { parts.push(c.value); if ((n += c.value.byteLength) >= SEG) await put(); }
  if (n) await put();
  return rpc('close', to);
}

async function openWriter(it) {
  const segs = it.path.split(/[/\\]/).filter(s => s && s !== '.' && s !== '..');
  const name = segs.pop() || 'file';
  let dir = it.folder;
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
  const fresh = await dir.getFileHandle(name).then(() => false, () => true);
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  // A cancel removes the file only if this made it. Aborting leaves a file that was already there as it was.
  if (fresh) it.rm = () => dir.removeEntry(name);
  return w;
}

// Writes into a picked folder go one after another, once the file is open. Segments land at their own offsets.
function write(it, step) {
  it.chain ||= openWriter(it).then(w => it.w = w);
  if (step) it.chain = it.chain.then(() => step(it.w));
  return it.chain;
}
