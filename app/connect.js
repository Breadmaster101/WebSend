// ---------- Connection screens ----------
// After start or join, each device answers one question per direction: how its code goes to the other device, and
// how it takes in the other's. The three methods are listed alike and none is picked in advance, so the invite and
// the reply can travel different ways.
//   ask:  the question that fits (send the invite / get the invite / send the reply / get the reply)
//   give: this device's code in the method picked
//   get:  scan, paste or listen for the other device's code
// Starter: ask → give → ask → get. Joiner: ask → get → ask → give.
import { $, el, why } from './util.js';
import { log, problems } from './log.js';
import { decode } from './code.js';
import { pc, myCode, checked, ready, probe, makeOffer, makeAnswer, takeAnswer, abandon, confirm, hangup } from './peer.js';
import { audio, syncMedia, forgetHeard } from './media.js';

// role: 'starting' | 'joining'. replying: the joiner has taken in the invite. toReply: the starter moved on to getting
// the reply. sendM / getM: how this device gives its code and takes in the other's ('qr' | 'link' | 'sound').
// chirping: the user tapped Play sound. screen: what view() last showed.
export let role = null, replying = false, toReply = false, sendM = null, getM = null, chirping = false, screen;

export function say(msg, alert = false) {
  $('status').textContent = msg || '';
  $('status').classList.toggle('alert', alert);
}

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

export function view(s, msg) {
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

// What this device's code and the other device's say about their networks (see problems() in log.js). It shows on
// every connection screen, so a network that can't reach others is known before any code is swapped.
const net = { mine: [], theirs: [] };
const TELL = {
  none: w => `${w} has no network connection WebSend can use. Check that it's online.`,
  local: w => `${w} got no public address from its network, so only a device on the same network can connect to it.`,
  symmetric: w => `${w}'s network changes its public port for each connection (symmetric NAT, common on school, work and mobile networks), so devices on other networks usually can't connect to it.`,
  warp: w => `${w} is using Cloudflare WARP, which blocks connections from other networks. Turn WARP off on it.`,
};
function noteNet(whose, code) {
  // Devices that already found each other stop looking for a public address, so its absence means nothing then.
  net[whose] = code ? problems(code).filter(([p]) => p !== 'local' || pc?.iceConnectionState !== 'connected') : [];
  const found = [...net.mine.map(([p]) => TELL[p]('This device')), ...net.theirs.map(([p]) => TELL[p]('The other device'))];
  if ([...net.mine, ...net.theirs].some(([p]) => p !== 'none')) found.push("Putting both devices on the same Wi-Fi (or one phone's hotspot) gets around this.");
  $('net').replaceChildren(...found.map((t, i) => el('p', {}, ...(i ? [] : [el('b', { textContent: 'Network check: ' })]), t)));
  $('net').hidden = !found.length;
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
  noteNet('mine', myCode);
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

// The invite is made while the user picks how to send it, so it's usually ready by the time it's shown.
async function createCode() {
  if (await makeOffer()) showCode();
}

// Takes in a code from any method. An invite makes this device the joiner, whatever it was doing before.
export async function useCode(text) {
  const code = decodeURIComponent(text.trim().split('#').pop());
  if (!code) return;
  try {
    if (code[0] === 'o') {
      if (code === myCode) return say("That's this device's own invite. Use it on the other device.", true);
      decode(code);
      noteNet('theirs', code);
      role = 'joining';
      replying = true;
      toReply = false;
      sendM = null;
      view('ask');
      if (await makeAnswer(code)) showCode();
    } else {
      if (pc?.signalingState !== 'have-local-offer') return log(`Got a reply while ${pc ? pc.signalingState : 'no connection was started'}`, 'warn'), say("That's a reply. Enter it on the device that started the connection.", true);
      await takeAnswer(code);
      noteNet('theirs', code);
      say('Connecting…');
    }
  } catch (e) {
    noteNet('theirs');
    log(`Couldn't use the code "${code.slice(0, 40)}${code.length > 40 ? '…' : ''}" (${code.length} characters): ${why(e)}`, 'err');
    say("That code didn't work. Check you copied all of it.", true);
  }
}

// Back to the start screen, dropping any half-made connection.
export function reset(msg) {
  abandon();
  role = sendM = getM = null;
  forgetHeard();
  replying = toReply = false;
  noteNet('mine');
  noteNet('theirs');
  view('start', msg);
}

$('goStart').onclick = () => { role = 'starting'; view('ask'); createCode(); };
// The joiner's reply comes only after the invite, so it checks its network straight away instead.
$('goJoin').onclick = async () => {
  role = 'joining';
  view('ask');
  const code = await probe();
  if (role === 'joining' && !myCode) noteNet('mine', code);
};
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
$('sasYes').onclick = confirm;
$('sasNo').onclick = () => hangup("Disconnected because the numbers didn't match, so another device may have answered your invite. Connect again, ideally side by side.");
$('hangup').onclick = () => hangup('Disconnected.');

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
