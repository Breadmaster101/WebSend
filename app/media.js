// ---------- Sound and camera ----------
// Each runs only while the screen needs it: the speaker after the user taps Play sound on a code sent by sound,
// the microphone on a "listen" screen, the camera on a "scan" screen. Playing never needs the microphone.
// sound.js turns codes into tones. Anyone in earshot can hear them (harmless) or answer first; the number check catches that.
import { $, why, wait } from './util.js';
import { log } from './log.js';
import { myCode, lastOffer } from './peer.js';
import { screen, sendM, getM, chirping, useCode } from './connect.js';

export let audio;
let ear = null, cam = null, rx, osc = [], sending = null, lastHeard = null;

export function syncMedia() {
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
// After Start over, the same code counts again.
export const forgetHeard = () => lastHeard = null;

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
