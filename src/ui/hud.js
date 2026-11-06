/** Heads-up display. */

const ICON = {
  open: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="22" width="22" height="18" rx="8"/><path d="M17 22V11M22.5 22V6.5M28 22V6.5M33 23V11M13.5 31 6.5 24"/></svg>`,
  fist: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="11" y="17" width="26" height="23" rx="9"/><path d="M17.5 17v-3M24 17v-4M30.5 17v-3M16 31h15"/></svg>`,
  dual: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(-6 5) scale(.8)"><rect x="13" y="22" width="22" height="18" rx="8"/><path d="M17 22V11M22.5 22V6.5M28 22V6.5M33 23V11"/></g><g transform="translate(18 5) scale(.8)"><rect x="13" y="22" width="22" height="18" rx="8"/><path d="M17 22V11M22.5 22V6.5M28 22V6.5M33 23V11"/></g></svg>`,
  none: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14v-4a1 1 0 0 1 1-1h4M34 9h4a1 1 0 0 1 1 1v4M39 34v4a1 1 0 0 1-1 1h-4M14 39h-4a1 1 0 0 1-1-1v-4"/><circle cx="24" cy="24" r="4" stroke-dasharray="1 5"/></svg>`,
};

const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];


const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

/**
 * Heads-up display. Deliberately minimal: a wordmark, one bottom dock, a gesture
 * pill and two drawers (Parts, Settings) that stay closed until asked for.
 * It only talks to the app through `store` and `actions`.
 */
export function createHUD({ root, store, model, view, actions, shortcuts }) {
  const parts = model.assemblies;

  const ui = el(`
  <div class="hud">
    <header class="brand">
      <div class="brand-mark">MERLIN 1D</div>
      <div class="brand-sub"><span id="stat-edges">0</span> edges</div>
    </header>

    <nav class="corner">
      <button class="ghost" data-drawer="parts">Parts</button>
      <button class="ghost" data-drawer="settings">Settings</button>
      <button class="ghost round" id="help-btn" aria-label="Keyboard shortcuts">?</button>
    </nav>

    <div class="dock" role="toolbar" aria-label="View controls">
      <div class="seg" data-key="mode">
        <button data-v="wire">Wire</button><button data-v="solid">Solid</button><button data-v="both">Both</button>
      </div>
      <span class="div"></span>
      <button class="dbtn" id="explode-btn">Explode</button>
      <button class="dbtn tog" data-key="labels">Labels</button>
      <button class="dbtn" id="reset-btn">Reset</button>
      <span class="div"></span>
      <button class="dbtn cam" id="cam-btn"><span class="rec"></span><span id="cam-btn-txt">Hand tracking</span></button>
    </div>

    <div class="pip" id="pip" data-on="false">
      <video id="cam" playsinline muted></video><canvas id="pip-canvas"></canvas>
    </div>

    <div class="gesture" id="gesture" data-state="off">
      <div class="g-icon" id="g-icon"></div>
      <div class="g-text"><div class="g-title" id="g-title"></div><div class="g-sub" id="g-sub"></div></div>
      <div class="g-spin"><i id="g-spin"></i></div>
    </div>

    <aside class="drawer" id="drawer-parts" aria-hidden="true">
      <div class="d-head"><h3>Parts</h3><button class="x" data-close aria-label="Close">✕</button></div>
      <p class="d-note">Hover to highlight · click to isolate</p>
      <ul class="parts" id="parts">
        ${parts.map((p) => `<li data-id="${p.id}" title="${p.info}">${p.name}</li>`).join('')}
      </ul>
      <button class="link" id="iso-clear" hidden>Show all parts</button>
    </aside>

    <aside class="drawer" id="drawer-settings" aria-hidden="true">
      <div class="d-head"><h3>Settings</h3><button class="x" data-close aria-label="Close">✕</button></div>
      <div class="field"><label>Explode</label><input type="range" min="0" max="1" step="0.01" data-key="explode" /></div>
      <div class="field"><label>Camera</label>
        <div class="seg sm">
          <button data-preset="front">Front</button><button data-preset="side">Side</button><button data-preset="top">Top</button><button data-preset="iso">Iso</button>
        </div>
      </div>
      <div class="field"><label>Rotate</label><div class="seg sm" data-key="rotationMode"><button data-v="model">Model</button><button data-v="orbit">Camera</button></div></div>
      <div class="field"><label>Sensitivity</label><input type="range" min="0.4" max="2.2" step="0.05" data-key="sensitivity" /></div>
      <div class="field"><label>Quality</label><div class="seg sm" data-key="quality"><button data-v="auto">Auto</button><button data-v="low">Low</button><button data-v="medium">Med</button><button data-v="high">High</button></div></div>
      <div class="switches">
        <label class="sw"><input type="checkbox" data-key="bloom" /><span>Glow</span></label>
        <label class="sw"><input type="checkbox" data-key="vignette" /><span>Vignette</span></label>
        <label class="sw"><input type="checkbox" data-key="glass" /><span>Holographic glass</span></label>
        <label class="sw"><input type="checkbox" data-key="anaglyph" /><span>Anaglyph 3-D</span></label>
        <label class="sw"><input type="checkbox" data-key="invertZoom" /><span>Invert two-hand zoom</span></label>
        <label class="sw"><input type="checkbox" data-key="sound" /><span>Sound</span></label>
        <label class="sw"><input type="checkbox" data-key="showGesture" /><span>Gesture indicator</span></label>
        <label class="sw"><input type="checkbox" data-key="showPip" /><span>Camera preview</span></label>
      </div>
      <button class="wide" id="vr-btn" hidden>Enter VR</button>
      <div class="d-foot"><span id="stat-fps">--</span> fps · <span id="stat-q"></span></div>
    </aside>

    <div class="toast" id="toast" role="status"></div>
    <button class="ui-reveal" id="ui-reveal" aria-label="Show interface">Show UI</button>

    <div class="help" id="help" hidden>
      <div class="help-card">
        <div class="d-head"><h3>Controls</h3><button class="x" id="help-close" aria-label="Close">✕</button></div>
        <div class="help-grid">
          <div>
            <h4>Hands</h4>
            <ul class="gl">
              <li><b>Open palm</b> grab — move to rotate, twist to roll</li>
              <li><b>Fist</b> release — reposition freely</li>
              <li><b>Flick, then close</b> your fist to spin it</li>
              <li><b>Open palm while spinning</b> catches it</li>
              <li><b>Two open palms</b> — spread to zoom in, move together to pan, twist to roll</li>
            </ul>
          </div>
          <div><h4>Keyboard</h4><table class="keys">${shortcuts.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table></div>
        </div>
      </div>
    </div>
  </div>`);
  root.appendChild(ui);
  const $ = (s) => ui.querySelector(s);

  // ── bindings ────────────────────────────────────────────────────────
  ui.querySelectorAll('.seg[data-key]').forEach((seg) => {
    const key = seg.dataset.key;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      store.set(key, b.dataset.v);
      actions.tick();
    });
    store.on(key, (v) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)), true);
  });
  ui.querySelectorAll('.tog[data-key]').forEach((b) => {
    const key = b.dataset.key;
    b.addEventListener('click', () => {
      store.toggle(key);
      actions.tick();
    });
    store.on(key, (v) => {
      b.classList.toggle('on', !!v);
      b.setAttribute('aria-pressed', String(!!v));
    }, true);
  });
  ui.querySelectorAll('input[type=checkbox][data-key]').forEach((c) => {
    const key = c.dataset.key;
    c.addEventListener('change', () => store.set(key, c.checked));
    store.on(key, (v) => (c.checked = !!v), true);
  });
  ui.querySelectorAll('input[type=range][data-key]').forEach((r) => {
    const key = r.dataset.key;
    r.addEventListener('input', () => store.set(key, parseFloat(r.value)));
    store.on(key, (v) => {
      if (parseFloat(r.value) !== v) r.value = v;
    }, true);
  });
  ui.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => actions.preset(b.dataset.preset)));
  $('#reset-btn').addEventListener('click', () => actions.preset('home'));
  $('#explode-btn').addEventListener('click', () => actions.toggleExplode());
  store.on('explode', (v) => $('#explode-btn').classList.toggle('on', v > 0.5), true);
  $('#cam-btn').addEventListener('click', () => actions.toggleCamera());

  // drawers (one at a time)
  let openDrawer = null;
  const setDrawer = (name) => {
    openDrawer = openDrawer === name ? null : name;
    ['parts', 'settings'].forEach((n) => {
      const d = $(`#drawer-${n}`);
      const on = n === openDrawer;
      d.classList.toggle('open', on);
      d.setAttribute('aria-hidden', String(!on));
    });
    ui.querySelectorAll('[data-drawer]').forEach((b) => b.classList.toggle('on', b.dataset.drawer === openDrawer));
  };
  ui.querySelectorAll('[data-drawer]').forEach((b) => b.addEventListener('click', () => setDrawer(b.dataset.drawer)));
  ui.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setDrawer(null)));

  // parts: hover = highlight, click = isolate
  const partsEl = $('#parts');
  partsEl.addEventListener('pointerover', (e) => {
    const li = e.target.closest('li');
    if (li) view.setHover(li.dataset.id);
  });
  partsEl.addEventListener('pointerleave', () => view.setHover(null));
  partsEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    actions.isolate(view.isolated === li.dataset.id ? null : li.dataset.id);
  });
  $('#iso-clear').addEventListener('click', () => actions.isolate(null));
  const syncIsolate = (id) => {
    partsEl.querySelectorAll('li').forEach((li) => li.classList.toggle('on', li.dataset.id === id));
    $('#iso-clear').hidden = !id;
  };

  // help
  const help = $('#help');
  const setHelp = (v) => (help.hidden = !v);
  $('#help-btn').addEventListener('click', () => setHelp(true));
  $('#help-close').addEventListener('click', () => setHelp(false));
  help.addEventListener('click', (e) => e.target === help && setHelp(false));

  store.on('uiHidden', (v) => ui.classList.toggle('ui-hidden', !!v), true);
  $('#ui-reveal').addEventListener('click', () => store.set('uiHidden', false));
  store.on('showGesture', (v) => ui.classList.toggle('no-gesture', !v), true);
  store.on('showPip', (v) => ui.classList.toggle('no-pip', !v), true);

  $('#stat-edges').textContent = model.totalSegments.toLocaleString();

  // ── toast ───────────────────────────────────────────────────────────
  let toastTimer = 0;
  const toast = (msg, ms = 1800) => {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  };

  // ── gesture pill ────────────────────────────────────────────────────
  // `free`: nothing is holding the engine in this state, so a spin is shown as "Spinning"
  const GESTURES = {
    off: { icon: 'none', title: 'Camera off', sub: 'Turn on hand tracking to grab the engine', free: true },
    starting: { icon: 'none', title: 'Starting camera', sub: 'Allow camera access', free: true },
    none: { icon: 'none', title: 'Show your hand', sub: 'Raise an open palm to grab', free: true },
    idle: { icon: 'fist', title: 'Released', sub: 'Open your palm to grab', free: true },
    single: { icon: 'open', title: 'Grabbing', sub: 'Move to rotate · flick and close to spin' },
    dual: { icon: 'dual', title: 'Two hands', sub: 'Spread to zoom · move to pan · twist to roll' },
    xr: { icon: 'open', title: 'VR', sub: 'Squeeze or pinch to grab' },
  };
  const SPINNING = { title: 'Spinning', sub: 'Open your palm to catch it' };
  const gesture = $('#gesture');
  let lastGKey = '';
  let hintTimer = 0;
  function setGesture(key, spinning = false) {
    const g = GESTURES[key] || GESTURES.off;
    const text = spinning && g.free ? SPINNING : g;
    const k = key + text.title;
    if (k === lastGKey) return;
    lastGKey = k;
    gesture.dataset.state = key;
    $('#g-icon').innerHTML = ICON[g.icon];
    $('#g-title').textContent = text.title;
    $('#g-sub').textContent = text.sub;
    // the hint line only shows briefly after a state change, then the pill shrinks
    gesture.classList.add('hint');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => gesture.classList.remove('hint'), 3500);
  }
  const spinBar = $('#g-spin');
  let lastSpin = '';
  const setSpin = (speed) => {
    const v = Math.min(1, speed / 10).toFixed(3);
    if (v !== lastSpin) spinBar.style.transform = `scaleX(${(lastSpin = v)})`;
  };

  // ── camera preview ──────────────────────────────────────────────────
  const video = $('#cam');
  const pipCanvas = $('#pip-canvas');
  const pctx = pipCanvas.getContext('2d');
  const pip = $('#pip');
  function setCamera(stateName, msg = '') {
    pip.dataset.on = stateName === 'on' ? 'true' : 'false';
    const btn = $('#cam-btn');
    btn.classList.toggle('on', stateName === 'on');
    btn.classList.toggle('busy', stateName === 'starting');
    $('#cam-btn-txt').textContent = stateName === 'starting' ? 'Starting…' : 'Hand tracking';
    if (msg && stateName === 'off') toast(msg, 5200);
  }
  // canvas backing size follows the element via ResizeObserver, not a per-draw layout read
  new ResizeObserver(() => {
    pipCanvas.width = pipCanvas.clientWidth * 2;
    pipCanvas.height = pipCanvas.clientHeight * 2;
  }).observe(pipCanvas);
  function drawPip(tracks, now) {
    const w = pipCanvas.width;
    const h = pipCanvas.height;
    pctx.clearRect(0, 0, w, h);
    for (const tr of tracks) {
      const col = tr.open ? '134,222,255' : '255,176,82';
      const alpha = now - tr.lastSeen > 0.05 ? 0.35 : 1;
      pctx.lineWidth = 2.5;
      pctx.strokeStyle = `rgba(${col},${0.85 * alpha})`;
      pctx.fillStyle = `rgba(${col},${alpha})`;
      pctx.beginPath();
      for (const [a, b] of HAND_LINKS) {
        const A = tr.imgPts[a];
        const B = tr.imgPts[b];
        pctx.moveTo((1 - A[0]) * w, A[1] * h);
        pctx.lineTo((1 - B[0]) * w, B[1] * h);
      }
      pctx.stroke();
      pctx.beginPath(); // all 21 joints in one path → one fill
      for (let i = 0; i < 21; i++) {
        const x = (1 - tr.imgPts[i][0]) * w;
        const y = tr.imgPts[i][1] * h;
        pctx.moveTo(x + 2.6, y);
        pctx.arc(x, y, 2.6, 0, 7);
      }
      pctx.fill();
    }
  }
  const clearPip = () => pctx.clearRect(0, 0, pipCanvas.width, pipCanvas.height);

  let fpsFrames = 0;
  let fpsT = performance.now();
  function tickFps(now) {
    fpsFrames++;
    if (now - fpsT > 500) {
      $('#stat-fps').textContent = Math.round((fpsFrames * 1000) / (now - fpsT));
      fpsFrames = 0;
      fpsT = now;
    }
  }

  setGesture('off');
  return {
    video,
    toast,
    setGesture,
    setSpin,
    setCamera,
    drawPip,
    clearPip,
    setQuality: (name) => ($('#stat-q').textContent = name || ''),
    tickFps,
    syncIsolate,
    toggleHelp: () => setHelp(help.hidden),
    toggleDrawer: setDrawer,
    closeOverlays() {
      if (!help.hidden) return setHelp(false), true;
      if (openDrawer) return setDrawer(null), true;
      return false;
    },
    /** Reveals the VR button (only called when immersive VR is supported). */
    showVR(onClick) {
      const b = $('#vr-btn');
      b.hidden = false;
      b.onclick = onClick;
    },
    setVRActive(on) {
      $('#vr-btn').textContent = on ? 'Exit VR' : 'Enter VR';
    },
  };
}
