/**
 * Synthesised sound design — no audio files.
 *   grab/release → soft mechanical ticks      catch → low thump
 *   spin         → filtered-noise whoosh that follows angular speed
 * The AudioContext is created lazily on the first user gesture (browser policy).
 */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.6;
    this.whoosh = null;
    const unlock = () => {
      this._ensure();
      if (!this.muted) this.ctx?.resume?.(); // a muted context stays parked
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { once: false, passive: true }));
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume * 0.5;
    this.master.connect(this.ctx.destination);

    // looping noise for the whoosh
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.97 * b0 + 0.03 * white; // brown-ish
      d[i] = b0 * 6;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.value = 200;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    this.whoosh = { bp, g };
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : this.volume * 0.5, this.ctx.currentTime, 0.03);
    // a muted context still runs the looping whoosh on the audio thread — park it entirely
    if (m) setTimeout(() => this.muted && this.ctx.suspend(), 120);
    else this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.03);
  }

  _blip(freqA, freqB, dur, type = 'sine', gain = 0.5) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freqA, t);
    o.frequency.exponentialRampToValueAtTime(freqB, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _tick(freq, gain = 0.35) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = Math.floor(this.ctx.sampleRate * 0.012);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
  }

  play(type) {
    this._ensure();
    switch (type) {
      case 'grab':
        this._tick(2400);
        this._blip(520, 380, 0.07, 'sine', 0.22);
        break;
      case 'release':
        this._tick(1500, 0.28);
        this._blip(330, 220, 0.08, 'sine', 0.18);
        break;
      case 'catch':
        this._blip(130, 55, 0.22, 'sine', 0.55);
        this._tick(900, 0.3);
        break;
      case 'flick':
        this._blip(900, 260, 0.14, 'triangle', 0.12);
        break;
      case 'ui':
        this._tick(3200, 0.12);
        break;
      default:
    }
  }

  /** speed in rad/s */
  setSpin(speed) {
    if (!this.whoosh || !this.ctx) return;
    if (this.muted) return;
    const k = Math.round(Math.min(1, speed / 9) * 200) / 200;
    if (k === this.lastSpinK) return; // only schedule automation when the level actually changes
    this.lastSpinK = k;
    const t = this.ctx.currentTime;
    this.whoosh.g.gain.setTargetAtTime(k * k * 0.55, t, 0.08);
    this.whoosh.bp.frequency.setTargetAtTime(180 + k * 1100, t, 0.1);
  }
}
