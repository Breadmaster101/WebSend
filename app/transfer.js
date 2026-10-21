// ---------- Transfers ----------
// Offering, accepting, pausing and cancelling files, and moving their bytes. Where received bytes end up is save.js.
import { SEG, HIGH } from './config.js';
import { b64, sha, why, rid } from './util.js';
import { log } from './log.js';
import { dc, on, send, sendIn } from './protocol.js';
import { chunk } from './peer.js';
import { lanes } from './lanes.js';
import { keep, finish, zipReady } from './save.js';
import { rpc } from './storage.js';
import { askAccept } from './list.js';

// Files going out and coming in by id, and those whose row needs repainting.
export const out = new Map(), inc = new Map(), dirty = new Set();
export const queue = []; // files being sent, in turn
export const unqueue = o => { const i = queue.indexOf(o); if (i >= 0) queue.splice(i, 1); };
export let moved = 0; // bytes sent and received so far, for the speed

export function offer(list) {
  list.forEach(o => { o.state = 'offered'; dirty.add(o); });
  sendIn({ t: 'offer', g: rid() }, 'files', list.map(({ id, path, size, held }) => ({ id, path, size, held: !!held })));
}

// Pause, resume or cancel a file from either end. The other device mirrors it; only the sender's pump acts on a pause.
// up: the file goes out from the device sending the message, so the one getting it looks it up among incoming files.
export const LIVE = ['queued', 'offered', 'sending', 'receiving'];
export function hold(it, on) {
  it.held = on;
  dirty.add(it);
  send({ t: 'hold', ids: [it.id], on, up: !!it.up });
  if (!on) pump();
}
export function cancel(it) {
  send({ t: 'cancel', ids: [it.id], up: !!it.up });
  stop(it);
}
function stop(it) {
  it.state = 'cancelled';
  dirty.add(it);
  if (it.up) return void unqueue(it);
  it.segs = null;
  if (it.chain) it.chain = it.chain.then(() => it.w.abort()).then(() => it.rm?.()).catch(() => {}); // drop the half-written file
  if (it.to === 'disk') rpc('rm', { dir: it.dir, name: it.name }).catch(() => {});
  zipReady(it.grp);
}

Object.assign(on, {
  offer({ g, files }) {
    const fresh = [], resume = [];
    for (const f of files) {
      const it = inc.get(f.id);
      if (!it) {
        if (!Number.isSafeInteger(f.size) || f.size < 0) continue;
        const n = { id: String(f.id), path: String(f.path), size: f.size, n: 0, state: 'pending', held: !!f.held };
        inc.set(n.id, n);
        fresh.push(n);
      } else if (it.state === 'receiving') {
        // A pause that either side made while the connection was down holds on both.
        if (f.held && !it.held) { it.held = true; dirty.add(it); }
        detach(it); // bytes still on the way from before belong to segments that will be sent again
        resume.push([it.id, kept(it), !!it.held]);
      } else if (it.state === 'done' || it.state === 'error') send({ t: 'got', id: it.id });
      else if (it.state === 'declined') send({ t: 'decline', ids: [it.id] });
      else if (it.state === 'cancelled') send({ t: 'cancel', ids: [it.id], up: false });
    }
    sendIn({ t: 'accept' }, 'files', resume);
    if (fresh.length) askAccept(String(g), fresh);
  },
  accept({ files }) {
    for (const [id, n, held] of files) {
      const o = out.get(id);
      if (o?.state !== 'offered') continue;
      o.n = o.next = Math.min(Math.max(+n || 0, 0), o.size); // sent so far, and where the next segment starts
      o.left = []; // segments to send again: cut short by a pause, or lost with their lane
      o.state = 'sending';
      if (held) o.held = true;
      queue.push(o);
      dirty.add(o);
    }
    pump();
  },
  decline({ ids }) { ids.forEach(id => { const o = out.get(id); if (o) { o.state = 'declined'; dirty.add(o); } }); },
  hold({ ids, on, up }) {
    for (const id of ids) {
      const it = (up ? inc : out).get(id);
      if (!it || !LIVE.includes(it.state) && it.state !== 'pending') continue;
      it.held = !!on;
      dirty.add(it);
    }
    if (!on) pump();
  },
  cancel({ ids, up }) {
    for (const id of ids) {
      const it = (up ? inc : out).get(id);
      if (it && (LIVE.includes(it.state) || it.state === 'pending')) stop(it);
    }
  },
  got({ id }) { const o = out.get(id); if (o) { o.n = o.size; o.state = 'done'; unqueue(o); dirty.add(o); } },
  // The bytes that follow on this channel belong to file id from offset at.
  seg({ id, at }, ch) {
    const it = inc.get(id);
    ch.cur = null;
    if (it?.state !== 'receiving' || !Number.isSafeInteger(at) || at < 0 || at >= it.size) return;
    const seg = { at, n: 0, parts: [] }, old = it.segs.get(at);
    if (old?.ok) return; // already stored
    if (old) it.n -= old.n;
    it.segs.set(at, seg);
    ch.cur = { it, seg };
  },
  // The end of the segment on this channel, with the SHA-256 of its bytes. A match gets them stored.
  async sum({ h }, ch) {
    const { it, seg } = ch.cur || {};
    ch.cur = null;
    if (it?.state !== 'receiving' || it.segs.get(seg.at) !== seg) return;
    if (!seg.n) return void it.segs.delete(seg.at);
    const bytes = await new Blob(seg.parts).arrayBuffer();
    seg.parts = null;
    if (seg.at + seg.n > it.size || b64(await sha(bytes)) !== h) return redo(it, seg);
    try { await keep(it, seg, bytes); } catch (e) { return fault(it, `Saving ${it.path} failed: ${why(e)}`); }
    if (it.state !== 'receiving' || it.segs.get(seg.at) !== seg) return; // cancelled, or dropped by a reconnect
    seg.ok = true;
    it.v += seg.n;
    dirty.add(it);
    if (it.v >= it.size) finish(it);
  },
  // The receiver wants part of a file again (it failed its check).
  again({ id, at, end }) {
    const o = out.get(id);
    if (o?.state !== 'sending' || !Number.isSafeInteger(at) || !Number.isSafeInteger(end) || at < 0 || end <= at || end > o.size) return;
    o.left.push({ o, at, end });
    o.n -= end - at;
    if (!queue.includes(o)) queue.push(o);
    pump();
  },
});

// Accepted files go out in segments of up to SEG bytes, each on whichever channel is free (the main one or a lane),
// so one big file uses every lane and small files go out side by side. Each segment starts with a 'seg' header on
// its channel and ends with a 'sum' carrying the SHA-256 of the bytes it sent, which the receiver checks before
// storing them. A paused file is skipped, and a pause or cancel takes effect at the next chunk.
const live = o => o.state === 'sending' && !o.held;
function take() {
  const o = queue.find(o => live(o) && (o.left.length || o.next < o.size));
  if (!o) return;
  if (o.left.length) return o.left.shift();
  const s = { o, at: o.next, end: Math.min(o.size, o.next + SEG) };
  o.next = s.end;
  return s;
}

const chans = () => [dc, ...[...lanes.values()].map(l => l.ch)].filter(ch => ch?.readyState === 'open');
export const pump = () => chans().forEach(run);
async function run(ch) {
  if (ch.busy) return;
  ch.busy = true;
  let s;
  try {
    while (ch.readyState === 'open' && (s = take())) {
      const { o } = s, from = s.at;
      ch.send(JSON.stringify({ t: 'seg', id: o.id, at: s.at }));
      const buf = await o.file.slice(s.at, s.end).arrayBuffer();
      for (let i = 0; i < buf.byteLength && live(o); i += chunk) {
        if (ch.bufferedAmount > HIGH) await new Promise(r => ch.drain = r);
        if (ch.readyState !== 'open') return;
        const part = new Uint8Array(buf, i, Math.min(chunk, buf.byteLength - i));
        ch.send(part);
        s.at += part.byteLength;
        o.n += part.byteLength;
        moved += part.byteLength;
      }
      dirty.add(o);
      const h = await sha(new Uint8Array(buf, 0, s.at - from));
      if (ch.readyState !== 'open') return;
      ch.send(JSON.stringify({ t: 'sum', h: b64(h) }));
      if (s.at < s.end && o.state === 'sending') o.left.push({ o, at: s.at, end: s.end }); // paused partway
      if (o.n >= o.size) unqueue(o);
    }
  } catch (e) {
    log(`Sending ${s?.o.path} failed: ${why(e)}`, 'err');
    if (ch.readyState === 'open' && s) { unqueue(s.o); s.o.state = 'error'; dirty.add(s.o); }
  } finally {
    ch.busy = false;
  }
}

// Segments can arrive in any order. Each holds its bytes until its checksum arrives (see on.sum), then they're
// stored where the file is going (see save.js).
export function onChunk(buf, ch) {
  const { it, seg } = ch.cur || {};
  if (it?.state !== 'receiving' || it.segs.get(seg.at) !== seg) return; // cancelled, or the segment was sent again
  if (seg.n + buf.byteLength > SEG) return; // more than a segment holds: its check fails and it's sent again
  seg.parts.push(buf);
  seg.n += buf.byteLength;
  it.n += buf.byteLength;
  moved += buf.byteLength;
  dirty.add(it);
}

// A segment that failed its check is asked for again, a few times at most.
function redo(it, seg) {
  it.segs.delete(seg.at);
  it.n -= seg.n;
  dirty.add(it);
  if (++it.bad > 3) return fault(it, `${it.path} kept arriving damaged`);
  log(`Part of ${it.path} arrived damaged; asking for it again`, 'warn');
  send({ t: 'again', id: it.id, at: seg.at, end: seg.at + seg.n });
}

export function fault(it, msg) {
  log(msg, 'err');
  cancel(it);
  it.state = 'error';
}

// How much of the file is checked and stored from the start with no gap.
export function prefix(it) {
  let n = 0;
  for (const s of [...it.segs.values()].sort((a, b) => a.at - b.at)) if (s.ok && s.at <= n) n = Math.max(n, s.at + s.n); else break;
  return n;
}
// After a reconnect, everything past that is dropped and sent again.
function kept(it) {
  const n = prefix(it);
  for (const s of it.segs.values()) if (!s.ok || s.at >= n) it.segs.delete(s.at);
  return it.n = it.v = n;
}
export const detach = it => chans().forEach(ch => { if (ch.cur?.it === it) ch.cur = null; });
