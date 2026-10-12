'use strict';
// AudioWorklet: forwards raw microphone samples to the page, which decodes sound codes (see app.js).
registerProcessor('tap', class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});
