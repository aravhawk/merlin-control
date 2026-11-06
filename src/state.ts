/** Tiny observable settings store (persisted subset in localStorage). */
import type { QualityLevel } from './perf.ts';

export type ViewMode = 'wire' | 'solid' | 'both';
export type RotationMode = 'model' | 'orbit';
export type QualitySetting = 'auto' | QualityLevel;

export interface Settings {
  mode: ViewMode;
  /** 0..1 */
  explode: number;
  bloom: boolean;
  vignette: boolean;
  glass: boolean;
  anaglyph: boolean;
  labels: boolean;
  rotationMode: RotationMode;
  sensitivity: number;
  invertZoom: boolean;
  sound: boolean;
  volume: number;
  quality: QualitySetting;
  showPip: boolean;
  showGesture: boolean;
  uiHidden: boolean;
}

export type SettingKey = keyof Settings;
/** Keys whose value is a boolean (the ones `toggle` and switches work on). */
export type BooleanKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey];

type Listener<K extends SettingKey> = (value: Settings[K], key: K) => void;

const KEY = 'merlin1d.settings.v2';
const PERSIST: readonly SettingKey[] = ['mode', 'bloom', 'vignette', 'glass', 'labels', 'rotationMode', 'sensitivity', 'invertZoom', 'sound', 'quality', 'showPip', 'showGesture', 'volume'];

export const DEFAULTS: Settings = {
  mode: 'wire',
  explode: 0,
  bloom: true,
  vignette: true,
  glass: false,
  anaglyph: false,
  labels: false,
  rotationMode: 'model',
  sensitivity: 1,
  invertZoom: false,
  sound: true,
  volume: 0.6,
  quality: 'auto',
  showPip: true,
  showGesture: true,
  uiHidden: false,
};

export interface Store {
  readonly data: Settings;
  get<K extends SettingKey>(key: K): Settings[K];
  set<K extends SettingKey>(key: K, value: Settings[K]): void;
  /** Flips a boolean setting and returns its new value. */
  toggle(key: BooleanKey): boolean;
  on<K extends SettingKey>(key: K, fn: Listener<K>, immediate?: boolean): void;
}

/** Allowed values for the string-enum settings. */
const CHOICES: Partial<Record<SettingKey, readonly unknown[]>> = {
  mode: ['wire', 'solid', 'both'],
  rotationMode: ['model', 'orbit'],
  quality: ['auto', 'low', 'medium', 'high'],
};

/** Keeps only persisted keys whose saved value is valid (old or hand-edited storage can't break boot). */
function loadSaved(): Partial<Settings> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    for (const k of PERSIST) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === typeof DEFAULTS[k] && (CHOICES[k]?.includes(v) ?? true)) out[k] = v;
    }
  } catch {}
  return out as Partial<Settings>;
}

export function createStore(): Store {
  const data: Settings = { ...DEFAULTS, ...loadSaved() };
  const subs = new Map<SettingKey, Set<Listener<never>>>();

  // debounced: dragging a slider fires ~60 sets/s, but one write after it settles is enough
  let persistTimer = 0;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        const out: Partial<Record<SettingKey, unknown>> = {};
        PERSIST.forEach((k) => (out[k] = data[k]));
        localStorage.setItem(KEY, JSON.stringify(out));
      } catch {}
    }, 250);
  };

  const store: Store = {
    data,
    get: (k) => data[k],
    set(k, v) {
      if (data[k] === v) return;
      data[k] = v;
      subs.get(k)?.forEach((fn) => (fn as Listener<typeof k>)(v, k));
      if (PERSIST.includes(k)) persist();
    },
    toggle(k) {
      store.set(k, !data[k]);
      return data[k];
    },
    on(k, fn, immediate = false) {
      let set = subs.get(k);
      if (!set) subs.set(k, (set = new Set()));
      set.add(fn as Listener<never>);
      if (immediate) fn(data[k], k);
    },
  };
  return store;
}
