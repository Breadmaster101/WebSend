'use strict';
// WebSend: serverless peer-to-peer file transfer over WebRTC.
// There is no signaling server. The two browsers swap a short code by hand (QR, link or paste).
// A code holds only what WebRTC needs: ICE credentials, the DTLS certificate fingerprint
// (which authenticates the encrypted channel) and network addresses.

// Finds public addresses across networks; [] = same-LAN only, no third party at all. Two servers let the log spot
// networks that give each destination a different public port (symmetric NAT), which blocks direct connections.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const CHUNK = 64 << 10, BIG = 256 << 10;                // send 64 KB messages, or 256 KB once the other device says it takes them
const READ = 1 << 20, SEG = 4 << 20;                    // read files 1 MB at a time, hand them to lanes 4 MB at a time
const HIGH = 8 << 20, LOW = 1 << 20;                    // send-buffer backpressure
const LANES = 3;                                        // connections files travel over (see Lanes)
const BATCH = 200;                                      // files per control message (keeps messages small)

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmt = b => { let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]; };
const rid = () => Math.random().toString(36).slice(2);

const out = new Map(), inc = new Map(), groups = new Map(), dirty = new Set();
let pc, dc, myCode, lastOffer, timer, stall, wake, screen, connected = false, queue = [], chunk = CHUNK, moved = 0, route = '';
// role: 'starting' | 'joining'. replying: the joiner has taken in the invite. toReply: the starter moved on to getting
// the reply. sendM / getM: how this device gives its code and takes in the other's ('qr' | 'link' | 'sound').
// chirping: the user tapped Play sound. checked: the user confirmed both screens show the same number.
// theyOk: the other device says its user confirmed too. Files and text only move once both have.
let role = null, replying = false, toReply = false, sendM = null, getM = null, chirping = false, checked = false, theyOk = false;
const ready = () => connected && checked && theyOk;

// ---------- Connection log ----------
// Shown on the page (not just the console) so a failed connection can be diagnosed and the log copied from any device.
// level: '' | 'warn' | 'err'. Errors open the log.
const T0 = performance.now(), tally = { warn: 0, err: 0 };
function log(msg, level = '') {
  $('diagLog').append(el('li', { className: level, textContent: `+${((performance.now() - T0) / 1000).toFixed(1)}s ${level ? level.toUpperCase() + ' ' : ''}${msg}` }));
  if (!level) return;
  tally[level]++;
  $('diagCount').textContent = `(${[tally.err && tally.err + ' error' + (tally.err > 1 ? 's' : ''), tally.warn && tally.warn + ' warning' + (tally.warn > 1 ? 's' : '')].filter(Boolean).join(', ')})`;
  if (level === 'err') $('diag').open = true;
}
const why = e => e instanceof Error || e instanceof DOMException ? `${e.name}: ${e.message}` : String(e);
addEventListener('error', e => log('Script error: ' + e.message, 'err'));
addEventListener('unhandledrejection', e => log('Unhandled error: ' + why(e.reason), 'err'));
$('diagCopy').onclick = async e => {
  const text = [...$('diagLog').children].map(li => li.textContent).join('\n');
  try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch (err) { log("Couldn't copy the log: " + why(err), 'warn'); }
  setTimeout(() => e.target.textContent = 'Copy log', 1500);
};
log(`Opened ${new Date().toISOString()} in ${navigator.userAgent}`);
log('STUN servers: ' + (ICE.flatMap(s => s.urls).join(', ') || 'none'));

// Lists the addresses in a code and flags what usually stops two networks connecting.
function logCode(label, code) {
  const addrs = code.slice(1).split(',').slice(3).map(c => ({ pub: c[0] === 's', ip: c.slice(1, c.lastIndexOf('_')), port: c.slice(c.lastIndexOf('_') + 1) }));
  log(`${label}: ${addrs.length} address${addrs.length === 1 ? '' : 'es'}` + addrs.map(a => `\n    ${a.pub ? 'public' : 'local '} ${a.ip}:${a.port}`).join(''));
  if (!addrs.length) return log(`${label} has no addresses, so nothing can connect to it.`, 'err');
  if (!addrs.some(a => a.pub) && pc?.iceConnectionState !== 'connected') log(`${label} has no public address (no STUN reply, so the network may block UDP; or the devices found each other first), so only a device on the same network can reach it.`, 'warn');
  const ports = new Map();
  for (const a of addrs) if (a.pub) ports.set(a.ip, (ports.get(a.ip) || new Set()).add(a.port));
  if ([...ports.values()].some(s => s.size > 1)) log(`${label}'s network gave a different public port to each STUN server (symmetric NAT, or several network adapters). Devices on other networks usually can't reach it without a relay.`, 'warn');
  // Cloudflare WARP's egress ranges. Its NAT drops peer-to-peer UDP from outside, so only same-network connections work.
  const warp = addrs.find(a => a.pub && (/^104\.28\./.test(a.ip) || /^2a09:bac[0-7]:/i.test(a.ip)));
  if (warp) log(`${label} comes through Cloudflare WARP (${warp.ip}), which blocks connections from other networks. Turn WARP off on that device and connect again.`, 'warn');
}

// Address pairs and how far their checks got. Chrome drops failed pairs from its stats, so they're sampled while connecting.
const pairs = new Map();
async function samplePairs(p) {
  const s = await p.getStats();
  const c = id => { const x = s.get(id); return x ? `${x.candidateType} ${x.protocol} ${x.address || x.ip || '(hidden)'}:${x.port}` : '?'; };
  if (p === pc) s.forEach(r => r.type === 'candidate-pair' && pairs.set(r.id, { ...r, local: c(r.localCandidateId), remote: c(r.remoteCandidateId) }));
}

// After a failed attempt: every address pair tried and how far its checks got, then a best guess at why.
async function report(p) {
  try { await samplePairs(p); } catch (e) { log("Couldn't read connection stats: " + why(e), 'warn'); }
  let answered = 0, received = 0;
  for (const r of pairs.values()) {
    answered += r.responsesReceived || 0;
    received += r.requestsReceived || 0;
    log(`Pair ${r.local} → ${r.remote}: ${r.state}, checks sent ${r.requestsSent ?? '?'}, answered ${r.responsesReceived ?? '?'}, received ${r.requestsReceived ?? '?'}`);
  }
  log(!pairs.size ? 'No address pairs were tried: one side gave no usable addresses.'
    : answered ? 'Some checks were answered, yet the connection still failed (the encryption handshake failed, or traffic was blocked after the first packets).'
    : received ? "The other device's checks reached this one, but none of this device's checks were answered: their network or NAT drops incoming traffic."
    : 'No checks got through in either direction: a firewall blocks peer-to-peer UDP, or both sides are behind strict NAT. Try a phone hotspot on one side.', 'err');
}

// ---------- Connection code <-> SDP ----------
// Code: <kind><ufrag>,<pwd>,<fingerprint b64>,<candidates...>
// kind: o = offer; a / p = answer taking DTLS role active / passive. Candidate: h|s (host|srflx) + ip + "_" + port.
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

function encode({ type, sdp }) {
  const get = k => sdp.match(new RegExp(`a=${k}:(.+)`))[1].trim();
  const [alg, hex] = get('fingerprint').split(' ');
  if (alg.toLowerCase() !== 'sha-256') throw new Error('unsupported fingerprint');
  const cands = new Set([...sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx)/gi)].map(m => m[3][0] + m[1] + '_' + m[2]));
  const kind = type === 'offer' ? 'o' : get('setup') === 'passive' ? 'p' : 'a';
  return kind + [get('ice-ufrag'), get('ice-pwd'), b64(hex.split(':').map(h => parseInt(h, 16))), ...cands].join(',');
}

function decode(code, mid = '0') {
  const [ufrag, pwd, fp, ...cands] = code.slice(1).split(',');
  const fingerprint = [...unb64(fp)].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  if (!/^[oap]$/.test(code[0]) || !/^[\w+/]+$/.test(ufrag + pwd) || fingerprint.length !== 95 ||
      !cands.every(c => /^[hs][\w.:-]+_\d+$/.test(c))) throw new Error('bad code');
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${{ o: 'actpass', a: 'active', p: 'passive' }[code[0]]}`, `a=mid:${mid}`,
    'a=sctp-port:5000', 'a=max-message-size:262144',
    ...cands.map((c, i) => {
      const [ip, port] = c.slice(1).split('_'), host = c[0] === 'h';
      return `a=candidate:${i} 1 udp ${host ? 2113937151 : 1677729535} ${ip} ${port} typ ${host ? 'host' : 'srflx raddr 0.0.0.0 rport 0'}`;
    }), 'a=end-of-candidates', ''].join('\r\n');
  return { type: code[0] === 'o' ? 'offer' : 'answer', sdp };
}

// ---------- Peer connection ----------
// A sender waiting on a full buffer parks its wake-up in ch.drain.
function wire(ch) {
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW;
  ch.onbufferedamountlow = () => ch.drain?.();
  return ch;
}

function newPeer() {
  dropped();
  pc?.close();
  const p = pc = new RTCPeerConnection({ iceServers: ICE });
  const ch = dc = wire(p.createDataChannel('websend', { negotiated: true, id: 0 }));
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
const gathered = p => new Promise(r => {
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

// Each returns the new code, or nothing if the user moved on (Back, or another code) meanwhile.
async function makeOffer() {
  newPeer();
  const p = pc;
  await p.setLocalDescription();
  const code = await gathered(p);
  if (p !== pc) return;
  logCode('Your invite', code);
  return myCode = code;
}

async function makeAnswer(offer) {
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

async function takeAnswer(code) {
  const desc = decode(code, pc.localDescription.sdp.match(/a=mid:(\S+)/)[1]);
  logCode('Their reply', code);
  await pc.setRemoteDescription(desc);
  clearTimeout(timer);
  timer = setTimeout(() => fail('not connected 20 s after taking their reply'), 20000);
}

// The invite is made while the user picks how to send it, so it's usually ready by the time it's shown.
async function createCode() {
  myCode = null;
  if (await makeOffer()) showCode();
}

// Takes in a code from any method. An invite makes this device the joiner, whatever it was doing before.
async function useCode(text) {
  const code = decodeURIComponent(text.trim().split('#').pop());
  if (!code) return;
  try {
    if (code[0] === 'o') {
      if (code === myCode) return say("That's this device's own invite. Use it on the other device.", true);
      decode(code);
      role = 'joining';
      replying = true;
      toReply = false;
      myCode = sendM = null;
      view('ask');
      if (await makeAnswer(code)) showCode();
    } else {
      if (pc?.signalingState !== 'have-local-offer') return log(`Got a reply while ${pc ? pc.signalingState : 'no connection was started'}`, 'warn'), say("That's a reply. Enter it on the device that started the connection.", true);
      await takeAnswer(code);
      say('Connecting…');
    }
  } catch (e) {
    log(`Couldn't use the code "${code.slice(0, 40)}${code.length > 40 ? '…' : ''}" (${code.length} characters): ${why(e)}`, 'err');
    say("That code didn't work. Check you copied all of it.", true);
  }
}

// Back to the start screen, dropping any half-made connection.
function reset(msg) {
  clearTimeout(timer);
  if (!connected) { pc?.close(); pc = dc = myCode = null; }
  role = sendM = getM = lastHeard = null;
  replying = toReply = false;
  view('start', msg);
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

// Both users confirmed the number, so unfinished transfers can carry on. Until then nothing is offered, so a
// device that took over the connection learns nothing about the files, even on a reconnect.
function bothChecked() {
  view('connected');
  const old = [...out.values()];
  sendIn({ t: 'cancel', up: true }, 'ids', old.filter(o => o.state === 'cancelled').map(o => o.id)); // in case it missed them
  offer(old.filter(o => !['done', 'declined', 'cancelled'].includes(o.state)));
  if (pc.localDescription.type === 'offer') for (let i = 1; i < LANES; i++) lane(i);
}

// ---------- Lanes ----------
// A single connection backs off on every lost packet, so on Wi-Fi or across the internet it fills only part of the
// link; a few side by side fill much more of it (1.5–2x in tests with loss or delay). Once both users have checked
// the number, the starting device opens extra connections (lanes), swapping their codes over the checked channel.
// Each code carries its lane's key fingerprint, so a lane is as trustworthy as the channel it was agreed on.
// Files go out in segments that any free lane picks up; see pump().
const lanes = new Map();
// theirs: the other device's code for this lane, when it opened it.
async function lane(i, theirs) {
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
  queue = queue.filter(o => !again.includes(o));
  offer(again);
}

function closeLanes() {
  for (const { p, ch } of lanes.values()) { p.close(); ch.drain?.(); }
  lanes.clear();
}

// Both screens show the same number only if each device holds the key the other expected. A match rules out
// anyone who swapped in their own code (answered a sound code first, or tampered with a message).
// The keys alone aren't enough: whoever sends a code last could try key after key offline until both numbers came
// out equal. So each device also mixes in a random value, and sends its hash (a commitment) before either value
// is revealed. Neither side can then pick its value after seeing the other's, leaving a forger a 1 in a million guess.
let sas = null;
const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

function startSas() {
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
  queue = [];
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

// Keep the screen on while the page is visible; the browser drops the lock whenever it's hidden.
const keepAwake = () => document.visibilityState === 'visible' && !wake && navigator.wakeLock?.request('screen')
  .then(l => { wake = l; l.addEventListener('release', () => wake = null); }, () => {});
document.addEventListener('visibilitychange', keepAwake);
addEventListener('focus', keepAwake);
addEventListener('pointerdown', keepAwake); // some browsers refuse the lock until the user interacts
keepAwake();

// ---------- Protocol ----------
const send = m => dc?.readyState === 'open' && dc.send(JSON.stringify(m));
const sendIn = (msg, key, arr) => { for (let i = 0; i < arr.length; i += BATCH) send({ ...msg, [key]: arr.slice(i, i + BATCH) }); };

function offer(list) {
  list.forEach(o => { o.state = 'offered'; dirty.add(o); });
  sendIn({ t: 'offer', g: rid() }, 'files', list.map(({ id, path, size, held }) => ({ id, path, size, held: !!held })));
}

// Pause, resume or cancel a file from either end. The other device mirrors it; only the sender's pump acts on a pause.
// up: the file goes out from the device sending the message, so the one getting it looks it up among incoming files.
const LIVE = ['queued', 'offered', 'sending', 'receiving'];
function hold(it, on) {
  it.held = on;
  dirty.add(it);
  send({ t: 'hold', ids: [it.id], on, up: !!it.up });
  if (!on) pump();
}
function cancel(it) {
  send({ t: 'cancel', ids: [it.id], up: !!it.up });
  stop(it);
}
function stop(it) {
  it.state = 'cancelled';
  dirty.add(it);
  if (it.up) return void (queue = queue.filter(o => o !== it));
  it.segs = null;
  if (it.chain) it.chain = it.chain.then(() => it.w.abort()).then(() => it.rm?.()).catch(() => {}); // drop the half-written file
  zipReady(it.grp);
}

const on = {
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
  // max: the largest message the other device takes (missing from older versions, which get 64 KB).
  ok({ max }) {
    if (theyOk) return;
    theyOk = true;
    chunk = Math.max(CHUNK, Math.min(BIG, +max || 0, pc.sctp?.maxMessageSize || 0));
    if (checked) bothChecked();
  },
  got({ id }) { const o = out.get(id); if (o) { o.n = o.size; o.state = 'done'; queue = queue.filter(x => x !== o); dirty.add(o); } },
  // The bytes that follow on this channel belong to file id from offset at.
  seg({ id, at }, ch) {
    const it = inc.get(id), prev = ch.cur?.seg;
    if (prev) prev.parts = [new Blob(prev.parts)]; // that segment is finished, so the browser can page it to disk
    ch.cur = null;
    if (it?.state !== 'receiving' || !Number.isSafeInteger(at) || at < 0 || at >= it.size) return;
    const seg = { at, n: 0, parts: [] }, old = it.segs.get(at);
    if (old) it.n -= old.n;
    it.segs.set(at, seg);
    ch.cur = { it, seg };
    if (it.folder) write(it);
  },
  async lane({ i, c }) {
    if (!Number.isInteger(i) || i < 1 || i >= LANES || typeof c !== 'string') return;
    if (c[0] === 'o') return void (lanes.has(i) || lane(i, c));
    const p = lanes.get(i)?.p;
    try { await p?.setRemoteDescription(decode(c, p.localDescription.sdp.match(/a=mid:(\S+)/)[1])); }
    catch (e) { log(`Lane ${i} failed: ${why(e)}`, 'warn'); }
  },
  text({ v }) { textEntry('↓', String(v)); },
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
  bye() { dropped('The other device disconnected.'); },
};

// Until both users have confirmed the number, only the check itself (and hanging up) gets through.
const EARLY = ['commit', 'reveal', 'ok', 'bye'];
function onMessage(d, ch) {
  if (typeof d !== 'string') return ready() && onChunk(d, ch);
  try {
    const m = JSON.parse(d);
    if (!Object.hasOwn(on, m.t)) return;
    if (ready() || EARLY.includes(m.t)) on[m.t](m, ch);
    else log(`Ignored a "${m.t}" message that came before the number was confirmed`, 'warn');
  } catch (e) { log(`Bad message from the other device: ${why(e)}`, 'err'); }
}

// Accepted files go out in segments of up to SEG bytes, each on whichever channel is free (the main one or a lane),
// so one big file uses every lane and small files go out side by side. Each segment starts with a 'seg' header on
// its channel. A paused file is skipped, and a pause or cancel takes effect at the next chunk.
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
const pump = () => chans().forEach(run);
async function run(ch) {
  if (ch.busy) return;
  ch.busy = true;
  let s;
  try {
    while (ch.readyState === 'open' && (s = take())) {
      const { o } = s;
      ch.send(JSON.stringify({ t: 'seg', id: o.id, at: s.at }));
      while (s.at < s.end && live(o)) {
        const buf = await o.file.slice(s.at, Math.min(s.end, s.at + READ)).arrayBuffer();
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
      }
      if (s.at < s.end && o.state === 'sending') o.left.push({ o, at: s.at, end: s.end }); // paused partway
      if (o.n >= o.size) queue = queue.filter(x => x !== o);
    }
  } catch (e) {
    log(`Sending ${s?.o.path} failed: ${why(e)}`, 'err');
    if (ch.readyState === 'open' && s) { queue = queue.filter(x => x !== s.o); s.o.state = 'error'; dirty.add(s.o); }
  } finally {
    ch.busy = false;
  }
}

// Segments can arrive in any order. Each keeps its own bytes until the file is complete.
function onChunk(buf, ch) {
  const { it, seg } = ch.cur || {};
  if (it?.state !== 'receiving' || it.segs.get(seg.at) !== seg) return; // cancelled, or the segment was sent again
  const at = seg.at + seg.n;
  seg.n += buf.byteLength;
  it.n += buf.byteLength;
  moved += buf.byteLength;
  dirty.add(it);
  if (it.folder) write(it, w => w.write({ type: 'write', position: at, data: buf }));
  else seg.parts.push(buf);
  if (it.n >= it.size) finish(it);
}

// After a reconnect: how much of the file arrived from the start with no gap. Anything past a gap is dropped
// and sent again.
function kept(it) {
  let n = 0;
  for (const s of [...it.segs.values()].sort((a, b) => a.at - b.at)) if (s.at > n) it.segs.delete(s.at); else n = Math.max(n, s.at + s.n);
  return it.n = n;
}
const detach = it => chans().forEach(ch => { if (ch.cur?.it === it) ch.cur = null; });

function finish(it) {
  detach(it);
  send({ t: 'got', id: it.id });
  if (it.folder) {
    write(it).then(() => it.w.close()).then(() => it.state = 'done', e => { it.state = 'error'; log(`Writing ${it.path} failed: ${why(e)}`, 'err'); }).then(() => dirty.add(it));
    return;
  }
  it.blob = new Blob([...it.segs.values()].sort((a, b) => a.at - b.at).flatMap(s => s.parts));
  it.segs = null;
  it.a = el('a', { href: URL.createObjectURL(it.blob), download: it.path.replace(/[/\\]/g, '_'), textContent: 'Save', onclick: savedOnce });
  it.note.after(' ', it.a);
  if (it.auto) it.a.click();
  it.state = 'done';
  dirty.add(it);
  zipReady(it.grp);
}

// Save links fire for automatic downloads too, so after the first one they offer to save again.
function savedOnce() { if (!this.textContent.endsWith(' again')) this.textContent += ' again'; }

async function saveEach(items) {
  for (const it of items) {
    it.a.click();
    await new Promise(r => setTimeout(r, 250)); // browsers drop downloads fired in the same instant
  }
}

// Zips the files picked for it once none of them are still arriving.
function zipReady(grp) {
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
  try {
    const a = el('a', { href: URL.createObjectURL(await downloadZip(files).blob()), download: name + '.zip', textContent: `Save ${name}.zip`, onclick: savedOnce });
    show(a);
    a.click();
  } catch (e) { show(el('small', { textContent: 'Zip failed: ' + e.message })); log('Zip failed: ' + why(e), 'err'); }
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

// ---------- Files in ----------
function addFiles(list) { // [[File, relativePath]]
  if (!list.length) return;
  const grp = group('↑ Sending');
  const fresh = list.map(([file, path]) => {
    const o = { id: rid(), file, path, size: file.size, n: 0, state: 'queued', up: true };
    out.set(o.id, o);
    addRow(grp, o);
    return o;
  });
  if (ready()) offer(fresh);
}

async function walk(entry, path = '') {
  if (entry.isFile) return [[await new Promise((r, j) => entry.file(r, j)), path + entry.name]];
  const reader = entry.createReader(), kids = [];
  for (let b; (b = await new Promise((r, j) => reader.readEntries(r, j))).length;) kids.push(...b);
  return (await Promise.all(kids.map(k => walk(k, path + entry.name + '/')))).flat();
}

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  addFiles(entries.length ? (await Promise.all(entries.map(x => walk(x)))).flat() : [...e.dataTransfer.files].map(f => [f, f.name]));
});
// Pasting once connected sends what's pasted: files and screenshots go out like dropped ones. Text pasted outside
// a text field goes into the text box to look over first, since a clipboard can hold something private.
document.addEventListener('paste', e => {
  if ($('main').hidden) return;
  const files = [...e.clipboardData.files], text = e.clipboardData.getData('text/plain');
  const field = e.target.closest?.('input, textarea, [contenteditable]');
  if (files.length && !(field && text)) {
    e.preventDefault();
    addFiles(files.map(f => [f, f.name]));
  } else if (text && !field) {
    e.preventDefault();
    $('text').value = text;
    $('text').focus();
  }
});
$('pickFiles').onclick = () => $('files').click();
$('pickFolder').onclick = () => $('folder').click();
$('files').onchange = $('folder').onchange = e => {
  addFiles([...e.target.files].map(f => [f, f.webkitRelativePath || f.name]));
  e.target.value = '';
};

// ---------- UI ----------
function say(msg, alert = false) {
  $('status').textContent = msg || '';
  $('status').classList.toggle('alert', alert);
}

// The connection screens. After start or join, each device answers one question per direction: how its code
// goes to the other device, and how it takes in the other's. The three methods are listed alike and none is
// picked in advance, so the invite and the reply can travel different ways.
//   ask:  the question that fits (send the invite / get the invite / send the reply / get the reply)
//   give: this device's code in the method picked
//   get:  scan, paste or listen for the other device's code
// Starter: ask → give → ask → get. Joiner: ask → get → ask → give.
const STEPS = ['Invite', 'Reply', 'Check number', 'Send'];
const METHODS = { qr: 'QR code', link: 'Link', sound: 'Sound' };
const ABOUT = {
  send: { qr: 'Show a code for the other device to scan.', link: 'Copy a link and send it through any app, like a messenger or email.', sound: 'Chirp it to the other device. Needs a speaker.' },
  get: { qr: "Scan the code it shows with this device's camera.", link: 'Paste the link it sends you.', sound: 'Listen for its chirps. Needs a microphone.' },
};

const stepper = at => $('steps').replaceChildren(...STEPS.flatMap((t, i) =>
  [i ? ' › ' : '', i === at ? el('b', { textContent: t, ariaCurrent: 'step' }) : (i < at ? '✓ ' : '') + t]));
const tip = (id, text) => $(id).replaceChildren(el('b', { textContent: 'On the other device:' }), ' ' + text);

// Fresh radios every time, so nothing is picked until the user picks.
function methods(set, kind) {
  set.replaceChildren(...Object.keys(METHODS).map(m => el('label', {},
    el('input', { type: 'radio', name: set.id, value: m }), el('b', { textContent: METHODS[m] }), el('span', { textContent: ABOUT[kind][m] }))));
  set.nextElementSibling.hidden = true;
}
function picked(set, msg) {
  const m = set.querySelector(':checked')?.value;
  if (!m) Object.assign(set.nextElementSibling, { hidden: false, textContent: msg });
  return m;
}

function view(s, msg) {
  if (s !== screen) chirping = false; // sound only ever starts from the Play sound button
  screen = s;
  const flow = ['ask', 'give', 'get'].includes(s), starting = role === 'starting';
  $('start').hidden = s !== 'start';
  $('flow').hidden = !flow;
  $('hangup').hidden = s !== 'connected';
  $('sas').hidden = s !== 'connected' || checked;
  $('main').hidden = s !== 'connected' || !checked;
  if (flow) {
    $('role').textContent = `You're ${role} the connection.`;
    stepper(+(starting ? toReply : replying));
    $('got').hidden = !replying;
    for (const id of ['ask', 'give', 'get']) $(id).hidden = s !== id;
    $('back').hidden = s === 'ask' && replying; // the invite is already in, so there's nothing to go back to
  }
  if (s === 'ask') {
    const [title, hint] = starting && toReply ? ['How is the reply coming back?', 'Once it has your invite, the other device asks how to send its reply. Pick the same method here.']
      : starting ? ['How do you want to send your invite?', '']
      : replying ? ['How do you want to send your reply?', "Any method works, even a different one from the invite's."]
      : ['How are you getting the invite?', 'Pick the method the other device is using to send it.'];
    $('askTitle').textContent = title;
    $('askHint').textContent = hint;
    $('askHint').hidden = !hint;
    methods($('askSet'), (starting && !toReply) || replying ? 'send' : 'get');
  }
  if (s === 'give') {
    $('giveTitle').textContent = starting ? 'Send your invite' : 'Send your reply';
    document.querySelectorAll('[data-g]').forEach(p => p.hidden = p.dataset.g !== sendM);
    tip('giveTip', starting
      ? `tap Join a connection and pick ${METHODS[sendM]}.` + { qr: ' Its camera app works too.', link: ' Or just open the link there.', sound: '' }[sendM]
      : `when it asks how the reply is coming back, pick ${METHODS[sendM]}. You're connected as soon as it takes in your reply.`);
    $('giveNext').hidden = !starting;
    showCode();
  }
  if (s === 'get') {
    const what = starting ? 'reply' : 'invite';
    $('getTitle').textContent = { qr: 'Scan', link: 'Paste', sound: 'Listen for' }[getM] + ` the other device's ${what}`;
    document.querySelectorAll('[data-t]').forEach(p => p.hidden = p.dataset.t !== getM);
    tip('getTip', starting ? `once it has your invite, it asks how to send its reply. Pick ${METHODS[getM]} there.` : `tap Start a connection and pick ${METHODS[getM]}.`);
    if (getM === 'link' && !matchMedia('(pointer: coarse)').matches) $('paste').focus();
  }
  syncMedia();
  $('sendText').disabled = !ready();
  say(msg || {
    give: starting ? '' : 'Waiting for the other device to take your reply…', get: starting ? 'Waiting for their reply…' : '',
    connected: 'Connected', handed: 'Code passed to your other WebSend tab. Switch to it; you can close this one.',
  }[s], !!msg && s === 'start');
}

// Shows this device's code once it's ready. Called again when making it finishes.
let shown;
function showCode() {
  const what = role === 'starting' ? 'invite' : 'reply';
  $('making').textContent = `Making your ${what}…`;
  $('making').hidden = !!myCode;
  $('code').hidden = !myCode;
  $('chirpMsg').textContent = chirping ? `Playing your ${what}. It repeats until you stop it, so keep the devices close. Can't hear it? Check the media volume, and that the phone isn't on silent.`
    : `This plays your ${what} out loud as chirps. Turn the volume up and keep the devices close.`;
  $('chirp').textContent = chirping ? 'Stop sound' : 'Play sound';
  syncMedia();
  if (!myCode || myCode === shown) return;
  shown = myCode;
  const link = location.href.split('#')[0] + '#' + myCode;
  $('link').value = link;
  const q = qrcode(0, 'M');
  q.addData(link);
  q.make();
  const n = q.getModuleCount(), s = 8, c = $('qr'), x = c.getContext('2d');
  c.width = c.height = (n + 8) * s;
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect((k + 4) * s, (r + 4) * s, s, s);
}

function group(title) {
  const head = el('span'), ul = el('ul'), li = el('li', {}, head, ul);
  $('log').prepend(li);
  return { title, head, ul, items: [], total: 0 };
}

function addRow(grp, it) {
  it.note = el('small');
  it.bar = el('progress', { max: 1, value: 0 });
  it.pause = el('button', { onclick: () => hold(it, !it.held) });
  it.stop = el('button', { textContent: 'Cancel', onclick: () => cancel(it) });
  const li = el('li', {}, `${it.path} · ${fmt(it.size)} `, it.note, ' ', it.pause, ' ', it.stop, it.bar);
  grp.ul.append(li);
  grp.items.push(it);
  it.grp = grp;
  grp.total += it.size;
  grp.head.textContent = `${grp.title}: ${grp.items.length} file${grp.items.length > 1 ? 's' : ''} · ${fmt(grp.total)}`;
  dirty.add(it);
  return li;
}

// Incoming files are ticked by default. The buttons act on the ticked ones: a file not received yet
// is accepted, and one already received is saved again.
function askAccept(g, items) {
  let grp = groups.get(g);
  if (!grp) {
    grp = group('↓ Incoming');
    const b = (label, mode) => el('button', { textContent: label, onclick: () => act(grp, mode) });
    grp.all = el('input', { type: 'checkbox', checked: true, onchange: () => grp.items.forEach(it => it.box.checked = grp.all.checked) });
    grp.btns = el('div', {}, el('label', {}, grp.all, ' Select all'), el('br'),
      b('Download', 'dl'), ' ', b('Download as .zip', 'zip'), ' ', ...(window.showDirectoryPicker ? [b('Save to folder…', 'dir'), ' '] : []), b('Decline', 'no'));
    grp.head.after(grp.btns);
    groups.set(g, grp);
  }
  for (const it of items) {
    it.box = el('input', { type: 'checkbox', checked: true, onchange: () => syncAll(grp) });
    it.save = el('button', { textContent: 'Save', onclick: () => respond([it], 'dl') });
    addRow(grp, it).prepend(it.box);
    it.note.after(' ', it.save);
  }
  syncAll(grp);
}

function syncAll(grp) {
  const n = grp.items.filter(it => it.box.checked).length;
  grp.all.checked = n === grp.items.length;
  grp.all.indeterminate = n > 0 && n < grp.items.length;
}

async function act(grp, mode) {
  const sel = grp.items.filter(it => it.box.checked);
  const pending = sel.filter(it => it.state === 'pending');
  if (pending.length && !await respond(pending, mode)) return;
  if (mode === 'dl') saveEach(sel.filter(it => it.blob));
  if (mode === 'zip') { grp.zipSet = sel; zipReady(grp); }
}

async function respond(items, mode) {
  let folder = null;
  if (mode === 'dir') try { folder = await showDirectoryPicker({ mode: 'readwrite' }); } catch { return false; }
  items.forEach(it => {
    Object.assign(it, { state: mode === 'no' ? 'declined' : 'receiving', folder, auto: mode === 'dl', segs: new Map() });
    dirty.add(it);
  });
  if (mode === 'no') sendIn({ t: 'decline' }, 'ids', items.map(it => it.id));
  else {
    sendIn({ t: 'accept' }, 'files', items.map(it => [it.id, 0]));
    items.filter(it => !it.size).forEach(finish); // an empty file has nothing to wait for
  }
  return true;
}

const LABEL = { queued: 'waiting for connection', offered: 'waiting for them to accept', pending: '', declined: 'declined', error: 'failed', cancelled: 'cancelled' };
function paint(it) {
  const done = it.state === 'done', live = LIVE.includes(it.state);
  if (it.save) it.save.hidden = it.state !== 'pending';
  it.pause.hidden = it.stop.hidden = !live;
  it.pause.textContent = it.held ? 'Resume' : 'Pause';
  it.bar.value = done ? 1 : it.size ? it.n / it.size : 0;
  it.note.textContent = done ? (it.up ? 'sent ✓' : 'received ✓') : live && it.held ? 'paused' : LABEL[it.state] ?? Math.floor(it.bar.value * 100) + '%';
}

function textEntry(dir, v) {
  const body = /^https?:\/\/\S+$/.test(v) ? el('a', { href: v, textContent: v, target: '_blank', rel: 'noopener noreferrer' }) : el('pre', { textContent: v });
  $('log').prepend(el('li', {}, `${dir} Text `, el('button', { textContent: 'Copy', onclick: () => navigator.clipboard?.writeText(v) }), el('br'), body));
}

let lastMoved = 0;
setInterval(() => {
  dirty.forEach(paint);
  dirty.clear();
  if (connected) say(stall ? 'Connection interrupted. Trying to reconnect…' : checked && !theyOk ? 'Connected. Waiting for the other device to confirm the number…'
    : 'Connected' + route + (moved > lastMoved ? ` · ${fmt((moved - lastMoved) * 2)}/s` : ''), !!stall);
  lastMoved = moved;
}, 500);

$('goStart').onclick = () => { role = 'starting'; view('ask'); createCode(); };
$('goJoin').onclick = () => { role = 'joining'; view('ask'); };
$('askGo').onclick = () => {
  const m = picked($('askSet'), 'Pick a method first.');
  if (!m) return;
  if ((role === 'starting' && !toReply) || replying) { sendM = m; view('give'); } else { getM = m; view('get'); }
};
document.addEventListener('change', e => { if (e.target.type === 'radio') e.target.closest('fieldset').nextElementSibling.hidden = true; });
$('giveNext').onclick = () => { toReply = true; view('ask'); };
// Resumed during the tap too: some mobile browsers start audio suspended even when it's made in a tap.
$('chirp').onclick = async () => {
  chirping = !chirping;
  showCode();
  if (!chirping) return;
  const ctx = audio;
  await ctx.resume().catch(() => {});
  log(`Playing the code by sound: audio ${ctx.state} at ${ctx.sampleRate} Hz` + (navigator.audioSession ? `, session ${navigator.audioSession.type}` : ''), ctx.state === 'running' ? '' : 'warn');
  if (ctx === audio && ctx.state !== 'running') $('chirpMsg').textContent = "The browser didn't let the sound play. Tap Stop sound, then Play sound again.";
};
// Back goes one screen back: a code or scan goes back to its question, the reply question to the invite,
// and the first question to the start screen.
$('back').onclick = () => {
  if (screen !== 'ask') return view('ask');
  if (toReply) { toReply = false; return view('give'); }
  reset();
};
$('startOver').onclick = () => reset();
$('sasYes').onclick = () => {
  checked = true;
  send({ t: 'ok', max: +(pc.localDescription.sdp.match(/a=max-message-size:(\d+)/)?.[1] ?? 65536) }); // RFC 8841's default
  if (theyOk) bothChecked(); else view('connected');
};
$('sasNo').onclick = () => hangup("Disconnected because the numbers didn't match, so another device may have answered your invite. Connect again, ideally side by side.");
$('hangup').onclick = () => hangup('Disconnected.');
// Tells the other device first, so it drops at once instead of waiting for the connection to time out.
function hangup(msg) { const p = pc; send({ t: 'bye' }); dropped(msg); p?.close(); clearFiles(); }
addEventListener('pagehide', () => send({ t: 'bye' }));

// A deliberate disconnect forgets every transfer, unlike a dropped connection, which keeps them to resume.
function clearFiles() {
  for (const it of inc.values()) { if (it.a) URL.revokeObjectURL(it.a.href); if (it.grp.zipOut?.href) URL.revokeObjectURL(it.grp.zipOut.href); }
  out.clear(); inc.clear(); groups.clear(); dirty.clear();
  $('log').replaceChildren();
}
$('pasteForm').onsubmit = e => { e.preventDefault(); useCode($('paste').value); $('paste').value = ''; };
$('paste').addEventListener('paste', () => setTimeout(() => { useCode($('paste').value); $('paste').value = ''; }));
// Copies the whole link, or just the code after '#'. Falls back to selecting it in the link box.
const copy = async (btn, codeOnly) => {
  const link = $('link').value, text = codeOnly ? link.split('#')[1] : link, label = btn.textContent;
  try { await navigator.clipboard.writeText(text); } catch {
    $('link').focus();
    $('link').setSelectionRange(link.length - text.length, link.length);
    document.execCommand('copy');
  }
  btn.textContent = 'Copied';
  setTimeout(() => btn.textContent = label, 1500);
};
$('copy').onclick = e => copy(e.currentTarget, false);
$('copyCode').onclick = e => copy(e.currentTarget, true);
$('share').hidden = !navigator.share;
$('share').onclick = () => navigator.share({ url: $('link').value }).catch(() => {});
$('textForm').onsubmit = e => {
  e.preventDefault();
  const v = $('text').value;
  if (!v || !ready()) return;
  send({ t: 'text', v });
  textEntry('↑', v);
  $('text').value = '';
};
addEventListener('beforeunload', e => {
  if (connected || [...out.values(), ...inc.values()].some(x => x.state === 'sending' || x.state === 'receiving')) e.preventDefault();
});

// ---------- Sound and camera ----------
// Each runs only while the screen needs it: the speaker after the user taps Play sound on a code sent by sound,
// the microphone on a "listen" screen, the camera on a "scan" screen. Playing never needs the microphone.
// sound.js turns codes into tones. Anyone in earshot can hear them (harmless) or answer first; the number check catches that.
const wait = ms => new Promise(r => setTimeout(r, ms));
let audio, ear = null, cam = null, rx, osc = [], sending = null, lastHeard = null;

function syncMedia() {
  const chirp = chirping && sendM === 'sound' && screen === 'give';
  const hear = screen === 'get' && getM === 'sound';
  // iPhones mute web audio with the silent switch unless the page says it's playing media (Safari 17+).
  // Listening needs the recording session instead, which iOS also plays through.
  if (navigator.audioSession) navigator.audioSession.type = hear ? 'play-and-record' : chirp ? 'playback' : 'auto';
  if ((chirp || hear) && !audio) audio = new AudioContext(); // made during the tap on Play sound or Continue, so the browser lets it play
  if (chirp && myCode) { if (sending?.code !== myCode) broadcast(myCode); } else stopSending();
  if (hear) { if (!ear) listen(); } else stopListening();
  if (screen === 'get' && getM === 'qr') { if (!cam) scan(); } else stopScanning();
  if (!chirp && !hear && audio) { audio.close(); audio = null; }
}

function soundMsg(msg, sub = '') {
  $('soundMsg').textContent = msg;
  $('soundSub').textContent = sub;
}

// Microphone in. A failure only affects listening; anything this device is playing carries on.
async function listen() {
  const me = ear = {};
  soundMsg('Allow the microphone if asked', 'It only listens for the other device, and stops once you are connected.');
  try {
    me.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (ear !== me) return me.mic.getTracks().forEach(t => t.stop()); // left the screen meanwhile
    let src;
    try { src = audio.createMediaStreamSource(me.mic); } catch { // Firefox: the context must run at the microphone's sample rate
      stopSending();
      audio.close();
      audio = new AudioContext({ sampleRate: me.mic.getAudioTracks()[0].getSettings().sampleRate });
      src = audio.createMediaStreamSource(me.mic);
    }
    await audio.resume();
    await audio.audioWorklet.addModule('tap.js');
    if (ear !== me) return;
    const sink = audio.createGain();
    me.tap = new AudioWorkletNode(audio, 'tap');
    sink.gain.value = 0; // routed to the speakers silently, so every browser keeps the tap running
    src.connect(me.tap).connect(sink).connect(audio.destination);
    rx = Sound.receiver(audio.sampleRate, heard, (s, f) => {
      if (s === 'hearing') soundMsg(`Hearing the other device… ${Math.round(f * 100)}%`);
      else soundMsg("Didn't catch all of that", 'Listening again. Move the devices closer or turn the volume up.');
    });
    me.tap.port.onmessage = e => ear === me && rx?.push(e.data);
    soundMsg('Listening for the other device…', 'Keep the devices close with the volume up.');
    syncMedia(); // restarts playing if Firefox needed a new context
  } catch (e) {
    if (ear !== me) return;
    log('Microphone failed: ' + why(e), 'warn');
    soundMsg("Couldn't use the microphone.", "Allow it for this site in the browser's settings, or go back and pick another way.");
  }
}

function stopListening() {
  if (!ear) return;
  ear.mic?.getTracks().forEach(t => t.stop());
  ear.tap?.disconnect();
  ear = rx = null;
}

function heard(code) {
  if (code === lastHeard || code === lastOffer) return; // a repeat, or the invite this device already answered
  lastHeard = code;
  soundMsg(code[0] === 'o' ? 'Heard the invite.' : 'Heard the reply. Connecting…');
  useCode(code);
}

// Plays the code over and over until stopped, staying quiet while the other device is talking.
async function broadcast(code) {
  stopSending();
  const me = sending = { code }, tones = Sound.frame(code);
  while (sending === me) {
    if (rx?.busy()) { await wait(200); continue; }
    await play(tones);
    if (sending !== me) return;
    await wait(1000 + Math.random() * 2000);
  }
}

// Sync symbols are two-tone chords; the second oscillator is heard only then.
function play(tones) {
  const t0 = audio.currentTime + 0.05, end = t0 + tones.length * Sound.SYM, g = audio.createGain(), g2 = audio.createGain();
  const os = osc = [audio.createOscillator(), audio.createOscillator()];
  tones.forEach((k, i) => {
    const [a, b] = Sound.freqs(k), t = t0 + i * Sound.SYM;
    os[0].frequency.setValueAtTime(a, t);
    os[1].frequency.setValueAtTime(b || a, t);
    g2.gain.setValueAtTime(b ? 1 : 0, t);
  });
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.4, t0 + 0.01); // ramps avoid clicks
  g.gain.setValueAtTime(0.4, end - 0.01);
  g.gain.linearRampToValueAtTime(0, end);
  os[0].connect(g);
  os[1].connect(g2).connect(g);
  g.connect(audio.destination);
  os.forEach(o => { o.start(t0); o.stop(end); });
  rx?.mute((end - audio.currentTime + (audio.outputLatency || 0)) * 1000 + 300); // don't decode our own sound or its echo
  return new Promise(r => os[0].onended = r);
}

function stopSending() {
  sending = null;
  osc.forEach(o => { try { o.stop(); } catch {} });
  osc = [];
}

// Scans QR codes in the page (jsQR), so the camera app and a second tab aren't needed. Frames never leave the device.
async function scan() {
  const me = cam = {}, v = $('video');
  $('scanMsg').textContent = 'Allow the camera if asked. It only looks for the code.';
  try {
    me.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (cam !== me) return me.stream.getTracks().forEach(t => t.stop());
    v.srcObject = me.stream;
    await v.play();
    $('scanMsg').textContent = 'Point it at the code on the other screen. It scans by itself.';
    const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    let last;
    while (cam === me) {
      if (v.videoWidth) {
        const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight)); // smaller frames scan faster and still read fine
        c.width = v.videoWidth * k;
        c.height = v.videoHeight * k;
        x.drawImage(v, 0, 0, c.width, c.height);
        const text = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' })?.data;
        if (text && text !== last) { last = text; useCode(text); }
      }
      await wait(200);
    }
  } catch (e) {
    if (cam !== me) return;
    log('Camera failed: ' + why(e), 'warn');
    $('scanMsg').textContent = "Couldn't use the camera. Allow it for this site in the browser's settings, or go back and pick another way.";
  }
}

function stopScanning() {
  if (!cam) return;
  cam.stream?.getTracks().forEach(t => t.stop());
  $('video').srcObject = null;
  cam = null;
}

// ---------- Tab handoff ----------
// Scanning a WebSend QR with the phone camera opens a new tab. That tab hands the code to an
// existing WebSend tab that needs it (one waiting for a reply, or one with transfers to resume).
const TAB = rid(), bc = new BroadcastChannel('websend');
bc.onmessage = ({ data: d }) => {
  if (d.q && (d.q[0] === 'o' ? !connected && d.q !== myCode && (out.size || inc.size) : pc?.signalingState === 'have-local-offer'))
    bc.postMessage({ claim: d.n, tab: TAB });
  if (d.take === TAB) useCode(d.code);
};

function handoff(code) {
  const n = rid();
  let taken = false;
  const claim = ({ data: d }) => {
    if (d.claim !== n || taken) return;
    taken = true;
    bc.postMessage({ take: d.tab, code });
    view('handed');
  };
  bc.addEventListener('message', claim);
  bc.postMessage({ q: code, n });
  setTimeout(() => { bc.removeEventListener('message', claim); if (!taken) useCode(code); }, 400);
}

view('start');
const hash = decodeURIComponent(location.hash.slice(1));
if (hash) {
  history.replaceState(null, '', location.pathname + location.search); // keep codes out of history
  handoff(hash);
}
