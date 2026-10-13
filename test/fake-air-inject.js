// Paste into two WebSend tabs (same origin) before tapping "Connect by sound": each tab's speaker output
// becomes the other tab's microphone, so the sound handshake can be tested without real audio hardware.
(() => {
  const air = new BroadcastChannel('fake-air'), me = Math.random(), ctxs = [];
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(o) {
      super(o);
      ctxs.push(this);
      this.ready = this.audioWorklet.addModule('test/fake-air.js').then(() => {
        const rec = new AudioWorkletNode(this, 'rec');
        this.rec = rec;
        rec.port.onmessage = e => air.postMessage({ me, s: e.data });
        connect.call(connect.call(rec, this.createGain()), super.destination); // keep it pulled
        this.src = new AudioWorkletNode(this, 'src');
      });
    }
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      ctx.ready.then(() => connect.call(this, ctx.rec));
    }
    return connect.call(this, dest, ...rest);
  };
  air.onmessage = e => { if (e.data.me !== me) ctxs.at(-1)?.src?.port.postMessage(e.data.s); };
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = ctxs.at(-1);
    await ctx.ready;
    const d = ctx.createMediaStreamDestination();
    connect.call(ctx.src, d);
    return d.stream;
  };
  return 'fake air ready';
})();
