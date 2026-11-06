/** Tiny observable settings store (persisted subset in localStorage). */
const KEY = 'merlin1d.settings.v2';
const PERSIST = ['mode', 'bloom', 'vignette', 'glass', 'labels', 'rotationMode', 'sensitivity', 'invertZoom', 'sound', 'quality', 'showPip', 'showGesture', 'volume'];

export const DEFAULTS = {
  mode: 'wire', // wire | solid | both
  explode: 0, // 0..1
  bloom: true,
  vignette: true,
  glass: false,
  anaglyph: false,
  labels: false,
  rotationMode: 'model', // model | orbit
  sensitivity: 1,
  invertZoom: false,
  sound: true,
  volume: 0.6,
  quality: 'auto', // auto | low | medium | high
  showPip: true,
  showGesture: true,
  uiHidden: false,
};

export function createStore() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {}
  const data = { ...DEFAULTS, ...saved };
  const subs = new Map();

  // debounced: dragging a slider fires ~60 sets/s, but one write after it settles is enough
  let persistTimer = 0;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const out = {};
        PERSIST.forEach((k) => (out[k] = data[k]));
        localStorage.setItem(KEY, JSON.stringify(out));
      } catch {}
    }, 250);
  };

  return {
    data,
    get: (k) => data[k],
    set(k, v) {
      if (data[k] === v) return;
      data[k] = v;
      subs.get(k)?.forEach((fn) => fn(v, k));
      if (PERSIST.includes(k)) persist();
    },
    toggle(k) {
      this.set(k, !data[k]);
      return data[k];
    },
    on(k, fn, immediate = false) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k).add(fn);
      if (immediate) fn(data[k], k);
    },
  };
}
