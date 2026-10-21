// ---------- Lanes ----------
// A single connection backs off on every lost packet, so on Wi-Fi or across the internet it fills only part of the
// link; a few side by side fill much more of it (1.5–2x in tests with loss or delay). Once both users have checked
// the number, the starting device opens extra connections (lanes), swapping their codes over the checked channel.
// Each code carries its lane's key fingerprint, so a lane is as trustworthy as the channel it was agreed on.
// Files go out in segments that any free lane picks up; see pump() in transfer.js.
import { ICE, LANES } from './config.js';
import { why } from './util.js';
import { log } from './log.js';
import { decode } from './code.js';
import { on, send } from './protocol.js';
import { pc, connected, ready, wire, gathered, onMessage } from './peer.js';
import { out, offer, pump, unqueue } from './transfer.js';

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

export function closeLanes() {
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
