// ---------- Number check ----------
// Both screens show the same number only if each device holds the key the other expected. A match rules out
// anyone who swapped in their own code (answered a sound code first, or tampered with a message).
// The keys alone aren't enough: whoever sends a code last could try key after key offline until both numbers came
// out equal. So each device also mixes in a random value, and sends its hash (a commitment) before either value
// is revealed. Neither side can then pick its value after seeing the other's, leaving a forger a 1 in a million guess.
import { $, b64, unb64, sha } from './util.js';
import { log } from './log.js';
import { on, send } from './protocol.js';
import { pc, hangup } from './peer.js';

let sas = null;

export function startSas() {
  const mine = crypto.getRandomValues(new Uint8Array(32));
  sas = { mine, sent: sha(mine).then(h => send({ t: 'commit', h: b64(h) })) };
  $('sasNum').textContent = '··· ···';
  $('sasYes').disabled = true;
}

async function showSas(p, s) {
  const fps = [p.localDescription, p.remoteDescription].map(d => d.sdp.match(/a=fingerprint:\S+ (\S+)/)[1].toUpperCase()).sort();
  const vals = [s.mine, s.theirs].map(b64).sort();
  const n = new DataView((await sha(new TextEncoder().encode([...fps, ...vals].join()))).buffer).getUint32(0) % 1e6;
  if (s !== sas) return;
  $('sasNum').textContent = String(n).padStart(6, '0').replace(/^.../, '$& ');
  $('sasYes').disabled = false;
}

Object.assign(on, {
  // Reveal only once the other side has committed, and only after this side's own commitment has gone out.
  async commit({ h }) {
    const s = sas;
    if (!s || s.theirH) return;
    s.theirH = String(h);
    await s.sent;
    if (s === sas) send({ t: 'reveal', v: b64(s.mine) });
  },
  async reveal({ v }) {
    const s = sas;
    if (!s?.theirH || s.theirs) return;
    try { s.theirs = unb64(String(v)); } catch { s.theirs = new Uint8Array(); }
    if (s.theirs.length === 32 && b64(await sha(s.theirs)) === s.theirH) return showSas(pc, s);
    if (s !== sas) return;
    log("The other device's check value didn't match what it committed to", 'err');
    hangup('Disconnected because the other device failed the security check, so it may not be yours. Connect again, ideally side by side.');
  },
});
