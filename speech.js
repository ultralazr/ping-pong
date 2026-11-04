// Speech recognition with vosk-browser (WebAssembly, fully offline).
// vosk-browser caches the extracted model in IndexedDB itself, keyed by the model URL,
// so after the first load no network is needed.

/* global Vosk */

export class Listener {
  constructor({ onResult, onPartial, onLevel, onError }) {
    this.onResult = onResult || (() => {});
    this.onPartial = onPartial || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onError = onError || ((e) => console.error(e));
    this.model = null;
    this.rec = null;
    this.grammar = null;
    this.paused = false;
    this.ctx = null;
  }

  async loadModel(url) {
    // The worker resolves relative URLs against its blob: origin root, which drops any
    // sub-path (e.g. /ping-pong/ on GitHub Pages). Always pass an absolute URL.
    const absUrl = new URL(url, location.href).href;
    // Vosk.createModel never rejects on a load error, so wait for load/error ourselves.
    this.model = await new Promise((resolve, reject) => {
      const model = new Vosk.Model(absUrl, -1);
      model.on('load', (m) => (m.result ? resolve(model) : reject(new Error('load failed'))));
      model.on('error', (m) => reject(new Error(m.error)));
    });
    this.model.on('error', (m) => this.onError(m.error));
  }

  // Must be called from a user gesture (AudioContext + mic permission).
  async startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but is what vosk-browser expects (AudioBuffer input).
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      this.onLevel(Math.sqrt(sum / (data.length / 4)));
      if (this.paused || !this.rec) return;
      try {
        this.rec.acceptWaveform(e.inputBuffer);
      } catch (err) {
        this.onError(err);
      }
    };
    source.connect(node);
    // Some browsers only run the processor when it is connected to the output; it outputs silence.
    node.connect(this.ctx.destination);
    this.node = node;
    this.stream = stream;
  }

  // words = null -> full vocabulary; array -> restricted grammar plus [unk].
  setGrammar(words) {
    this.grammar = words ? JSON.stringify([...words, '[unk]']) : null;
    this._newRecognizer();
  }

  _newRecognizer() {
    if (!this.model || !this.ctx) return;
    if (this.rec) {
      try {
        this.rec.remove();
      } catch (e) {
        /* ignore */
      }
    }
    const rec = this.grammar
      ? new this.model.KaldiRecognizer(this.ctx.sampleRate, this.grammar)
      : new this.model.KaldiRecognizer(this.ctx.sampleRate);
    rec.setWords(true);
    rec.on('result', (m) => {
      if (rec !== this.rec) return;
      const r = m.result || {};
      const text = (r.text || '').trim();
      if (!text) return;
      this.onResult({ text, words: r.result || [] });
    });
    rec.on('partialresult', (m) => {
      if (rec !== this.rec) return;
      this.onPartial((m.result && m.result.partial) || '');
    });
    rec.on('error', (m) => this.onError(m.error));
    this.rec = rec;
  }

  pause() {
    this.paused = true;
  }

  // A fresh recognizer drops any half-heard audio from before the pause.
  resume() {
    this.paused = false;
    this._newRecognizer();
  }
}
