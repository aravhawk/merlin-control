/**
 * Renderer, camera, lights, environment and post-processing.
 * Three render paths, chosen per frame:
 *   WebXR            → straight to the headset
 *   Anaglyph         → off-axis stereo pair composited red/cyan
 *   Post (bloom/vig) → MSAA half-float target → bloom → vignette → output
 *   Direct           → plain MSAA canvas (cheapest)
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AnaglyphEffect } from 'three/addons/effects/AnaglyphEffect.js';
import { rng } from '../model/geom.ts';
import type { QualityLevel } from '../perf.ts';

export interface QualityTier {
  pixelRatio: number;
  msaa: number;
  bloomScale: number;
  /** shadow map size; 0 disables shadows */
  shadows: number;
}

/** Post-processing / lighting look (see EngineView.look). */
export interface Look {
  bloomThreshold: number;
  bloomStrength: number;
  exposure: number;
  shadows: boolean;
}

const FINISH_SHADER = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.55 }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      d.x *= 1.15;
      float v = smoothstep(0.85, 0.2, length(d));
      c.rgb *= mix(1.0, v, uVignette);
      // sub-LSB dither: keeps the dark gradient free of banding
      c.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0 * 1.5;
      gl_FragColor = c;
    }`,
};

export const QUALITY: Record<QualityLevel, QualityTier> = {
  low: { pixelRatio: 1, msaa: 0, bloomScale: 0.35, shadows: 0 },
  medium: { pixelRatio: 1.5, msaa: 2, bloomScale: 0.5, shadows: 1024 },
  high: { pixelRatio: 2, msaa: 4, bloomScale: 0.6, shadows: 2048 },
};

export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
  readonly settings = { bloom: true, vignette: true, anaglyph: false };
  readonly anaglyph: AnaglyphEffect;
  quality: QualityTier = QUALITY.high;
  size = { w: 1, h: 1 };
  time = 0;
  /** distance to the model, used as the anaglyph convergence plane */
  focusDist = 7;
  private keyLight!: THREE.DirectionalLight;
  private stars!: THREE.Points;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private finishPass!: ShaderPass;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer = renderer;
    renderer.setClearColor(0x02040a, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0x02040a);
    this.camera.position.set(0, 0, 7);

    this._buildLights();
    this._buildEnvironment();
    this._buildStars();

    this._buildComposer();
    this.anaglyph = new AnaglyphEffect(renderer, 2, 2);
    this.applyQuality('high');
  }

  private _buildLights(): void {
    const key = new THREE.DirectionalLight(0xfff1e0, 3.0);
    key.position.set(-4, 5, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -3.2;
    sc.right = sc.top = 3.2;
    sc.near = 1;
    sc.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x7fb4ff, 0.9);
    fill.position.set(6, 1.5, 3);
    const rim = new THREE.DirectionalLight(0x58e6ff, 2.2);
    rim.position.set(1, 3, -7);
    const under = new THREE.DirectionalLight(0xffc89a, 0.5);
    under.position.set(0, -5, 2);
    const hemi = new THREE.HemisphereLight(0x8fb9ff, 0x0a0c12, 0.35);

    this.scene.add(key, fill, rim, under, hemi);
  }

  private _buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.035).texture;
    this.scene.environmentIntensity = 0.75;
    room.dispose(); // only needed to bake the PMREM
    pmrem.dispose();
  }

  private _buildStars(): void {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const r = rng(1234567);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const d = 120 + r() * 60;
      pos.set([s * Math.cos(a) * d, u * d, s * Math.sin(a) * d], i * 3);
      const b = 0.25 + Math.pow(r(), 3) * 0.75;
      const tint = r();
      col.set([b * (0.75 + 0.25 * tint), b * 0.9, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      toneMapped: false,
    });
    this.stars = new THREE.Points(g, m);
    this.stars.renderOrder = -10;
    this.scene.add(this.stars);
  }

  private _buildComposer(): void {
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.25, 0.25);
    this.composer.addPass(this.bloomPass);
    this.finishPass = new ShaderPass(FINISH_SHADER);
    this.composer.addPass(this.finishPass);
    this.composer.addPass(new OutputPass());
  }

  applyQuality(name: QualityLevel): void {
    const q = (this.quality = QUALITY[name]);
    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows > 0;
    this.renderer.shadowMap.enabled = q.shadows > 0;
    this.keyLight.castShadow = q.shadows > 0;
    if (q.shadows > 0 && this.keyLight.shadow.mapSize.x !== q.shadows) {
      this.keyLight.shadow.mapSize.set(q.shadows, q.shadows);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // swap MSAA sample count (recreate the render targets)
    const rt = this.composer.renderTarget1;
    if (rt.samples !== q.msaa) {
      this.composer.renderTarget1.samples = q.msaa;
      this.composer.renderTarget2.samples = q.msaa;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    if (shadowsChanged) {
      // shadow on/off changes the generated shaders
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m && !Array.isArray(m)) m.needsUpdate = true;
      });
    }
    this.resize();
  }

  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = this.pixelRatio;
    this.size = { w, h };
    this.renderer.setPixelRatio(pr);
    // AnaglyphEffect.setSize also sizes the renderer, but writes inline px sizes onto the
    // canvas; clear them so the canvas keeps following its CSS layout on later resizes
    this.anaglyph.setSize(w, h);
    this.canvas.style.removeProperty('width');
    this.canvas.style.removeProperty('height');
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const bloom = this.quality.bloomScale * pr;
    this.bloomPass.setSize(w * bloom, h * bloom);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Distance at which a sphere of `radius` fills `fill` of the viewport (both axes considered). */
  fitDistance(radius: number, fill = 0.78): number {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dv = radius / Math.sin(vFov / 2) / fill;
    const dh = radius / Math.sin(hFov / 2) / fill;
    return Math.max(dv, dh);
  }

  setLook(look: Look): void {
    this.bloomPass.threshold = look.bloomThreshold;
    this.bloomPass.strength = look.bloomStrength;
    this.renderer.toneMappingExposure = look.exposure;
    // skip re-rendering the shadow map entirely when nothing lit is on screen
    this.keyLight.shadow.autoUpdate = look.shadows;
    this.keyLight.shadow.needsUpdate = true;
  }

  get postActive(): boolean {
    return this.settings.bloom || this.settings.vignette;
  }

  render(dt: number): void {
    this.time += dt;
    const r = this.renderer;
    this.finishPass.uniforms.uTime.value = this.time % 10;
    this.finishPass.uniforms.uVignette.value = this.settings.vignette ? 0.62 : 0;
    this.bloomPass.enabled = this.settings.bloom;

    if (r.xr.isPresenting) {
      r.render(this.scene, this.camera);
    } else if (this.settings.anaglyph) {
      this.anaglyph.planeDistance = this.focusDist;
      this.anaglyph.eyeSep = this.focusDist * 0.032;
      this.anaglyph.render(this.scene, this.camera);
    } else if (this.postActive) {
      this.composer.render(dt);
    } else {
      r.render(this.scene, this.camera);
    }
  }
}
