'use strict';
// WebSend: serverless peer-to-peer file transfer over WebRTC.
// There is no signaling server. The two browsers swap a short code by hand (QR, link or paste).
// A code holds only what WebRTC needs: ICE credentials, the DTLS certificate fingerprint
// (which authenticates the encrypted channel) and network addresses.

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // finds public addresses across networks; [] = same-LAN only, no third party at all
const CHUNK = 64 << 10, READ = 1 << 20;                 // send 64 KB messages, read files 1 MB at a time
const HIGH = 8 << 20, LOW = 1 << 20;                    // send-buffer backpressure
const BATCH = 200;                                      // files per control message (keeps messages small)

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmt = b => { let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]; };
const rid = () => Math.random().toString(36).slice(2);

const out = new Map(), inc = new Map(), groups = new Map(), dirty = new Set();
let pc, dc, myCode, lastOffer, timer, wake, screen, cur = null, connected = false, queue = [], pumping = false, drain = () => {}, moved = 0, route = '';

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
  p.onconnectionstatechange = () => {
    if (p !== pc || p.connectionState !== 'failed') return;
    if (connected) dropped(); else if (p.localDescription?.type === 'offer') fail();
  };
}

// Non-trickle ICE: wait for all candidates so the code is complete.
const gathered = p => new Promise(r => {
  const check = () => p.iceGatheringState === 'complete' && r();
  p.addEventListener('icegatheringstatechange', check);
  check();
  setTimeout(r, 3000);
}).then(() => encode(p.localDescription));

// Each returns the new code, or nothing if the user moved on (Back, or another code) meanwhile.
async function makeOffer() {
  newPeer();
  const p = pc;
  await p.setLocalDescription();
  const code = await gathered(p);
  if (p === pc) return myCode = code;
}

async function makeAnswer(offer) {
  newPeer();
  try { lastOffer = Sound.norm(offer); } catch { lastOffer = offer; }
  const p = pc;
  await p.setRemoteDescription(decode(offer));
  await p.setLocalDescription();
  const code = await gathered(p);
  if (p !== pc) return;
  clearTimeout(timer);
  timer = setTimeout(fail, 120000);
  return myCode = code;
}

async function takeAnswer(code) {
  await pc.setRemoteDescription(decode(code, pc.localDescription.sdp.match(/a=mid:(\S+)/)[1]));
  clearTimeout(timer);
  timer = setTimeout(fail, 20000);
}

async function createCode() {
  showCode(null, 'offer');
  const code = await makeOffer();
  if (code) showCode(code, 'offer');
}

async function useCode(text) {
  const code = decodeURIComponent(text.trim().split('#').pop());
  if (!code) return;
  try {
    if (code[0] === 'o') {
      if (code === myCode) return;
      decode(code);
      showCode(null, 'answer');
      const reply = await makeAnswer(code);
      if (reply) showCode(reply, 'answer');
    } else {
      if (pc?.signalingState !== 'have-local-offer') return say("That's a reply code. Enter it on the device that showed the first QR code.", true);
      await takeAnswer(code);
      say('Connecting…');
    }
  } catch {
    say("That code didn't work. Check you copied all of it.", true);
  }
}

// Back to the start screen, dropping any half-made connection.
function reset(msg) {
  clearTimeout(timer);
  if (!connected) { pc?.close(); pc = dc = myCode = null; }
  view('start', msg);
}

function opened() {
  connected = true;
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
  $('sas').replaceChildren('Connected. Check both screens show the same number:',
    el('b', { textContent: String(n).padStart(6, '0').replace(/^.../, '$& ') }),
    el('small', { textContent: "If they differ, disconnect: you're linked to some other device." }));
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
}

function dropped(msg = 'Disconnected. Connect again to carry on; unfinished transfers will resume.') {
  if (!connected) return;
  connected = false;
  route = '';
  cur = null;
  queue = [];
  drain();
  for (const o of out.values()) if (o.state === 'sending' || o.state === 'offered') { o.state = 'queued'; dirty.add(o); }
  reset(msg);
}

function fail() {
  reset("Couldn't connect. Put both devices on the same Wi-Fi and try again; some mobile and work networks block direct connections.");
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
  try { const m = JSON.parse(d); if (Object.hasOwn(on, m.t)) on[m.t](m); } catch {}
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
    it.crc = crc32(buf, it.crc);
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
    it.chain.then(() => it.w.close()).then(() => it.state = 'done', () => it.state = 'error').then(() => dirty.add(it));
    return;
  }
  it.blob = new Blob(it.parts);
  it.parts = null;
  it.a = el('a', { href: URL.createObjectURL(it.blob), download: it.path.replace(/[/\\]/g, '_'), textContent: 'Save' });
  it.note.after(' ', it.a);
  if (!it.grp.zip) it.a.click();
  it.state = 'done';
  dirty.add(it);
  groupDone(it.grp);
}

// Once nothing in a batch is still arriving, offer to save it all again, and build the .zip if one was asked for.
function groupDone(grp) {
  if (grp.items.some(it => it.state === 'receiving' || it.state === 'pending')) return;
  if (!grp.items.some(it => it.blob)) return;
  if (!grp.saveBtns) {
    grp.saveBtns = el('div', {},
      el('button', { textContent: 'Download all', onclick: () => saveAll(grp) }), ' ',
      el('button', { textContent: 'Download all as .zip', onclick: () => saveZip(grp) }));
    grp.head.after(grp.saveBtns);
  }
  if (grp.zip) { grp.zip = false; saveZip(grp); }
}

async function saveAll(grp) {
  for (const it of grp.items) if (it.blob) {
    it.a.click();
    await new Promise(r => setTimeout(r, 250)); // browsers drop downloads fired in the same instant
  }
}

function saveZip(grp) {
  const got = grp.items.filter(it => it.blob);
  if (got.reduce((t, it) => t + it.size, 0) >= 0xffffffff || got.length > 0xfffe) return alert('Too large for a .zip (4 GB limit). Use Download all instead.');
  // Name the archive after the folder when everything was sent from one.
  const tops = new Set(got.map(it => it.path.split(/[/\\]/)[0]));
  const name = tops.size === 1 && /[/\\]/.test(got[0].path) ? [...tops][0] : 'websend';
  const a = el('a', { href: URL.createObjectURL(zip(got)), download: name + '.zip' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

// ---------- Zip (stored, no compression) ----------
// Entries reference the received Blobs, so building the archive copies no file data.
const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(buf, crc = 0) {
  const b = new Uint8Array(buf);
  crc = ~crc;
  for (let i = 0; i < b.length; i++) crc = CRC[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function zip(items) {
  const enc = new TextEncoder(), d = new Date(), parts = [], dir = [];
  const time = d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1;
  const date = (d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate();
  let off = 0;
  for (const it of items) {
    const name = enc.encode(it.path.split(/[/\\]/).filter(s => s && s !== '.' && s !== '..').join('/') || 'file');
    const h = new DataView(new ArrayBuffer(30)), c = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x04034b50, true); // local header
    c.setUint32(0, 0x02014b50, true); // central directory entry: same fields, shifted 2 bytes
    c.setUint16(4, 20, true);
    for (const [v, o] of [[20, 4], [0x800, 6], [0, 8], [time, 10], [date, 12]]) { h.setUint16(o, v, true); c.setUint16(o + 2, v, true); } // 0x800: UTF-8 names
    for (const [v, o] of [[it.crc ?? 0, 14], [it.size, 18], [it.size, 22]]) { h.setUint32(o, v, true); c.setUint32(o + 2, v, true); }
    h.setUint16(26, name.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    parts.push(h, name, it.blob);
    dir.push(c, name);
    off += 30 + name.length + it.size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, items.length, true);
  end.setUint16(10, items.length, true);
  end.setUint32(12, dir.reduce((t, x) => t + x.byteLength, 0), true);
  end.setUint32(16, off, true);
  return new Blob([...parts, ...dir, end], { type: 'application/zip' });
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

// The connection screens. steps: [labels, current]; show: our QR code; paste: a code box; listen: sound.
const SCREENS = {
  offer: {
    steps: [['Show code', 'Enter reply', 'Connected'], 0], show: true, next: 'Next: enter their reply',
    title: 'Scan this with the other device', hint: 'Open the camera app on the other device and point it at the code. No camera? Copy or share the link to it instead.',
  },
  reply: {
    steps: [['Show code', 'Enter reply', 'Connected'], 1], paste: true, alt: ['Show my code again', () => view('offer')],
    title: 'Enter their reply', hint: "The other device now shows a reply code. Scan it with this device's camera, or paste the link or code it sent you.",
  },
  answer: {
    steps: [['Scan code', 'Send reply', 'Connected'], 1], show: true,
    title: 'Now send this reply back', hint: "Scan it with the first device's camera, or copy or share the link to it. You're connected as soon as it goes in.",
  },
  join: {
    paste: true, alt: ['Show a QR code instead', () => createCode()],
    title: 'Enter the code', hint: "Paste the link or code from the other device. (Scanning its QR code with this device's camera app works too.)",
  },
  sound: {
    listen: true, alt: ['Not working? Use a QR code instead', () => createCode()],
    title: 'Connect by sound', hint: 'Now tap “Connect by sound” on the other device too. Keep them close, with the volume up.',
  },
};

function view(s, msg) {
  screen = s;
  const c = SCREENS[s];
  $('start').hidden = s !== 'start';
  $('flow').hidden = !c;
  $('main').hidden = $('hangup').hidden = s !== 'connected';
  if (!c) soundOff();
  if (c) {
    const [labels, at] = c.steps || [[]];
    $('steps').hidden = !c.steps;
    $('steps').replaceChildren(...labels.map((t, i) => el('li', { textContent: t, className: i < at ? 'done' : i === at ? 'on' : '' })));
    $('title').textContent = c.title;
    $('hint').textContent = c.hint;
    $('show').hidden = !c.show;
    $('pasteForm').hidden = !c.paste;
    $('listen').hidden = !c.listen && !audio;
    $('soundToggle').hidden = !!c.listen;
    $('soundToggle').textContent = audio ? 'Stop sound' : 'Also use sound';
    $('next').hidden = !c.next;
    $('next').textContent = c.next || '';
    $('alt').hidden = !c.alt;
    $('alt').textContent = c.alt?.[0] || '';
    if (c.paste && !matchMedia('(pointer: coarse)').matches) $('paste').focus();
  }
  $('sendText').disabled = s !== 'connected';
  say(msg || {
    offer: 'Waiting for the other device…', reply: 'Waiting for their reply…', answer: 'Waiting for the first device to take your reply…',
    connected: 'Connected', handed: 'Code passed to your other WebSend tab. Switch to it; you can close this one.',
  }[s], !!msg && s === 'start');
}

// code = null shows the screen while the code is still being made.
function showCode(code, type) {
  $('making').hidden = !!code;
  $('qr').hidden = $('link').hidden = $('codeBtns').hidden = !code;
  view(type);
  if (!code) return;
  if (rx) broadcast(code);
  const link = location.href.split('#')[0] + '#' + code;
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
  grp.ul.append(el('li', {}, `${it.path} · ${fmt(it.size)} `, it.note, it.bar));
  grp.items.push(it);
  it.grp = grp;
  grp.total += it.size;
  grp.head.textContent = `${grp.title}: ${grp.items.length} file${grp.items.length > 1 ? 's' : ''} · ${fmt(grp.total)}`;
  dirty.add(it);
}

function askAccept(g, items) {
  let grp = groups.get(g);
  if (!grp) {
    grp = group('↓ Incoming');
    const b = (label, mode) => el('button', { textContent: label, onclick: () => respond(grp, mode) });
    grp.btns = el('div', {}, b('Download', 'dl'), ' ', b('Download as .zip', 'zip'), ' ', ...(window.showDirectoryPicker ? [b('Save to folder…', 'dir'), ' '] : []), b('Decline', 'no'));
    grp.head.after(grp.btns);
    groups.set(g, grp);
  }
  items.forEach(it => addRow(grp, it));
  grp.btns.hidden = false;
}

async function respond(grp, mode) {
  let folder = null;
  if (mode === 'dir') try { folder = await showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  const items = grp.items.filter(it => it.state === 'pending');
  grp.zip = mode === 'zip';
  items.forEach(it => {
    Object.assign(it, { state: mode === 'no' ? 'declined' : 'receiving', folder, parts: [], pend: 0 });
    dirty.add(it);
  });
  if (mode === 'no') sendIn({ t: 'decline' }, 'ids', items.map(it => it.id));
  else sendIn({ t: 'accept' }, 'files', items.map(it => [it.id, 0]));
  grp.btns.hidden = true;
}

const LABEL = { queued: 'waiting for connection', offered: 'waiting for them to accept', pending: '', declined: 'declined', error: 'failed' };
function paint(it) {
  const done = it.state === 'done';
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

$('goShow').onclick = createCode;
$('goJoin').onclick = () => view('join');
$('goSound').onclick = soundOn;
$('soundToggle').onclick = soundToggle;
$('back').onclick = () => screen === 'reply' ? view('offer') : reset();
$('next').onclick = () => view('reply');
$('alt').onclick = () => SCREENS[screen].alt[1]();
$('hangup').onclick = () => { const p = pc; dropped('Disconnected.'); p?.close(); };
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

// ---------- Sound ----------
// Sound works two ways. On the start screen, both devices tap "Connect by sound": each makes an offer and plays it (sound.js turns codes into tones),
// staying quiet while the other is talking. A device that hears an offer answers it by sound. When both
// are offering, only the one whose own code sorts higher answers, so they never both answer.
// On any code screen, "Also use sound" plays the code shown there and listens for the other device's,
// so methods can be mixed: scan the QR code with a phone, then let the phone chirp its reply to the PC.
// Anyone in earshot can hear the codes (harmless) or answer first; the number shown on connect catches that.
const wait = ms => new Promise(r => setTimeout(r, ms));
let audio, mic, rx, osc = [], sending = null, answered = null;

function soundMsg(msg, sub = '') {
  $('soundMsg').textContent = msg;
  $('soundSub').textContent = sub;
}

// "Connect by sound" on the start screen: both devices tap it and find each other.
async function soundOn() {
  view('sound');
  if (!await startAudio()) return;
  soundMsg('Getting ready…');
  const code = await makeOffer();
  await wait(Math.random() * 2000); // if both were tapped together, one usually starts first
  if (code && rx && !answered && myCode === code) broadcast(code);
}

// "Also use sound" on a code screen: plays the code shown, and listens for the other device's.
async function soundToggle() {
  if (audio) { soundOff(); return view(screen); }
  view(screen);
  if (!await startAudio()) return;
  view(screen);
  if (SCREENS[screen].show && myCode) broadcast(myCode);
  else soundMsg('Listening for the other device…', 'Turn on sound on it too.');
}

// Microphone in, speaker out. Returns false if the microphone can't be used.
async function startAudio() {
  soundMsg('Allow the microphone if asked', 'It only listens for the other device, and stops once you are connected.');
  $('listen').hidden = false;
  const ctx = audio = new AudioContext(); // made during the tap, so the browser lets it play sound
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (audio !== ctx) { mic.getTracks().forEach(t => t.stop()); return false; } // left the screen meanwhile
    let src;
    try { src = audio.createMediaStreamSource(mic); } catch { // Firefox: must match the microphone's sample rate
      audio.close();
      audio = new AudioContext({ sampleRate: mic.getAudioTracks()[0].getSettings().sampleRate });
      src = audio.createMediaStreamSource(mic);
    }
    await audio.resume();
    await audio.audioWorklet.addModule('tap.js');
    const tap = new AudioWorkletNode(audio, 'tap'), sink = audio.createGain();
    sink.gain.value = 0; // routed to the speakers silently, so every browser keeps the tap running
    src.connect(tap).connect(sink).connect(audio.destination);
    rx = Sound.receiver(audio.sampleRate, heard, (s, f) => {
      if (s === 'hearing') soundMsg(`Hearing the other device… ${Math.round(f * 100)}%`);
      else soundMsg("Didn't catch all of that", 'Listening again. Move the devices closer or turn the volume up.');
    });
    tap.port.onmessage = e => rx?.push(e.data);
  } catch {
    const msg = "Couldn't use the microphone. Allow it for this site in the browser's settings, or connect with a QR code instead.";
    if (screen === 'sound') reset(msg);
    else if (audio === ctx) { soundOff(); view(screen); say(msg, true); }
    return false;
  }
  return true;
}

async function heard(code) {
  if (!SCREENS[screen]) return;
  const offering = pc?.signalingState === 'have-local-offer' && myCode?.[0] === 'o';
  if (code[0] !== 'o') {
    if (!offering) return;
    stopSending();
    soundMsg('Heard the reply. Connecting…');
    return takeAnswer(code).catch(() => soundMsg("That reply didn't work", 'Still listening…'));
  }
  if (code === answered || code === lastOffer || offering && code >= Sound.norm(myCode)) return; // a repeat, or it's their job to answer ours
  answered = code;
  stopSending();
  soundMsg('Heard the other device. Replying…');
  try {
    const reply = await makeAnswer(code);
    if (!reply || !rx) return;
    if (screen === 'sound') broadcast(reply); else showCode(reply, 'answer'); // showCode plays it too
  } catch { answered = null; }
}

// Plays the code over and over until stopped, staying quiet while the other device is talking.
async function broadcast(code) {
  stopSending();
  const me = sending = {}, tones = Sound.frame(code), offer = code[0] === 'o';
  while (sending === me) {
    if (rx.busy()) { await wait(200); continue; }
    soundMsg(offer ? 'Calling the other device…' : 'Sending the reply…', "Those chirps are the code.");
    await play(tones);
    if (sending !== me) return;
    soundMsg(offer ? 'Listening for the other device…' : 'Waiting for the other device to hear the reply…',
      !offer ? '' : screen === 'sound' ? 'Tap “Connect by sound” on it too.' : 'Turn on sound on it too.');
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
  rx.mute((end - audio.currentTime + (audio.outputLatency || 0)) * 1000 + 300); // don't decode our own sound or its echo
  return new Promise(r => os[0].onended = r);
}

function stopSending() {
  sending = null;
  osc.forEach(o => { try { o.stop(); } catch {} });
  osc = [];
}

function soundOff() {
  stopSending();
  mic?.getTracks().forEach(t => t.stop());
  audio?.close();
  audio = mic = rx = answered = null;
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
