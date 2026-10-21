// ---------- Transfer list ----------
// The files and text sent and received, as rows on the page, and the ways to add files to send.
import { $, el, fmt, rid } from './util.js';
import { on, send, sendIn } from './protocol.js';
import { connected, checked, theyOk, stall, route, ready } from './peer.js';
import { out, inc, dirty, moved, LIVE, offer, hold, cancel } from './transfer.js';
import { finish, saveEach, zipReady } from './save.js';
import { TAB, owned, disk, rpc, remember, forget } from './storage.js';
import { say } from './connect.js';

const groups = new Map();

export function group(title) {
  const head = el('span'), ul = el('ul'), li = el('li', {}, head, ul);
  $('log').prepend(li);
  return { title, head, ul, items: [], total: 0 };
}

export function addRow(grp, it) {
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
export function askAccept(g, items, title = '↓ Incoming') {
  let grp = groups.get(g);
  if (!grp) {
    grp = group(title);
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
  const to = folder ? 'folder' : await disk ? 'disk' : 'mem';
  if (to === 'disk' && mode !== 'no') {
    const need = items.reduce((t, it) => t + it.size, 0), { quota, usage } = await navigator.storage.estimate().catch(() => ({}));
    if (need > quota - usage) {
      say(`Not enough space: these need ${fmt(need)} but the browser can store ${fmt(Math.max(quota - usage, 0))} more.` +
        (window.showDirectoryPicker ? ' Save to a folder instead, or pick fewer files.' : ' Free up space or pick fewer files.'), true);
      return false;
    }
  }
  items.forEach(it => {
    Object.assign(it, { state: mode === 'no' ? 'declined' : 'receiving', folder, to, dir: TAB, name: rid(), auto: mode === 'dl', segs: new Map(), v: 0, bad: 0 });
    dirty.add(it);
  });
  if (mode === 'no') sendIn({ t: 'decline' }, 'ids', items.map(it => it.id));
  else {
    sendIn({ t: 'accept' }, 'files', items.map(it => [it.id, 0]));
    items.filter(it => !it.size).forEach(finish); // an empty file has nothing to wait for
  }
  return true;
}

const LABEL = { queued: 'waiting for connection', offered: 'waiting for them to accept', pending: '', declined: 'declined', error: 'failed', cancelled: 'cancelled', missing: 'add it again to carry on' };
function paint(it) {
  const done = it.state === 'done', live = LIVE.includes(it.state);
  if (it.save) it.save.hidden = it.state !== 'pending';
  it.pause.hidden = !live;
  it.stop.hidden = !live && it.state !== 'missing';
  it.pause.textContent = it.held ? 'Resume' : 'Pause';
  it.bar.value = done ? 1 : it.size ? it.n / it.size : 0;
  it.note.textContent = done ? (it.up ? 'sent ✓' : 'received ✓') : live && it.held ? 'paused'
    : LABEL[it.state] ?? Math.floor(it.bar.value * 100) + '%' + pace(it.size - it.n, it.bps, it.ticks);
}

// Speed and time left. Speeds are measured every tick and averaged over a few seconds, and shown only once they've
// been measured for two, so the time left doesn't jump about.
const TICK = 500;
const MOVING = ['sending', 'receiving'];
const avg = (old, now) => old === undefined ? now : old * 0.8 + now * 0.2;
const pace = (left, bps, ticks) => ticks >= 2000 / TICK && bps >= 1 ? ` · ${fmt(Math.round(bps))}/s · ${until(left / bps)}` : '';
function until(s) {
  const m = Math.ceil(s / 60);
  return s < 60 ? `${Math.ceil(s)} s left` : m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
}

// The overall bar covers every file that's moved since the last time none were, so it doesn't jump back as each
// file finishes. It also goes in the tab's title, to follow from another tab.
const run = new Set(), all = { ticks: 0 };
let lastMoved = 0;
function overall() {
  const files = [...out.values(), ...inc.values()];
  for (const it of files) {
    if (!MOVING.includes(it.state) || it.held) { it.bps = it.was = it.ticks = undefined; continue; }
    if (it.was !== undefined) it.bps = avg(it.bps, Math.max(it.n - it.was, 0) * 1000 / TICK);
    it.was = it.n;
    it.ticks = (it.ticks || 0) + 1;
    run.add(it);
    dirty.add(it);
  }
  for (const it of run) if (!MOVING.includes(it.state) && it.state !== 'done') run.delete(it); // cancelled, declined or failed
  if (!files.some(it => MOVING.includes(it.state))) run.clear();
  const going = [...run].some(it => MOVING.includes(it.state) && !it.held);
  if (!going) { all.bps = undefined; all.ticks = 0; } else if (all.ticks++) all.bps = avg(all.bps, (moved - lastMoved) * 1000 / TICK); // the first tick only part moved
  lastMoved = moved;
  $('total').hidden = !run.size;
  if (!run.size) return void (document.title = 'WebSend');
  let size = 0, got = 0;
  for (const it of run) { size += it.size; got += it.state === 'done' ? it.size : Math.min(it.n, it.size); }
  $('totalBar').value = size ? got / size : 1;
  document.title = `${Math.floor($('totalBar').value * 100)}% · WebSend`;
  $('totalText').textContent = `${fmt(got)} of ${fmt(size)}` + (going ? pace(size - got, all.bps, all.ticks) : ' · paused');
}

setInterval(() => {
  overall();
  dirty.forEach(it => { paint(it); remember(it); });
  dirty.clear();
  if (connected) say(stall ? 'Connection interrupted. Trying to reconnect…' : checked && !theyOk ? 'Connected. Waiting for the other device to confirm the number…'
    : 'Connected' + route, !!stall);
}, TICK);

// A deliberate disconnect forgets every transfer, unlike a dropped connection, which keeps them to resume,
// and removes every file this tab stored.
export function clearFiles() {
  for (const it of inc.values()) { if (it.a) URL.revokeObjectURL(it.a.href); if (it.grp.zipOut?.href) URL.revokeObjectURL(it.grp.zipOut.href); }
  [...out.values(), ...inc.values()].forEach(forget);
  owned.forEach(dir => rpc('rm', { dir }).catch(() => {}));
  out.clear(); inc.clear(); groups.clear(); dirty.clear();
  $('log').replaceChildren();
}

// ---------- Text ----------
function textEntry(dir, v) {
  const body = /^https?:\/\/\S+$/.test(v) ? el('a', { href: v, textContent: v, target: '_blank', rel: 'noopener noreferrer' }) : el('pre', { textContent: v });
  $('log').prepend(el('li', {}, `${dir} Text `, el('button', { textContent: 'Copy', onclick: () => navigator.clipboard?.writeText(v) }), el('br'), body));
}
Object.assign(on, { text({ v }) { textEntry('↓', String(v)); } });
$('textForm').onsubmit = e => {
  e.preventDefault();
  const v = $('text').value;
  if (!v || !ready()) return;
  send({ t: 'text', v });
  textEntry('↑', v);
  $('text').value = '';
};

// ---------- Files in ----------
// A file that was being sent before a reload takes its old place when it's added again, so it resumes.
function addFiles(list) { // [[File, relativePath]]
  if (!list.length) return;
  let grp;
  const fresh = list.map(([file, path]) => {
    const old = [...out.values()].find(o => o.state === 'missing' && o.path === path && o.size === file.size && o.mod === file.lastModified);
    if (old) return Object.assign(old, { file, state: 'queued' }), dirty.add(old), old;
    const o = { id: rid(), file, path, size: file.size, mod: file.lastModified, dir: TAB, n: 0, state: 'queued', up: true };
    out.set(o.id, o);
    addRow(grp ||= group('↑ Sending'), o);
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
