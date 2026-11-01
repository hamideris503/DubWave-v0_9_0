// Collects ~100 ms chunks of mono audio and posts them to the main thread.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.len = 0;
    this.target = Math.round(sampleRate * 0.1);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.parts.push(ch.slice());
      this.len += ch.length;
      if (this.len >= this.target) {
        const out = new Float32Array(this.len);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.parts = [];
        this.len = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
