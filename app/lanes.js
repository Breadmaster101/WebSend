// ---------- Lanes ----------
// A single connection backs off on every lost packet, so on Wi-Fi or across the internet it fills only part of the
// link; a few side by side fill much more of it (1.5–2x in tests with loss or delay). Once both users have checked
// the number, the starting device opens extra connections (lanes) as they prove useful (see grow()), swapping their
// codes over the checked channel. Each code carries its lane's key fingerprint, so a lane is as trustworthy as the
// channel it was agreed on. Files go out in segments that any free lane picks up; see pump() in transfer.js.
import { ICE, LANES, SEG } from './config.js';
import { why, fmt } from './util.js';
import { log } from './log.js';
import { decode } from './code.js';
import { on, send } from './protocol.js';
import { pc, connected, ready, wire, gathered, onMessage } from './peer.js';
import { out, inc, moved, offer, pump, unqueue } from './transfer.js';

export const lanes = new Map();
// theirs: the other device's code for this lane, when it opened it.
export async function lane(i, theirs) {
  const main = pc, p = new RTCPeerConnection({ iceServers: ICE }), ch = wire(p.createDataChannel('lane', { negotiated: true, id: 0 }));
  lanes.set(i, { p, ch });
  p.onconnectionstatechange = () => p.connectionState === 'failed' && log(`Lane ${i} failed; files go over the other connections`, 'warn');
  ch.onopen = () => { log(`Lane ${i} open`); pump(); };
  ch.onclose = () => lanes.get(i)?.ch === ch && lost(i, ch);
  ch.onmessage = e => lanes.get(i)?.ch === ch && onMessage(e.data, ch);
  try {
    if (theirs) await p.setRemoteDescription(decode(theirs));
    await p.setLocalDescription();
    const code = await gathered(p);
    if (main === pc && connected) send({ t: 'lane', i, c: code }); else p.close();
  } catch (e) { if (main === pc) log(`Lane ${i} failed: ${why(e)}`, 'warn'); }
}

// Whatever a lane that drops on its own had on the way may not have arrived. So files being sent are offered again,
// the receiver answers with how much it has, as after a reconnect, and the rest goes over the remaining channels.
function lost(i, ch) {
  log(`Lane ${i} closed`, 'warn');
  lanes.get(i).p.close();
  lanes.delete(i);
  ch.drain?.();
  if (!ready()) return;
  const again = [...out.values()].filter(o => o.state === 'sending');
  again.forEach(unqueue);
  offer(again);
}

// How many lanes. On a fast, clean link (most local networks) one connection keeps up, and each lane costs another
// round of STUN requests. So the starting device begins with none and, while files are moving, measures the speed,
// opens a lane, and measures again. It stops at LANES connections, or at the first lane that doesn't raise the speed
// by GAIN. The speed counts bytes both ways, so the same goes whichever device is sending.
const WARM = 1500, SPAN = 3000, GAIN = 1.15; // ms skipped after a change (connections speed up gradually), ms measured
let watch;
export function grow() {
  clearInterval(watch);
  let n = 1, base = 0, since = performance.now(), opening = 0, from, at; // n: connections, opening: when lane n - 1 was asked for
  const left = () => [...out.values(), ...inc.values()]
    .reduce((s, f) => s + ((f.state === 'sending' || f.state === 'receiving') && !f.held ? f.size - f.n : 0), 0);
  const done = msg => { log(msg); clearInterval(watch); };
  watch = setInterval(() => {
    const now = performance.now();
    if (opening) {
      if (lanes.get(n - 1)?.ch.readyState === 'open') { opening = 0; since = now; }
      else if (!lanes.has(n - 1) || now - opening > 15000) done(`Lane ${n - 1} didn't open, so no more lanes`);
      return;
    }
    // Too little left to keep every connection busy: the speed would say nothing about the link.
    if (left() < 2 * n * SEG) { since = now; from = undefined; return; }
    if (now - since < WARM) return;
    if (from === undefined) { from = moved; at = now; return; }
    if (now - at < SPAN) return;
    const rate = (moved - from) * 1000 / (now - at), was = base;
    from = undefined;
    if (was && rate < was * GAIN) return done(`Lane ${n - 1} didn't help (${fmt(was)}/s before, ${fmt(rate)}/s with it), so no more lanes`);
    base = rate;
    if (n >= LANES) return done(`${n} connections: ${fmt(rate)}/s, up from ${fmt(was)}/s with one fewer`);
    log(`${n} connection${n > 1 ? 's' : ''}: ${fmt(rate)}/s${was ? `, up from ${fmt(was)}/s` : ''}. Opening lane ${n} to see if it helps`);
    lane(n++);
    opening = now;
  }, 250);
}

export function closeLanes() {
  clearInterval(watch);
  for (const { p, ch } of lanes.values()) { p.close(); ch.drain?.(); }
  lanes.clear();
}

Object.assign(on, {
  async lane({ i, c }) {
    if (!Number.isInteger(i) || i < 1 || i >= LANES || typeof c !== 'string') return;
    if (c[0] === 'o') return void (lanes.has(i) || lane(i, c));
    const p = lanes.get(i)?.p;
    try { await p?.setRemoteDescription(decode(c, p.localDescription.sdp.match(/a=mid:(\S+)/)[1])); }
    catch (e) { log(`Lane ${i} failed: ${why(e)}`, 'warn'); }
  },
});
