// Offline check of the sound modem: plays frames through a simulated room (echo, noise,
// mismatched clocks) into the receiver. Run: node test/sound-sim.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { atob, btoa, console };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sound.js'), 'utf8') + ';this.Sound = Sound;', ctx);
const { Sound } = ctx;

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Reed–Solomon sanity: random errors and erasures within capacity are always fixed.
for (let t = 0; t < 300; t++) {
  const msg = Array.from({ length: 40 + (t % 90) }, () => rnd() * 256 | 0), cw = Sound.rsEncode(msg), bad = cw.slice();
  const ne = t % 13, nx = Math.min(24 - 2 * ne, t % 25), pos = [...cw.keys()].sort(() => rnd() - 0.5);
  pos.slice(0, ne + nx).forEach(p => bad[p] ^= 1 + (rnd() * 255 | 0));
  const out = Sound.rsDecode(bad, pos.slice(ne, ne + nx));
  if (!out || out.join() !== cw.join()) throw new Error(`RS failed: ${ne} errors, ${nx} erasures`);
}
console.log('Reed–Solomon ok');

const codes = [
  'oAb3d,Kq9vT2mWx7Yz1+Pr/Lc4Hs8N,' + 'q'.repeat(42) + 'A,h1f0a2b3c-1d2e-4f50-8a9b-0c1d2e3f4a5b.local_54321,h9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0.local_50000,s203.0.113.7_61234,s2001:db8::42_55555',
  'p1a2b3c4d,0123456789abcdef0123456789abcdef,' + 'Z'.repeat(42) + 'g,h192.168.1.20_40000,h10.0.0.5_40001,hfe80::1_40002,s198.51.100.9_40003',
];
for (const c of codes) if (Sound.norm(Sound.norm(c)) !== Sound.norm(c)) throw new Error('pack round trip');
console.log('pack ok:', codes.map(c => Sound.frame(c).length * Sound.SYM + ' s').join(', '));

function synth(tones, rate, drift, amp) { // phase-continuous FSK like an OscillatorNode
  const n = Sound.SYM * rate * drift, out = new Float32Array(Math.ceil(tones.length * n)), ramp = 0.01 * rate;
  const ph = [0, 0];
  for (let i = 0; i < out.length; i++) {
    const f = Sound.freqs(tones[Math.min(tones.length - 1, i / n | 0)]);
    f.forEach((x, j) => { ph[j] += 2 * Math.PI * x / rate; out[i] += amp * Math.sin(ph[j]); });
    out[i] *= Math.min(1, i / ramp, (out.length - i) / ramp);
  }
  return out;
}

function room(x, rate, reverb) { // direct path + early reflections + decaying tail, frequency-selective
  const taps = [[0, 1]];
  for (let i = 0; i < 6; i++) taps.push([(0.002 + rnd() * 0.02) * rate | 0, (rnd() - 0.5) * reverb * 1.2]);
  for (let i = 0; i < 250; i++) { const d = rnd() * 0.4; taps.push([d * rate | 0, gauss() * reverb * 0.12 * Math.exp(-d / 0.08)]); }
  const y = new Float32Array(x.length + rate * 0.4 | 0);
  for (const [d, g] of taps) for (let i = 0; i < x.length; i++) y[i + d] += g * x[i];
  return y;
}

function trial({ rate, drift, snr, reverb, repeats }) {
  const code = codes[rnd() * codes.length | 0], tones = Sound.frame(code);
  let got = null;
  const rx = Sound.receiver(rate, c => got = got || c);
  const sig = room(synth(tones, rate, drift, 0.3), rate, reverb);
  const noise = 0.3 / Math.sqrt(2) / 10 ** (snr / 20);
  const feed = (x, len) => { for (let i = 0; i < len; i += 128) rx.push(Float32Array.from({ length: 128 }, (_, j) => (x ? x[i + j] || 0 : 0) + noise * gauss())); };
  feed(null, rate * rnd() | 0);
  for (let r = 0; r < repeats && !got; r++) { feed(sig, sig.length); feed(null, rate * 1.5 | 0); }
  return got === Sound.norm(code);
}

const runs = +process.argv[2] || 12;
for (const cond of [
  { rate: 48000, drift: 1, snr: 20, reverb: 0.3 },
  { rate: 44100, drift: 1.0001, snr: 10, reverb: 0.5 },
  { rate: 48000, drift: 0.9999, snr: 3, reverb: 0.5 },
  { rate: 48000, drift: 1, snr: 0, reverb: 0.8 },
  { rate: 44100, drift: 1.0002, snr: -3, reverb: 0.8 },
]) {
  for (const repeats of [1, 3]) {
    let ok = 0;
    for (let i = 0; i < runs; i++) ok += trial({ ...cond, repeats });
    console.log(JSON.stringify(cond), `repeats ${repeats}: ${ok}/${runs}`);
  }
}

{ // Noise alone never yields a code; a new message after another one isn't mixed up with it.
  const rate = 48000, heard = [], rx = Sound.receiver(rate, c => heard.push(c));
  for (let i = 0; i < rate * 20; i += 128) rx.push(Float32Array.from({ length: 128 }, () => 0.1 * gauss()));
  for (const c of [codes[0], codes[0], codes[1], codes[1]]) {
    const s = room(synth(Sound.frame(c), rate, 1, 0.3), rate, 0.5);
    for (let i = 0; i < s.length + rate; i += 128) rx.push(Float32Array.from({ length: 128 }, (_, j) => (s[i + j] || 0) + 0.01 * gauss()));
  }
  const want = [codes[0], codes[0], codes[1], codes[1]].map(Sound.norm).join();
  console.log('noise + message switch:', heard.join() === want ? 'ok' : 'FAILED ' + heard.length);
}
