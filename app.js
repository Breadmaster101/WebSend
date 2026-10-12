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
let pc, dc, myCode, timer, wake, cur = null, connected = false, queue = [], pumping = false, drain = () => {}, moved = 0;

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

async function createCode() {
  newPeer();
  await pc.setLocalDescription();
  showCode(await gathered(pc), 'offer');
}

async function useCode(text) {
  const code = decodeURIComponent(text.trim().split('#').pop());
  if (!code) return;
  try {
    if (code[0] === 'o') {
      if (code === myCode) return;
      newPeer();
      await pc.setRemoteDescription(decode(code));
      await pc.setLocalDescription();
      showCode(await gathered(pc), 'answer');
      timer = setTimeout(fail, 120000);
    } else {
      if (pc?.signalingState !== 'have-local-offer') return say('That is a reply code. Create a code first, or paste the code you were sent.');
      await pc.setRemoteDescription(decode(code, pc.localDescription.sdp.match(/a=mid:(\S+)/)[1]));
      say('Connecting…');
      timer = setTimeout(fail, 20000);
    }
  } catch {
    say('Invalid code. Check you copied all of it.');
  }
}

function opened() {
  connected = true;
  clearTimeout(timer);
  view('connected');
  showSas(pc);
  offer([...out.values()].filter(o => o.state !== 'done' && o.state !== 'declined'));
}

// Both screens show the same number only if each device holds the key the other expected. A match rules out
// anyone who swapped in their own code (answered a sound code first, or tampered with a message).
async function showSas(p) {
  const fps = [p.localDescription, p.remoteDescription].map(d => d.sdp.match(/a=fingerprint:\S+ (\S+)/)[1].toUpperCase()).sort();
  const n = new DataView(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fps.join()))).getUint32(0) % 1e6;
  $('sas').textContent = `Check both screens show ${String(n).padStart(6, '0').replace(/^.../, '$& ')}`;
}

function dropped() {
  if (!connected) return;
  connected = false;
  cur = null;
  queue = [];
  drain();
  for (const o of out.values()) if (o.state === 'sending' || o.state === 'offered') { o.state = 'queued'; dirty.add(o); }
  view('idle', 'Disconnected. Make a new code to reconnect. Unfinished transfers will resume.');
}

function fail() {
  clearTimeout(timer);
  pc?.close();
  pc = dc = null;
  view('idle', "Couldn't connect directly. Same Wi-Fi usually works; some mobile and work networks block peer-to-peer. Make a new code to retry.");
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
  const a = el('a', { href: URL.createObjectURL(new Blob(it.parts)), download: it.path.replace(/[/\\]/g, '_'), textContent: 'Save' });
  it.parts = null;
  it.note.after(' ', a);
  a.click();
  it.state = 'done';
  dirty.add(it);
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
function say(msg) { $('status').textContent = msg; }

function view(s, msg) {
  $('hs').hidden = s === 'connected' || s === 'handed';
  $('main').hidden = s === 'handed';
  $('show').hidden = s !== 'offer' && s !== 'answer';
  $('pasteForm').hidden = s === 'answer';
  $('create').textContent = s === 'idle' ? 'Create connection code' : 'Start over';
  $('step').textContent = s === 'offer' ? '1. Scan this with the other device, or send it the link or code.'
    : 'Reply: send this back. The sender scans the QR or pastes the link or code.';
  $('pasteLabel').textContent = s === 'offer' ? "2. Paste their reply here (or scan their QR with this device's camera):"
    : 'Received a code? Paste it here:';
  $('sendText').disabled = s !== 'connected';
  $('sas').hidden = s !== 'connected';
  if (s === 'connected') soundOff(); else if ($('show').hidden) stopSending();
  say(msg || {
    idle: 'Not connected', offer: 'Waiting for their reply…', answer: 'Waiting for the sender to enter your reply…',
    connected: 'Connected', handed: 'Code passed to your other WebSend tab. Switch to it; you can close this one.',
  }[s]);
}

function showCode(code, type) {
  myCode = code;
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
  view(type);
  if (audio) broadcast(code);
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
  grp.total += it.size;
  grp.head.textContent = `${grp.title}: ${grp.items.length} file${grp.items.length > 1 ? 's' : ''} · ${fmt(grp.total)}`;
  dirty.add(it);
}

function askAccept(g, items) {
  let grp = groups.get(g);
  if (!grp) {
    grp = group('↓ Incoming');
    const b = (label, mode) => el('button', { textContent: label, onclick: () => respond(grp, mode) });
    grp.btns = el('div', {}, b('Download', 'dl'), ' ', ...(window.showDirectoryPicker ? [b('Save to folder…', 'dir'), ' '] : []), b('Decline', 'no'));
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
  if (connected) say('Connected' + (moved > lastMoved ? ` · ${fmt((moved - lastMoved) * 2)}/s` : ''));
  lastMoved = moved;
}, 500);

$('create').onclick = createCode;
$('sound').onclick = () => audio ? soundOff() : soundOn();
$('pasteForm').onsubmit = e => { e.preventDefault(); useCode($('paste').value); $('paste').value = ''; };
$('paste').addEventListener('paste', () => setTimeout(() => { useCode($('paste').value); $('paste').value = ''; }));
// Copies the whole link, or just the code after '#'. Falls back to selecting it in the link box.
const copy = codeOnly => {
  const link = $('link').value, text = codeOnly ? myCode : link;
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  $('link').setSelectionRange(link.length - text.length, link.length);
  document.execCommand('copy');
};
$('copy').onclick = () => copy(false);
$('copyCode').onclick = () => copy(true);
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
// Optional way to pass the same code between devices in one room. The code is packed to bytes and sent
// as 16-tone FSK after a sync tone. Odd and even nibbles use separate tone sets, so consecutive symbols
// always differ and runs of one tone mark symbol boundaries. A SHA-256 check drops damaged frames.
// Anyone in earshot can hear the code (harmless) or answer first; the number shown on connect catches that.
const SYM = 0.025, HOP = 4, SYNC = 32;            // 25 ms symbols, decoded 4 times per symbol
const tone = k => (30 + 2 * k) / SYM;             // 1200–3760 Hz, two FFT bins apart
const wait = ms => new Promise(r => setTimeout(r, ms));
const check = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).subarray(0, 4);
let audio, mic, osc, sending = null, heard = 0, muted = 0, got;

// Binary form of a code. Candidate tag: bit 0 = srflx; then a 16-byte mDNS UUID, 4-byte IPv4 (bit 1) or a string (bit 2).
function pack(code) {
  const [ufrag, pwd, fp, ...cands] = code.slice(1).split(',');
  const b = [code.charCodeAt(0)], str = s => b.push(s.length, ...[...s].map(c => c.charCodeAt(0)));
  str(ufrag);
  str(pwd);
  b.push(...unb64(fp));
  for (const c of cands) {
    const [ip, port] = c.slice(1).split('_'), srflx = +(c[0] === 's');
    if (/^[\da-f-]{36}\.local$/.test(ip)) b.push(srflx, ...ip.slice(0, 36).replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)));
    else if (/^(\d+\.){3}\d+$/.test(ip)) b.push(2 | srflx, ...ip.split('.').map(Number));
    else { b.push(4 | srflx); str(ip); }
    b.push(port >> 8, port & 255);
  }
  return Uint8Array.from(b);
}

function unpack(b) {
  let i = 0;
  const take = n => b.subarray(i, i += n), str = () => String.fromCharCode(...take(b[i++]));
  const kind = String.fromCharCode(b[i++]), parts = [str(), str(), b64(take(32))];
  while (i < b.length) {
    const t = b[i++];
    const ip = t & 4 ? str() : t & 2 ? take(4).join('.')
      : [...take(16)].map(x => x.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') + '.local';
    const [hi, lo] = take(2);
    parts.push((t & 1 ? 's' : 'h') + ip + '_' + (hi << 8 | lo));
  }
  return kind + parts.join(',');
}

// Frame: sync tone, then nibbles of [length, payload, 4-byte hash].
async function frame(code) {
  const p = pack(code);
  if (p.length > 255) throw new Error('code too long for sound');
  const bytes = [p.length, ...p, ...await check(p)];
  return [SYNC, SYNC, SYNC, SYNC, ...bytes.flatMap(x => [x >> 4, x & 15]).map((n, i) => n + 16 * (i & 1))];
}

function play(tones) {
  const t0 = audio.currentTime + 0.05, end = t0 + tones.length * SYM, g = audio.createGain();
  const o = osc = audio.createOscillator();
  tones.forEach((k, i) => o.frequency.setValueAtTime(tone(k), t0 + i * SYM));
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.3, t0 + 0.01); // ramps avoid clicks
  g.gain.setValueAtTime(0.3, end - 0.01);
  g.gain.linearRampToValueAtTime(0, end);
  o.connect(g).connect(audio.destination);
  o.start(t0);
  o.stop(end);
  muted = performance.now() + (end - audio.currentTime) * 1000 + 200; // don't decode our own sound or its echo
  return new Promise(r => o.onended = r);
}

// Repeats the code until stopped, staying quiet while the other device is sending.
async function broadcast(code) {
  stopSending();
  const me = sending = {};
  const tones = await frame(code).catch(() => say('This code is too long to send by sound. Use the QR or link.'));
  while (tones && sending === me) {
    if (performance.now() - heard < 500) { await wait(200); continue; }
    await play(tones);
    await wait(1500 + Math.random() * 1500);
  }
}

function stopSending() {
  sending = null;
  osc?.stop();
}

// Returns a function that takes microphone samples and calls onFrame(payload, hash) for each complete frame.
function receiver(rate, onFrame) {
  const n = Math.round(SYM * rate), ring = new Float32Array(n);
  const coef = Array.from({ length: SYNC + 1 }, (_, k) => 2 * Math.cos(2 * Math.PI * tone(k) / rate));
  let pos = 0, fresh = 0, run = -1, len = 0, last = -1, syms = null;
  const commit = k => {
    if (k === last) return; // a glitch split one symbol in two
    last = k;
    if (k === SYNC) return syms = [];
    if (!syms || k >> 4 !== (syms.length & 1)) return syms = null;
    syms.push(k & 15);
    if (syms.length & 1 || syms.length >> 1 !== (syms[0] << 4 | syms[1]) + 5) return;
    const b = Uint8Array.from({ length: syms.length >> 1 }, (_, i) => syms[2 * i] << 4 | syms[2 * i + 1]);
    syms = null;
    onFrame(b.subarray(1, -4), b.subarray(-4));
  };
  return samples => {
    for (const s of samples) {
      ring[pos] = s;
      pos = (pos + 1) % n;
      if (++fresh * HOP < n) continue;
      fresh = 0;
      const e = coef.map(c => { // Goertzel power of each tone over the last symbol
        let a = 0, b = 0;
        for (let i = 0; i < n; i++) { const t = ring[(pos + i) % n] + c * a - b; b = a; a = t; }
        return a * a + b * b - c * a * b;
      });
      const max = Math.max(...e), sum = e.reduce((x, y) => x + y);
      const k = performance.now() < muted || !(max * e.length > 8 * sum) ? -1 : e.indexOf(max);
      if (k < 0) { run = -1; continue; }
      heard = performance.now();
      if (k !== run) { run = k; len = 0; }
      if (++len === 2) commit(k);
    }
  };
}

async function soundOn() {
  try {
    audio = new AudioContext();
    await audio.audioWorklet.addModule('tap.js');
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const tap = new AudioWorkletNode(audio, 'tap', { numberOfOutputs: 0 });
    audio.createMediaStreamSource(mic).connect(tap);
    const push = receiver(audio.sampleRate, async (p, h) => {
      if ((await check(p)).join() !== h.join()) return;
      const code = unpack(p);
      if (code === myCode || code === got) return; // our own echo, or a repeat
      got = code;
      stopSending();
      useCode(code);
    });
    tap.port.onmessage = e => push(e.data);
  } catch {
    soundOff();
    return say("Couldn't use the microphone.");
  }
  $('sound').textContent = 'Stop sound';
  if (!$('show').hidden) broadcast(myCode);
}

function soundOff() {
  stopSending();
  mic?.getTracks().forEach(t => t.stop());
  audio?.close();
  audio = mic = got = null;
  $('sound').textContent = 'Connect by sound';
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

view('idle');
const hash = decodeURIComponent(location.hash.slice(1));
if (hash) {
  history.replaceState(null, '', location.pathname + location.search); // keep codes out of history
  handoff(hash);
}
