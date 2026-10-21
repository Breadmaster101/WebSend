'use strict';
// WebSend: serverless peer-to-peer file transfer over WebRTC.
// There is no signaling server. The two browsers swap a short code by hand (QR, link or paste).
// A code holds only what WebRTC needs: ICE credentials, the DTLS certificate fingerprint
// (which authenticates the encrypted channel) and network addresses.

// Finds public addresses across networks; [] = same-LAN only, no third party at all. Two servers let the log spot
// networks that give each destination a different public port (symmetric NAT), which blocks direct connections.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const CHUNK = 64 << 10, READ = 1 << 20;                 // send 64 KB messages, read files 1 MB at a time
const HIGH = 8 << 20, LOW = 1 << 20;                    // send-buffer backpressure
const BATCH = 200;                                      // files per control message (keeps messages small)

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmt = b => { let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]; };
const rid = () => Math.random().toString(36).slice(2);

const out = new Map(), inc = new Map(), groups = new Map(), dirty = new Set();
let pc, dc, myCode, lastOffer, timer, wake, screen, cur = null, connected = false, queue = [], pumping = false, drain = () => {}, moved = 0, route = '';
// role: 'starting' | 'joining'. replying: the joiner has taken in the invite. sendM / getM: how this device gives its code
// and takes in the other's ('qr' | 'link' | 'sound'). checked: the user confirmed both screens show the same number.
let role = null, replying = false, sendM = null, getM = null, checked = false;

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
function newPeer() {
  dropped();
  pc?.close();
  const p = pc = new RTCPeerConnection({ iceServers: ICE });
  const ch = dc = p.createDataChannel('websend', { negotiated: true, id: 0 });
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW;
  ch.onbufferedamountlow = () => drain();
  ch.onopen = () => ch === dc && opened();
  ch.onclose = () => ch === dc && dropped();
  ch.onmessage = e => ch === dc && onMessage(e.data);
  ch.onerror = e => ch === dc && log('Data channel error: ' + why(e.error), 'err');
  log('New connection attempt');
  pairs.clear();
  const poll = setInterval(() => p === pc && !connected ? samplePairs(p).catch(() => {}) : clearInterval(poll), 1000);
  p.onicecandidate = ({ candidate: c }) => c?.candidate && log('Found address: ' + (c.type ? `${c.type} ${c.protocol} ${c.address}:${c.port}` : c.candidate));
  p.onicecandidateerror = e => log(`STUN ${e.url} error ${e.errorCode} on ${e.address ?? '?'}: ${e.errorText} (harmless if a public address is found)`);
  p.onicegatheringstatechange = () => log('Address search: ' + p.iceGatheringState);
  p.oniceconnectionstatechange = () => { const s = p.iceConnectionState; log('Connectivity checks: ' + s, s === 'failed' ? 'err' : s === 'disconnected' ? 'warn' : ''); };
  p.onconnectionstatechange = () => {
    if (p !== pc) return;
    const s = p.connectionState;
    log('Connection: ' + s, s === 'failed' ? 'err' : '');
    if (s !== 'failed') return;
    if (connected) dropped(); else if (p.localDescription?.type === 'offer') fail('every address pair failed'); else report(p);
  };
}

// Non-trickle ICE: wait for all candidates so the code is complete.
const gathered = p => new Promise(r => {
  const check = () => p.iceGatheringState === 'complete' && r();
  p.addEventListener('icegatheringstatechange', check);
  check();
  setTimeout(() => { if (p === pc && p.iceGatheringState !== 'complete') log('Address search still running after 3 s; using what it found so far.', 'warn'); r(); }, 3000);
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
  replying = false;
  view('start', msg);
}

function opened() {
  log('Connected: data channel open');
  connected = true;
  checked = false;
  clearTimeout(timer);
  view('connected');
  showSas(pc);
  showRoute(pc);
  offer([...out.values()].filter(o => o.state !== 'done' && o.state !== 'declined'));
}

// Both screens show the same number only if each device holds the key the other expected. A match rules out
// anyone who swapped in their own code (answered a sound code first, or tampered with a message).
async function showSas(p) {
  const fps = [p.localDescription, p.remoteDescription].map(d => d.sdp.match(/a=fingerprint:\S+ (\S+)/)[1].toUpperCase()).sort();
  const n = new DataView(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fps.join()))).getUint32(0) % 1e6;
  $('sasNum').textContent = String(n).padStart(6, '0').replace(/^.../, '$& ');
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
  route = '';
  cur = null;
  queue = [];
  drain();
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
  sendIn({ t: 'offer', g: rid() }, 'files', list.map(({ id, path, size }) => ({ id, path, size })));
}

const on = {
  offer({ g, files }) {
    const fresh = [], resume = [];
    for (const f of files) {
      const it = inc.get(f.id);
      if (!it) {
        if (!Number.isSafeInteger(f.size) || f.size < 0) continue;
        const n = { id: String(f.id), path: String(f.path), size: f.size, n: 0, state: 'pending' };
        inc.set(n.id, n);
        fresh.push(n);
      } else if (it.state === 'receiving') resume.push([it.id, it.n]);
      else if (it.state === 'done' || it.state === 'error') send({ t: 'got', id: it.id });
      else if (it.state === 'declined') send({ t: 'decline', ids: [it.id] });
    }
    sendIn({ t: 'accept' }, 'files', resume);
    if (fresh.length) askAccept(String(g), fresh);
  },
  accept({ files }) {
    for (const [id, n] of files) {
      const o = out.get(id);
      if (o?.state !== 'offered') continue;
      o.n = Math.min(Math.max(+n || 0, 0), o.size);
      o.state = 'sending';
      queue.push(o);
      dirty.add(o);
    }
    pump();
  },
  decline({ ids }) { ids.forEach(id => { const o = out.get(id); if (o) { o.state = 'declined'; dirty.add(o); } }); },
  got({ id }) { const o = out.get(id); if (o) { o.n = o.size; o.state = 'done'; dirty.add(o); } },
  file({ id }) {
    const it = inc.get(id);
    cur = it?.state === 'receiving' ? it : null;
    if (!cur) return;
    if (it.folder && !it.chain) it.chain = openWriter(it.folder, it.path).then(w => it.w = w);
    if (it.n >= it.size) finish(it);
  },
  text({ v }) { textEntry('↓', String(v)); },
};

function onMessage(d) {
  if (typeof d !== 'string') return onChunk(d);
  try { const m = JSON.parse(d); if (Object.hasOwn(on, m.t)) on[m.t](m); } catch (e) { log(`Bad message from the other device: ${why(e)}`, 'err'); }
}

// Sends accepted files one after another, respecting the channel's buffer.
async function pump() {
  if (pumping) return;
  pumping = true;
  const ch = dc;
  try {
    while (queue.length && ch === dc && ch.readyState === 'open') {
      const o = queue[0];
      ch.send(JSON.stringify({ t: 'file', id: o.id }));
      while (o.n < o.size) {
        const buf = await o.file.slice(o.n, o.n + READ).arrayBuffer();
        for (let i = 0; i < buf.byteLength; i += CHUNK) {
          if (ch.bufferedAmount > HIGH) await new Promise(r => drain = r);
          if (ch !== dc || ch.readyState !== 'open') return;
          const part = new Uint8Array(buf, i, Math.min(CHUNK, buf.byteLength - i));
          ch.send(part);
          o.n += part.byteLength;
          moved += part.byteLength;
        }
        dirty.add(o);
      }
      queue.shift();
    }
  } catch (e) {
    log(`Sending ${queue[0]?.path} failed: ${why(e)}`, 'err');
    if (ch.readyState === 'open') { const o = queue.shift(); o.state = 'error'; dirty.add(o); }
  } finally {
    pumping = false;
    if (ch !== dc) pump(); // reconnected while this loop was winding down
  }
}

function onChunk(buf) {
  const it = cur;
  if (!it) return;
  it.n += buf.byteLength;
  moved += buf.byteLength;
  dirty.add(it);
  if (it.folder) it.chain = it.chain.then(() => it.w.write(buf));
  else {
    it.parts.push(buf);
    // Fold chunks into a Blob regularly so the browser can page large files to disk.
    if ((it.pend += buf.byteLength) > 32 << 20) { it.parts = [new Blob(it.parts)]; it.pend = 0; }
  }
  if (it.n >= it.size) finish(it);
}

function finish(it) {
  cur = null;
  send({ t: 'got', id: it.id });
  if (it.folder) {
    it.chain.then(() => it.w.close()).then(() => it.state = 'done', e => { it.state = 'error'; log(`Writing ${it.path} failed: ${why(e)}`, 'err'); }).then(() => dirty.add(it));
    return;
  }
  it.blob = new Blob(it.parts);
  it.parts = null;
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

async function openWriter(dir, path) {
  const segs = path.split(/[/\\]/).filter(s => s && s !== '.' && s !== '..');
  const name = segs.pop() || 'file';
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
  return (await dir.getFileHandle(name, { create: true })).createWritable();
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
  if (connected) offer(fresh);
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
//   ask:  the question that fits (send the invite / get the invite / send the reply)
//   give: this device's code in the method picked; the starter also asks how the reply comes back
//   get:  scan, paste or listen for the other device's code
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
  set.replaceChildren(set.querySelector('legend'), ...Object.keys(METHODS).map(m => el('label', {},
    el('input', { type: 'radio', name: set.id, value: m }), el('b', { textContent: METHODS[m] }), el('span', { textContent: ABOUT[kind][m] }))));
  set.nextElementSibling.hidden = true;
}
function picked(set, msg) {
  const m = set.querySelector(':checked')?.value;
  if (!m) Object.assign(set.nextElementSibling, { hidden: false, textContent: msg });
  return m;
}

function view(s, msg) {
  screen = s;
  const flow = ['ask', 'give', 'get'].includes(s), starting = role === 'starting';
  $('start').hidden = s !== 'start';
  $('flow').hidden = !flow;
  $('hangup').hidden = s !== 'connected';
  $('sas').hidden = s !== 'connected' || checked;
  $('main').hidden = s !== 'connected' || !checked;
  if (flow) {
    $('role').textContent = `You're ${role} the connection.`;
    stepper(starting ? +(s === 'get') : +replying);
    $('got').hidden = !replying;
    for (const id of ['ask', 'give', 'get']) $(id).hidden = s !== id;
    $('back').textContent = s === 'get' || (s === 'ask' && !replying) ? 'Back' : 'Start over';
  }
  if (s === 'ask') {
    $('askTitle').textContent = starting ? 'How do you want to send your invite?' : replying ? 'How do you want to send your reply?' : 'How are you getting the invite?';
    $('askHint').textContent = replying ? "Any method works, even a different one from the invite's." : starting ? '' : 'Pick the method the other device is using to send it.';
    methods($('askSet'), starting || replying ? 'send' : 'get');
  }
  if (s === 'give') {
    $('giveTitle').textContent = starting ? '1. Send your invite' : 'Send your reply';
    document.querySelectorAll('[data-g]').forEach(p => p.hidden = p.dataset.g !== sendM);
    tip('giveTip', starting
      ? `tap Join a connection and pick ${METHODS[sendM]}.` + { qr: ' Its camera app works too.', link: ' Or just open the link there.', sound: '' }[sendM]
      : `under Get its reply, pick ${METHODS[sendM]}. You're connected as soon as it takes in your reply.`);
    $('replyStep').hidden = !starting;
    if (starting) methods($('replySet'), 'get');
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
  $('sendText').disabled = s !== 'connected';
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
  $('chirpWhat').textContent = what;
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
  const li = el('li', {}, `${it.path} · ${fmt(it.size)} `, it.note, it.bar);
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
    Object.assign(it, { state: mode === 'no' ? 'declined' : 'receiving', folder, auto: mode === 'dl', parts: [], pend: 0 });
    dirty.add(it);
  });
  if (mode === 'no') sendIn({ t: 'decline' }, 'ids', items.map(it => it.id));
  else sendIn({ t: 'accept' }, 'files', items.map(it => [it.id, 0]));
  return true;
}

const LABEL = { queued: 'waiting for connection', offered: 'waiting for them to accept', pending: '', declined: 'declined', error: 'failed' };
function paint(it) {
  const done = it.state === 'done';
  if (it.save) it.save.hidden = it.state !== 'pending';
  it.bar.value = done ? 1 : it.size ? it.n / it.size : 0;
  it.note.textContent = done ? (it.up ? 'sent ✓' : 'received ✓') : LABEL[it.state] ?? Math.floor(it.bar.value * 100) + '%';
}

function textEntry(dir, v) {
  const body = /^https?:\/\/\S+$/.test(v) ? el('a', { href: v, textContent: v, target: '_blank', rel: 'noopener noreferrer' }) : el('pre', { textContent: v });
  $('log').prepend(el('li', {}, `${dir} Text `, el('button', { textContent: 'Copy', onclick: () => navigator.clipboard?.writeText(v) }), el('br'), body));
}

let lastMoved = 0;
setInterval(() => {
  dirty.forEach(paint);
  dirty.clear();
  if (connected) say('Connected' + route + (moved > lastMoved ? ` · ${fmt((moved - lastMoved) * 2)}/s` : ''));
  lastMoved = moved;
}, 500);

$('goStart').onclick = () => { role = 'starting'; view('ask'); createCode(); };
$('goJoin').onclick = () => { role = 'joining'; view('ask'); };
$('askGo').onclick = () => {
  const m = picked($('askSet'), 'Pick a method first.');
  if (!m) return;
  if (role === 'starting' || replying) { sendM = m; view('give'); } else { getM = m; view('get'); }
};
$('replyGo').onclick = () => {
  const m = picked($('replySet'), 'Pick how the reply is coming back first.');
  if (m) { getM = m; view('get'); }
};
document.addEventListener('change', e => { if (e.target.type === 'radio') e.target.closest('fieldset').nextElementSibling.hidden = true; });
$('giveSwitch').onclick = () => view('ask');
// Back from scanning, pasting or listening returns to the question or code before it; elsewhere it starts over.
$('back').onclick = () => screen === 'get' ? view(role === 'starting' ? 'give' : 'ask') : reset();
$('sasYes').onclick = () => { checked = true; view('connected'); };
$('sasNo').onclick = () => hangup("Disconnected because the numbers didn't match, so another device may have answered your invite. Connect again, ideally side by side.");
$('hangup').onclick = () => hangup('Disconnected.');
function hangup(msg) { const p = pc; dropped(msg); p?.close(); clearFiles(); }

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
  if (!v || !connected) return;
  send({ t: 'text', v });
  textEntry('↑', v);
  $('text').value = '';
};
addEventListener('beforeunload', e => {
  if (connected || [...out.values(), ...inc.values()].some(x => x.state === 'sending' || x.state === 'receiving')) e.preventDefault();
});

// ---------- Sound and camera ----------
// Each runs only while the screen needs it: the speaker while this device's code is being sent by sound,
// the microphone on a "listen" screen, the camera on a "scan" screen. Playing never needs the microphone.
// sound.js turns codes into tones. Anyone in earshot can hear them (harmless) or answer first; the number check catches that.
const wait = ms => new Promise(r => setTimeout(r, ms));
let audio, ear = null, cam = null, rx, osc = [], sending = null, lastHeard = null;

function syncMedia() {
  const chirp = sendM === 'sound' && (screen === 'give' || (screen === 'get' && role === 'starting')); // the invite keeps playing while the starter waits
  const hear = screen === 'get' && getM === 'sound';
  if ((chirp || hear) && !audio) audio = new AudioContext(); // first made during the tap that picked sound, so the browser lets it play
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
