/**
 * Automatic performance scaling. Watches frame time and steps the quality
 * tier down when the GPU can't hold ~50 fps; cautiously steps back up once
 * if there is lots of headroom. (Stepping is rate-limited to avoid flapping.)
 */
const LEVELS = ['low', 'medium', 'high'];

export class PerfGovernor {
  constructor(onLevel, start = 'high') {
    this.onLevel = onLevel;
    this.level = LEVELS.indexOf(start);
    this.enabled = true;
    this.samples = [];
    this.lastChange = performance.now();
    this.downgrades = 0;
    this.slowRuns = 0;
    this.fastRuns = 0;
  }

  setEnabled(v) {
    this.enabled = v;
    this.samples.length = 0;
    this.slowRuns = this.fastRuns = 0;
  }

  setLevel(name) {
    this.level = Math.max(0, LEVELS.indexOf(name));
  }

  /** @param {number} dtMs frame time in ms @param {number} now ms */
  tick(dtMs, now) {
    if (!this.enabled) return;
    if (dtMs > 250) return; // tab switch / hitch — ignore
    this.samples.push(dtMs);
    if (this.samples.length < 90) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;
    if (now - this.lastChange < 2500) return;

    if (avg > 21 && this.level > 0) {
      if (++this.slowRuns >= 2) {
        this.level--;
        this.downgrades++;
        this.slowRuns = 0;
        this.lastChange = now;
        this.onLevel(LEVELS[this.level]);
      }
    } else {
      this.slowRuns = 0;
      if (avg < 11.5 && this.level < LEVELS.length - 1 && this.downgrades < 2 && now - this.lastChange > 20000) {
        if (++this.fastRuns >= 3) {
          this.level++;
          this.fastRuns = 0;
          this.lastChange = now;
          this.onLevel(LEVELS[this.level]);
        }
      } else this.fastRuns = 0;
    }
  }
}
