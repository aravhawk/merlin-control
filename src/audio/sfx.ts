/**
 * Synthesised sound design — no audio files.
 *   grab/release → soft mechanical ticks      catch → low thump
 *   spin         → filtered-noise whoosh that follows angular speed
 * The AudioContext is created lazily on the first user gesture (browser policy).
 */
export type SfxName = 'grab' | 'release' | 'catch' | 'flick' | 'ui';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private whoosh: { bp: BiquadFilterNode; g: GainNode } | null = null;
  private lastSpinK = -1;
  muted = false;
  volume = 0.6;

  constructor() {
    // The first user gesture creates / resumes the context; after that these listeners have no
    // job (a later unmute resumes it from setMuted, which also runs inside a user gesture).
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    const unlock = () => {
      this._ensure();
      if (!this.muted) void this.ctx?.resume(); // a muted context stays parked
      events.forEach((e) => window.removeEventListener(e, unlock));
    };
    events.forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  }

  private _ensure(): void {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.muted ? 0 : this.volume * 0.5;
    master.connect(ctx.destination);

    // looping noise for the whoosh
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.97 * b0 + 0.03 * white; // brown-ish
      d[i] = b0 * 6;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.value = 200;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(g).connect(master);
    src.start();
    this.whoosh = { bp, g };
  }

  setMuted(m: boolean): void {
    this.muted = m;
    const { ctx, master } = this;
    if (!ctx || !master) return;
    master.gain.setTargetAtTime(m ? 0 : this.volume * 0.5, ctx.currentTime, 0.03);
    // a muted context still runs the looping whoosh on the audio thread — park it entirely
    if (m) setTimeout(() => this.muted && ctx.suspend(), 120);
    else ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master && !this.muted) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.03);
  }

  private _blip(freqA: number, freqB: number, dur: number, type: OscillatorType = 'sine', gain = 0.5): void {
    const { ctx, master } = this;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freqA, t);
    o.frequency.exponentialRampToValueAtTime(freqB, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private _tick(freq: number, gain = 0.35): void {
    const { ctx, master } = this;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;
    const n = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 2;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(f).connect(g).connect(master);
    s.start(t);
  }

  play(type: SfxName): void {
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
    }
  }

  /** `speed` in rad/s */
  setSpin(speed: number): void {
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
