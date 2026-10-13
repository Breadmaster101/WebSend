'use strict';
// Test-only AudioWorklets for test/fake-air-inject.js: 'rec' captures what a tab plays, 'src' plays what the other tab played.
registerProcessor('rec', class extends AudioWorkletProcessor {
  buf = new Float32Array(1024);
  n = 0;
  process([input]) {
    const x = input[0] || new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      this.buf[this.n++] = x[i] || 0;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(1024); this.n = 0; }
    }
    return true;
  }
});
registerProcessor('src', class extends AudioWorkletProcessor {
  q = [];
  have = 0;
  started = false;
  constructor() {
    super();
    this.port.onmessage = e => { this.q.push(e.data); this.have += e.data.length; };
  }
  process(_, [out]) {
    const o = out[0];
    if (!this.started && this.have < sampleRate * 0.3) return true; // jitter buffer
    this.started = true;
    for (let i = 0; i < o.length; i++) {
      if (!this.q.length) break;
      const b = this.q[0];
      b.i = b.i || 0;
      o[i] = b[b.i++] + (Math.random() - 0.5) * 0.02;
      this.have--;
      if (b.i === b.length) this.q.shift();
    }
    return true;
  }
});
