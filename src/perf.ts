/**
 * Automatic performance scaling. Watches frame time and steps the quality
 * tier down when the GPU can't hold ~50 fps; cautiously steps back up once
 * if there is lots of headroom. (Stepping is rate-limited to avoid flapping.)
 */
export const LEVELS = ['low', 'medium', 'high'] as const;
export type QualityLevel = (typeof LEVELS)[number];

export class PerfGovernor {
  enabled = true;
  level: number;
  private readonly onLevel: (level: QualityLevel) => void;
  private readonly samples: number[] = [];
  private lastChange = performance.now();
  private downgrades = 0;
  private slowRuns = 0;
  private fastRuns = 0;

  constructor(onLevel: (level: QualityLevel) => void, start: QualityLevel = 'high') {
    this.onLevel = onLevel;
    this.level = LEVELS.indexOf(start);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.samples.length = 0;
    this.slowRuns = this.fastRuns = 0;
  }

  setLevel(name: QualityLevel): void {
    this.level = Math.max(0, LEVELS.indexOf(name));
  }

  /** `dtMs` is the last frame time, `now` the current timestamp (both ms). */
  tick(dtMs: number, now: number): void {
    if (!this.enabled) return;
    if (dtMs <= 0 || dtMs > 250) return; // first frame / tab switch / hitch — ignore
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
