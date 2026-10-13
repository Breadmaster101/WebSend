'use strict';
// AudioWorklet: forwards raw microphone samples to the page in batches, which decodes sound codes (see sound.js).
registerProcessor('tap', class extends AudioWorkletProcessor {
  buf = new Float32Array(2048);
  n = 0;
  process([input]) {
    const x = input[0] || [];
    for (let i = 0; i < x.length; i++) {
      this.buf[this.n++] = x[i];
      if (this.n < this.buf.length) continue;
      this.port.postMessage(this.buf, [this.buf.buffer]);
      this.buf = new Float32Array(2048);
      this.n = 0;
    }
    return true;
  }
});
