// WebSend: serverless peer-to-peer file transfer over WebRTC.
// There is no signaling server. The two browsers swap a short code by hand (QR, link or paste).
// A code holds only what WebRTC needs: ICE credentials, the DTLS certificate fingerprint
// (which authenticates the encrypted channel) and network addresses.
//
// The parts, roughly in the order a session uses them:
//   connect.js   the connection screens          media.js     sound and camera, for swapping codes
//   code.js      connection code <-> SDP         peer.js      the connection, and both users confirming the number
//   sas.js       the number both screens show    protocol.js  the main channel and its messages
//   lanes.js     extra connections for speed     transfer.js  offering files and moving their bytes
//   save.js      where received files go         storage.js   browser storage, and resuming after a crash
//   list.js      the files and text on the page  log.js       the connection log
//   config.js    settings                        util.js      small helpers
import { rid } from './util.js';
import { pc, myCode, connected } from './peer.js';
import { out, inc } from './transfer.js';
import { TAB } from './storage.js';
import { view, useCode } from './connect.js';

// Keep the screen on while the page is visible; the browser drops the lock whenever it's hidden.
let wake;
const keepAwake = () => document.visibilityState === 'visible' && !wake && navigator.wakeLock?.request('screen')
  .then(l => { wake = l; l.addEventListener('release', () => wake = null); }, () => {});
document.addEventListener('visibilitychange', keepAwake);
addEventListener('focus', keepAwake);
addEventListener('pointerdown', keepAwake); // some browsers refuse the lock until the user interacts
keepAwake();

addEventListener('beforeunload', e => {
  if (connected || [...out.values(), ...inc.values()].some(x => x.state === 'sending' || x.state === 'receiving')) e.preventDefault();
});

// ---------- Tab handoff ----------
// Scanning a WebSend QR with the phone camera opens a new tab. That tab hands the code to an
// existing WebSend tab that needs it (one waiting for a reply, or one with transfers to resume).
const bc = new BroadcastChannel('websend');
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
