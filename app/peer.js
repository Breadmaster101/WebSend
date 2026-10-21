// ---------- Peer connection ----------
import { ICE, CHUNK, BIG, LOW, LANES, PROTO } from './config.js';
import { why } from './util.js';
import { log, logCode, samplePairs, report, pairs } from './log.js';
import { encode, decode } from './code.js';
import { dc, setDc, on, send, sendIn } from './protocol.js';
import { lane, closeLanes } from './lanes.js';
import { startSas } from './sas.js';
import { out, dirty, queue, offer, onChunk } from './transfer.js';
import { view, reset } from './connect.js';
import { clearFiles } from './list.js';

export let pc, myCode, lastOffer, stall, route = '', chunk = CHUNK;
// connected: the main channel is open. checked: the user confirmed both screens show the same number.
// theyOk: the other device says its user confirmed too. Files and text only move once both have.
export let connected = false, checked = false, theyOk = false;
export const ready = () => connected && checked && theyOk;
let timer;

// A sender waiting on a full buffer parks its wake-up in ch.drain.
export function wire(ch) {
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW;
  ch.onbufferedamountlow = () => ch.drain?.();
  return ch;
}

function newPeer() {
  dropped();
  pc?.close();
  myCode = null;
  const p = pc = new RTCPeerConnection({ iceServers: ICE });
  const ch = setDc(wire(p.createDataChannel('websend', { negotiated: true, id: 0 })));
  ch.onopen = () => ch === dc && opened();
  ch.onclose = () => ch === dc && dropped();
  ch.onmessage = e => ch === dc && onMessage(e.data, ch);
  ch.onerror = e => ch === dc && log('Data channel error: ' + why(e.error), 'err');
  log('New connection attempt');
  pairs.clear();
  const poll = setInterval(() => p === pc && !connected ? samplePairs(p).catch(() => {}) : clearInterval(poll), 1000);
  p.onicecandidate = ({ candidate: c }) => c?.candidate && log('Found address: ' + (c.type ? `${c.type} ${c.protocol} ${c.address}:${c.port}` : c.candidate));
  p.onicecandidateerror = e => log(`STUN ${e.url} error ${e.errorCode} on ${e.address ?? '?'}: ${e.errorText} (harmless if a public address is found)`);
  p.onicegatheringstatechange = () => log('Address search: ' + p.iceGatheringState);
  // The joiner starts checking as soon as it has the invite, but nothing answers until the starter takes in the
  // reply, so browsers (Safari after ~15 s) may call the checks failed meanwhile. They start again once the reply
  // goes in, so that's expected, not an error. A real failure shows on the starter, or as the joiner's 2-minute timeout.
  const early = () => !connected && p.localDescription?.type === 'answer';
  p.oniceconnectionstatechange = () => {
    const s = p.iceConnectionState;
    log('Connectivity checks: ' + s, s === 'failed' ? (early() ? '' : 'err') : s === 'disconnected' ? 'warn' : '');
    if (p !== pc || !connected) return;
    // A connection that stops answering takes the browser about half a minute to call failed. Say so at once,
    // and count it as dropped if it hasn't come back within a few seconds.
    clearTimeout(stall);
    stall = s === 'disconnected' && setTimeout(() => p === pc && dropped(), 5000);
  };
  p.onconnectionstatechange = () => {
    if (p !== pc) return;
    const s = p.connectionState;
    log('Connection: ' + s, s === 'failed' && !early() ? 'err' : '');
    if (s !== 'failed') return;
    if (connected) dropped();
    else if (p.localDescription?.type === 'offer') fail('every address pair failed');
    else log('No answer from the other device yet, which is normal until it takes in your reply. Checks start again when it does.');
  };
}

// Non-trickle ICE: wait for all candidates so the code is complete.
export const gathered = p => new Promise(r => {
  const check = () => p.iceGatheringState === 'complete' && r();
  p.addEventListener('icegatheringstatechange', check);
  check();
  // Extra network adapters (VPNs, virtual machines) often never hear back from STUN. That only matters if no public address was found.
  setTimeout(() => {
    const pub = /typ srflx/.test(p.localDescription?.sdp);
    if (p === pc && p.iceGatheringState !== 'complete') log(`Address search still running after 3 s; using what it found so far${pub ? ', which includes a public address' : ''}.`, pub ? '' : 'warn');
    r();
  }, 3000);
}).then(() => encode(p.localDescription));

// Looks up this device's addresses as a code would list them, without connecting to anything, so the joining
// device can warn about its network before any code is swapped (the starting device's invite does this for it).
// Resolves to the code it would have sent, or nothing if the lookup failed.
export async function probe() {
  const p = new RTCPeerConnection({ iceServers: ICE });
  try {
    p.createDataChannel('probe');
    await p.setLocalDescription();
    const code = await gathered(p);
    logCode('This device', code);
    return code;
  } catch (e) { log('Network check failed: ' + why(e), 'warn'); } finally { p.close(); }
}

// Each returns the new code, or nothing if the user moved on (Back, or another code) meanwhile.
export async function makeOffer() {
  newPeer();
  const p = pc;
  await p.setLocalDescription();
  const code = await gathered(p);
  if (p !== pc) return;
  logCode('Your invite', code);
  return myCode = code;
}

export async function makeAnswer(offer) {
  newPeer();
  try { lastOffer = Sound.norm(offer); } catch { lastOffer = offer; }
  const p = pc;
  const desc = decode(offer);
  logCode('Their invite', offer);
  await p.setRemoteDescription(desc);
  await p.setLocalDescription();
  const code = await gathered(p);
  if (p !== pc) return;
  logCode('Your reply', code);
  clearTimeout(timer);
  timer = setTimeout(() => fail('not connected 2 minutes after making the reply. Did the first device take it in?'), 120000);
  return myCode = code;
}

export async function takeAnswer(code) {
  const desc = decode(code, pc.localDescription.sdp.match(/a=mid:(\S+)/)[1]);
  logCode('Their reply', code);
  await pc.setRemoteDescription(desc);
  clearTimeout(timer);
  timer = setTimeout(() => fail('not connected 20 s after taking their reply'), 20000);
}

// Drops any half-made connection.
export function abandon() {
  clearTimeout(timer);
  if (!connected) { pc?.close(); pc = myCode = null; setDc(null); }
}

function opened() {
  log('Connected: data channel open');
  connected = true;
  checked = theyOk = false;
  chunk = CHUNK;
  clearTimeout(timer);
  view('connected');
  startSas();
  showRoute(pc);
}

// The user confirmed the number. Tells the other device, with the largest message this one takes.
export function confirm() {
  checked = true;
  send({ t: 'ok', v: PROTO, max: +(pc.localDescription.sdp.match(/a=max-message-size:(\d+)/)?.[1] ?? 65536) }); // RFC 8841's default
  if (theyOk) bothChecked(); else view('connected');
}

// Both users confirmed the number, so unfinished transfers can carry on. Until then nothing is offered, so a
// device that took over the connection learns nothing about the files, even on a reconnect.
function bothChecked() {
  view('connected');
  const old = [...out.values()];
  sendIn({ t: 'cancel', up: true }, 'ids', old.filter(o => o.state === 'cancelled').map(o => o.id)); // in case it missed them
  offer(old.filter(o => !['done', 'declined', 'cancelled', 'missing'].includes(o.state)));
  if (pc.localDescription.type === 'offer') for (let i = 1; i < LANES; i++) lane(i);
}

// "direct" = device to device on the local network. "via router" = each side reached the other's public address,
// so traffic loops through the router's NAT, which is often much slower (usually mDNS or client isolation on the Wi-Fi).
async function showRoute(p) {
  const s = await p.getStats();
  let pair;
  s.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId); });
  s.forEach(r => { if (!pair && r.type === 'candidate-pair' && (r.selected || r.nominated && r.state === 'succeeded')) pair = r; });
  if (!pair || p !== pc) return;
  const types = [s.get(pair.localCandidateId), s.get(pair.remoteCandidateId)].map(c => c?.candidateType);
  route = types.some(t => t === 'srflx' || t === 'relay') ? ' · via router' : ' · direct';
  log(`Route: this device ${types[0]} → other device ${types[1]}`);
}

function dropped(msg = 'Disconnected. Connect again to carry on; unfinished transfers will resume.') {
  if (!connected) return;
  log(`Disconnected (connection ${pc?.connectionState})`, msg === 'Disconnected.' ? '' : 'warn');
  connected = false;
  clearTimeout(stall);
  stall = null;
  route = '';
  queue.length = 0;
  dc?.drain?.();
  closeLanes();
  for (const o of out.values()) if (o.state === 'sending' || o.state === 'offered') { o.state = 'queued'; dirty.add(o); }
  reset(msg);
}

async function fail(reason) {
  const p = pc;
  log("Couldn't connect: " + reason, 'err');
  if (p) await report(p);
  if (p === pc && !connected) reset("Couldn't connect. Put both devices on the same Wi-Fi and try again; some mobile, school and work networks block direct connections. The connection log below shows where it stopped.");
}

// Tells the other device first, so it drops at once instead of waiting for the connection to time out.
export function hangup(msg) { const p = pc; send({ t: 'bye' }); dropped(msg); p?.close(); clearFiles(); }

Object.assign(on, {
  // max: the largest message the other device takes (missing from older versions, which get 64 KB).
  ok({ max, v }) {
    if (theyOk) return;
    if (v !== PROTO) {
      log(`The other device speaks protocol ${v ?? 1}, this one ${PROTO}`, 'err');
      send({ t: 'bye' });
      return dropped('The other device is running a different version of WebSend. Reload the page on both devices, then connect again.');
    }
    theyOk = true;
    chunk = Math.max(CHUNK, Math.min(BIG, +max || 0, pc.sctp?.maxMessageSize || 0));
    if (checked) bothChecked();
  },
  bye() { dropped('The other device disconnected.'); },
});

// Until both users have confirmed the number, only the check itself (and hanging up) gets through.
const EARLY = ['commit', 'reveal', 'ok', 'bye'];
export function onMessage(d, ch) {
  if (typeof d !== 'string') return ready() && onChunk(d, ch);
  try {
    const m = JSON.parse(d);
    if (!Object.hasOwn(on, m.t)) return;
    if (ready() || EARLY.includes(m.t)) on[m.t](m, ch);
    else log(`Ignored a "${m.t}" message that came before the number was confirmed`, 'warn');
  } catch (e) { log(`Bad message from the other device: ${why(e)}`, 'err'); }
}
