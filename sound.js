'use strict';
// Sound modem: carries a connection code between two devices in the same room (app.js drives it).
//
// Frame = 8 sync symbols (two alternating chords), 4 header symbols (the length), then the body: bytes
// protected by Reed–Solomon, sent as 4-bit symbols (16-tone FSK, 25 ms each). Consecutive symbols cycle
// through separate tone sets, so a room's echo of one symbol never looks like the next few.
// The sender repeats the frame. The receiver adds up what it heard across repeats, so in a noisy room
// it simply takes another round or two instead of failing.
const Sound = (() => {
  const SYM = 0.025, SETS = 3, S0 = 16 * SETS, S1 = S0 + 1;
  const PRE = 8, HEAD = 4, PAR = 24, UNIT = 8, MAX = 16 * UNIT - 1;
  // Data tones 1200–4960 Hz, two FFT bins apart at 25 ms. Each sync symbol is a low + high chord, so an
  // echo notch in the room that swallows one frequency can't hide the sync.
  const FREQ = [...Array.from({ length: S0 }, (_, k) => 1200 + 80 * k), 1040, 5120, 1120, 5200];
  const PARTS = k => k < S0 ? [k] : k === S0 ? [S0, S0 + 1] : [S0 + 2, S0 + 3];
  const freqs = k => PARTS(k).map(i => FREQ[i]);
  const sym = (v, m) => v + 16 * (m % SETS); // tone for nibble v at symbol m (counted from the header)
  const bodyLen = h => UNIT * (h + 1) + 2 + PAR;

  // ---------- Reed–Solomon over GF(256): corrects up to PAR/2 bad bytes, or PAR flagged as doubtful ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = x << 1 ^ (x & 128 ? 0x11d : 0); }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
  const inv = a => EXP[255 - LOG[a]];
  const pow2 = i => EXP[(i % 255 + 255) % 255];
  const evalP = (p, x) => p.reduce((y, c) => mul(y, x) ^ c, 0); // polynomials are arrays, highest power first
  const scale = (p, x) => p.map(c => mul(c, x));
  const addP = (p, q) => {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    p.forEach((c, i) => r[i + r.length - p.length] ^= c);
    q.forEach((c, i) => r[i + r.length - q.length] ^= c);
    return r;
  };
  const mulP = (p, q) => {
    const r = new Array(p.length + q.length - 1).fill(0);
    p.forEach((a, i) => q.forEach((b, j) => r[i + j] ^= mul(a, b)));
    return r;
  };
  const rem = (p, q) => { // remainder of p / q, q monic
    const r = p.slice();
    for (let i = 0; i <= p.length - q.length; i++) if (r[i]) for (let j = 1; j < q.length; j++) r[i + j] ^= mul(q[j], r[i]);
    return r.slice(p.length - q.length + 1);
  };
  const GEN = Array.from({ length: PAR }).reduce((g, _, i) => mulP(g, [1, pow2(i)]), [1]);
  const rsEncode = msg => [...msg, ...rem([...msg, ...new Array(PAR).fill(0)], GEN)];

  function rsDecode(cw, erase) { // erase: positions known to be doubtful. Returns the corrected codeword or null.
    const msg = cw.slice(), N = msg.length;
    if (erase.length > PAR) return null;
    erase.forEach(p => msg[p] = 0);
    const synd = [0, ...Array.from({ length: PAR }, (_, i) => evalP(msg, pow2(i)))];
    if (synd.every(s => !s)) return msg;
    const fs = synd.slice(1); // Forney syndromes: the syndromes with the erasures factored out
    for (const p of erase) {
      const x = pow2(N - 1 - p);
      for (let j = 0; j < fs.length - 1; j++) fs[j] = mul(fs[j], x) ^ fs[j + 1];
    }
    let loc = [1], old = [1]; // Berlekamp–Massey: locator of the remaining (unflagged) errors
    for (let i = 0; i < PAR - erase.length; i++) {
      let d = fs[i];
      for (let j = 1; j < loc.length; j++) d ^= mul(loc[loc.length - 1 - j], fs[i - j]);
      old = [...old, 0];
      if (d) {
        if (old.length > loc.length) { const n = scale(old, d); old = scale(loc, inv(d)); loc = n; }
        loc = addP(loc, scale(old, d));
      }
    }
    while (loc.length && !loc[0]) loc.shift();
    const errs = loc.length - 1, rl = loc.slice().reverse(), pos = [];
    if (errs * 2 + erase.length > PAR) return null;
    for (let i = 0; i < N; i++) if (!evalP(rl, pow2(i))) pos.push(N - 1 - i); // Chien search
    if (pos.length !== errs) return null;
    const all = [...erase, ...pos], X = all.map(p => pow2(N - 1 - p)); // Forney: the error values
    const el = X.reduce((l, x) => mulP(l, [x, 1]), [1]);
    const ev = rem(mulP(synd.slice().reverse(), el), [1, ...new Array(el.length).fill(0)]);
    X.forEach((xi, i) => {
      const xin = inv(xi);
      let d = 1;
      X.forEach((xj, j) => { if (j !== i) d = mul(d, 1 ^ mul(xin, xj)); });
      if (d) msg[all[i]] ^= mul(mul(xi, evalP(ev, xin)), inv(d));
    });
    return Array.from({ length: PAR }, (_, i) => evalP(msg, pow2(i))).some(s => s) ? null : msg;
  }

  // ---------- Connection code <-> bytes ----------
  // Code: <kind><ufrag>,<pwd>,<fingerprint b64url>,<candidates: h|s + ip + "_" + port> (see app.js).
  // ICE ufrag/pwd use the base64 alphabet, so they pack at 6 bits a character.
  const bytes = s => [...s].map(c => c.charCodeAt(0));
  const chars = b => String.fromCharCode(...b);
  const hex = (b, w) => [...b].map(x => x.toString(16).padStart(w, '0'));

  function pack(code) {
    const [ufrag, pwd, fp, ...cands] = code.slice(1).split(',');
    const out = [code.charCodeAt(0)];
    for (const s of [ufrag, pwd]) {
      if (!/^[A-Za-z0-9+/]{1,255}$/.test(s)) throw new Error('bad ice');
      out.push(s.length, ...bytes(atob(s.padEnd(Math.ceil(s.length / 4) * 4, 'A'))));
    }
    out.push(...bytes(atob(fp.replace(/-/g, '+').replace(/_/g, '/'))));
    // Most useful candidates first; drop whatever doesn't fit in one frame.
    const list = cands.map(c => {
      const i = c.lastIndexOf('_'), ip = c.slice(1, i), port = +c.slice(i + 1), s = +(c[0] === 's');
      let t = 3, v;
      if (/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}\.local$/.test(ip)) { t = 0; v = ip.slice(0, 36).replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)); }
      else if (/^(\d+\.){3}\d+$/.test(ip)) { t = 1; v = ip.split('.').map(Number); }
      else if (/^[\da-f:]+$/i.test(ip) && (v = v6(ip))) t = 2;
      else v = [ip.length, ...bytes(ip)];
      return { rank: [1, 0, 3, 5][t] + s, b: [t << 1 | s, ...v, port >> 8, port & 255] };
    }).sort((a, b) => a.rank - b.rank);
    if (out.length > MAX) throw new Error('too long');
    for (const { b } of list) if (out.length + b.length <= MAX) out.push(...b);
    return out;
  }

  function v6(ip) {
    const [a, b] = ip.split('::'), g = s => s ? s.split(':') : [];
    const x = g(a), y = g(b), parts = b === undefined ? x : [...x, ...new Array(8 - x.length - y.length).fill('0'), ...y];
    return parts.length === 8 && parts.every(p => p.length <= 4) && parts.flatMap(p => { const v = parseInt(p, 16); return [v >> 8, v & 255]; });
  }

  function unpack(b) {
    let i = 0;
    const take = n => { if (i + n > b.length) throw new Error('short'); return b.slice(i, i += n); };
    const kind = chars(take(1)), ice = () => { const n = take(1)[0]; return btoa(chars(take(Math.ceil(n / 4) * 3))).slice(0, n); };
    const parts = [ice(), ice(), btoa(chars(take(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')];
    while (i < b.length) {
      const t = take(1)[0];
      const ip = t >> 1 === 0 ? hex(take(16), 2).join('').replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') + '.local'
        : t >> 1 === 1 ? take(4).join('.')
        : t >> 1 === 2 ? hex(take(16), 2).join('').match(/..../g).map(g => g.replace(/^0+(?=.)/, '')).join(':')
        : chars(take(take(1)[0]));
      const [hi, lo] = take(2);
      parts.push((t & 1 ? 's' : 'h') + ip + '_' + (hi << 8 | lo));
    }
    return kind + parts.join(',');
  }

  // The form a code takes after a trip through sound (some candidates may have been left out).
  const norm = code => unpack(pack(code));

  const sum16 = d => { let a = 0, b = 0; for (const x of d) { a = (a + x) % 255; b = (b + a) % 255; } return [a, b]; };

  // Tone indices for one frame.
  function frame(code) {
    const p = pack(code), h = Math.ceil((p.length + 1) / UNIT) - 1;
    const data = [...p, 0x80, ...new Array(UNIT * (h + 1) - p.length - 1).fill(0)];
    const cw = rsEncode([...data, ...sum16(data)]);
    return [
      ...Array.from({ length: PRE }, (_, i) => i & 1 ? S1 : S0),
      ...Array.from({ length: HEAD }, (_, m) => sym(h, m)),
      ...cw.flatMap(x => [x >> 4, x & 15]).map((v, j) => sym(v, HEAD + j)),
    ];
  }

  function readFrame(cw, h) {
    const n = UNIT * (h + 1), data = cw.slice(0, n), [a, b] = sum16(data);
    if (a !== cw[n] || b !== cw[n + 1]) return null;
    const end = data.lastIndexOf(0x80);
    if (end < 0 || data.slice(end + 1).some(x => x)) return null;
    try { return unpack(data.slice(0, end)); } catch { return null; }
  }

  // ---------- Receiver ----------
  // Feed it microphone samples with push(). Calls onCode(code) for each code heard, and
  // onState('hearing', fraction) / onState('missed') so the page can show what's happening.
  function receiver(rate, onCode, onState = () => {}) {
    const n = Math.round(SYM * rate), hop = n >> 2, size = 2 ** Math.ceil(Math.log2(rate * 12)), mask = size - 1;
    const buf = new Float32Array(size);
    const coef = FREQ.map(f => 2 * Math.cos(2 * Math.PI * f / rate));
    let pos = 0, fresh = 0, mutedTo = 0, heardAt = -rate, labels = [], job = null, acc = null;

    const goertzel = (at, i) => { // strength of frequency i over the symbol-long window starting at sample `at`
      const c = coef[i];
      let a = 0, b = 0;
      for (let i = 0; i < n; i++) { const t = buf[(at + i) & mask] + c * a - b; b = a; a = t; }
      return a * a + b * b - c * a * b;
    };
    const power = (at, k) => PARTS(k).reduce((s, i) => s + goertzel(at, i), 0);
    const energy = at => { // what power() would give if the window held one pure tone
      let s = 0;
      for (let i = 0; i < n; i++) { const v = buf[(at + i) & mask]; s += v * v; }
      return s * n / 2 + 1e-9;
    };
    const set = (at, m) => { // relative strength of the 16 tones symbol m may use
      const e = Array.from({ length: 16 }, (_, v) => power(at, sym(v, m))), t = e.reduce((x, y) => x + y) + 1e-12;
      return e.map(x => x / t);
    };

    // Which of our tones (if any) clearly stands out in the window?
    function classify(at) {
      const g = FREQ.map((_, i) => goertzel(at, i)), sum = g.reduce((x, y) => x + y) + 1e-12;
      let best = -1, max = 0;
      for (let k = 0; k <= S1; k++) { const p = k < S0 ? g[k] : PARTS(k).reduce((s, i) => s + g[i], 0); if (p > max) { max = p; best = k; } }
      return max > 0.35 * sum ? best : -1;
    }

    // Finds where the sync starts near a rough guess: alternating sync tones, and no sync just before or after.
    function align(guess) {
      const score = t => {
        let s = 0;
        for (let i = -1; i <= PRE; i++) {
          const at = t + i * n, e = energy(at), p0 = power(at, S0) / e, p1 = power(at, S1) / e;
          s += i < 0 || i === PRE ? -(p0 + p1) : i & 1 ? p1 - p0 : p0 - p1;
        }
        return s;
      };
      let best = guess, top = -Infinity;
      for (let t = guess - 2 * n, step = Math.max(1, n >> 5); t <= guess + 3.5 * n; t += step) {
        const s = score(Math.round(t));
        if (s > top) { top = s; best = Math.round(t); }
      }
      return [best, top];
    }

    function work() {
      if (pos < mutedTo) return job = null; // we talked over it
      if (job.t0 == null) {
        if (pos < job.guess + (PRE + HEAD + 3.5) * n) return;
        const [t0, s] = align(job.guess);
        if (s < PRE * 0.1) return job = null; // not really a sync after all
        const votes = new Array(16).fill(0);
        for (let m = 0; m < HEAD; m++) set(t0 + (PRE + m) * n, m).forEach((x, v) => votes[v] += x);
        job.h = votes.indexOf(Math.max(...votes));
        job.t0 = t0;
        job.end = t0 + (PRE + HEAD + 2 * bodyLen(job.h)) * n;
      }
      if (pos < job.end) return onState('hearing', (pos - job.t0) / (job.end - job.t0));
      const { t0, h } = job, v = [];
      for (let j = 0; j < 2 * bodyLen(h); j++) v.push(set(t0 + (PRE + HEAD + j) * n, HEAD + j));
      job = null;
      labels = [];
      combine(h, v);
    }

    const top2 = e => {
      let a = 0, b = 1;
      if (e[b] > e[a]) [a, b] = [b, a];
      for (let i = 2; i < e.length; i++) if (e[i] > e[a]) { b = a; a = i; } else if (e[i] > e[b]) b = i;
      return [a, e[a] - e[b]];
    };

    // Adds this frame to what was heard before (if it looks like the same message) and tries to read it.
    function combine(h, v) {
      if (acc?.h === h) {
        const same = v.filter((e, j) => top2(e)[0] === top2(acc.v[j])[0]).length;
        if (same < v.length * 0.4) acc = null; // a different message
      } else acc = null;
      if (acc) acc.v.forEach((e, j) => e.forEach((_, i) => e[i] += v[j][i]));
      else acc = { h, v };
      const s = acc.v.map(top2), b = [], conf = [];
      for (let i = 0; i < s.length; i += 2) { b.push(s[i][0] << 4 | s[i + 1][0]); conf.push(Math.min(s[i][1], s[i + 1][1])); }
      const doubt = conf.map((c, i) => [c, i]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
      for (const k of [0, 6, 12, 18, PAR]) {
        const cw = rsDecode(b, doubt.slice(0, k)), code = cw && readFrame(cw, h);
        if (code) { acc = null; return onCode(code); }
      }
      onState('missed');
    }

    return {
      push(samples) {
        for (let i = 0; i < samples.length; i++) {
          buf[pos & mask] = samples[i];
          pos++;
          if (++fresh < hop) continue;
          fresh = 0;
          const k = pos < mutedTo ? -1 : classify(pos - n);
          if (k >= 0) heardAt = pos;
          labels.push(k);
          if (labels.length > 48) labels.shift();
          if (job) { work(); continue; }
          // End of the sync (last sync tone followed by data) after enough alternating sync tones.
          if (k < 0 || k >= S0 || labels.slice(0, -1).findLast(x => x >= 0) !== S1) continue;
          const sync = labels.slice(-44).filter(x => x === S0 || x === S1);
          let flips = 0;
          for (let j = 1; j < sync.length; j++) flips += sync[j] !== sync[j - 1];
          if (sync.filter(x => x === S0).length >= 8 && sync.filter(x => x === S1).length >= 8 && flips >= 4)
            job = { guess: pos - hop - n / 2 - PRE * n };
        }
      },
      // Ignore the microphone for the next `ms` (while we play our own sound and its echo dies down).
      mute(ms) { mutedTo = Math.max(mutedTo, pos + Math.round(ms * rate / 1000)); job = null; },
      // Is the other device talking right now?
      busy: () => !!job || pos - heardAt < rate / 2,
    };
  }

  return { SYM, freqs, frame, receiver, norm, rsEncode, rsDecode };
})();
