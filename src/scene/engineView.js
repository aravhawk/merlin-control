/**
 * Turns the procedural model data into scene objects and drives every
 * view-state on it: wire / solid / overlay, glass, exploded view,
 * hover-highlight and isolate.
 */
import * as THREE from 'three';

// ───────────────────────────────────────────── materials ──

const WIRE_VERT = /* glsl */ `
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const WIRE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  uniform float uMix;
  uniform float uNear;
  uniform float uFar;
  uniform float uFade;
  varying float vDepth;
  void main() {
    float d = clamp((vDepth - uNear) / max(uFar - uNear, 0.001), 0.0, 1.0);
    float k = mix(1.0, 0.28, d * uFade);        // depth cue: far lines recede
    vec3 c = mix(uColor, uHot, uMix) * k;
    // MAX blending: overlapping lines never sum into a white-out, every edge keeps the same crisp brightness
    gl_FragColor = vec4(c * uOpacity, uOpacity * k);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function makeWireMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x86deff) },
      uHot: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0.9 },
      uMix: { value: 0 },
      uNear: { value: 5 },
      uFar: { value: 9 },
      uFade: { value: 1 },
    },
    vertexShader: WIRE_VERT,
    fragmentShader: WIRE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
}

const GLASS_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const GLASS_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  uniform float uMix;
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
    float scan = 0.5 + 0.5 * sin(vW.y * 90.0 - uTime * 1.6);
    float sweep = smoothstep(0.92, 1.0, 0.5 + 0.5 * sin(vW.y * 1.3 - uTime * 0.9));
    float a = (0.018 + fres * 0.55 + scan * 0.02 + sweep * 0.12) * uOpacity;
    vec3 c = mix(uColor, uHot, clamp(uMix + fres * 0.45, 0.0, 1.0));
    gl_FragColor = vec4(c * a, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function makeGlassMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x3fb6ff) },
      uHot: { value: new THREE.Color(0xdff8ff) },
      uOpacity: { value: 1 },
      uMix: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** PBR presets for the CAD-style solid mode. */
const PBR = {
  steel: { color: 0xc3c8d0, metalness: 0.92, roughness: 0.36 },
  chrome: { color: 0xd9dfe7, metalness: 1.0, roughness: 0.18 },
  bronze: { color: 0xb88a52, metalness: 0.9, roughness: 0.34 },
  copper: { color: 0xc77a50, metalness: 0.92, roughness: 0.3 },
  inconel: { color: 0x424955, metalness: 0.85, roughness: 0.5 },
  titanium: { color: 0x7d8897, metalness: 0.92, roughness: 0.4 },
  black: { color: 0x101216, metalness: 0.35, roughness: 0.62 },
};

const _tmp = new THREE.Vector3();

export class EngineView {
  /**
   * @param {ReturnType<import('../model/merlin.js').buildMerlin>} model
   */
  constructor(model) {
    this.root = new THREE.Group(); // oriented by the rig
    this.content = new THREE.Group(); // recentred model
    this.root.add(this.content);

    const center = model.bounds.getCenter(new THREE.Vector3());
    this.content.position.copy(center).multiplyScalar(-1);
    this.radius = model.bounds.getBoundingSphere(new THREE.Sphere()).radius;

    this.mode = 'wire'; // wire | solid | both
    this.glass = false;
    this.explodeTarget = 0;
    this.explode = 0;
    this.explodeVel = 0;
    this.hover = null;
    this.isolated = null;
    this.time = 0;

    this.parts = model.assemblies.map((def) => this._buildAssembly(def));
    this.byId = new Map(this.parts.map((p) => [p.def.id, p]));
    this.applyMode();
  }

  _buildAssembly(def) {
    const group = new THREE.Group();
    group.name = def.id;

    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(def.wire, 3));
    const wireMat = makeWireMaterial();
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    wire.frustumCulled = false;
    wire.renderOrder = 5;
    group.add(wire);

    const solids = def.solids.map(({ material, geometry }) => {
      const pbr = new THREE.MeshStandardMaterial({
        ...PBR[material],
        side: THREE.DoubleSide,
        envMapIntensity: 1.0,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geometry, pbr);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.pbr = pbr;
      mesh.userData.glass = makeGlassMaterial();
      group.add(mesh);
      return mesh;
    });

    this.content.add(group);
    return {
      def,
      group,
      wire,
      wireMat,
      solids,
      offset: new THREE.Vector3(...def.explode),
      vis: 1,
      hl: 0,
      anchor: new THREE.Vector3(...def.anchor),
    };
  }

  // ── state setters ──────────────────────────────────────────────────
  setMode(mode) {
    this.mode = mode;
    this.applyMode();
  }
  setGlass(on) {
    this.glass = on;
    this.applyMode();
  }
  setExplode(amount) {
    this.explodeTarget = amount;
  }
  setHover(id) {
    this.hover = id;
  }
  setIsolated(id) {
    this.isolated = id;
  }

  /** How much bigger the model's framing is right now (the exploded view spreads parts out ~30%). */
  get frameScale() {
    return 1 + 0.3 * THREE.MathUtils.clamp(this.explode, 0, 1.2);
  }

  /**
   * Post-processing / lighting look for the current mode: lit metal wants a high bloom
   * threshold and a little less exposure; glowing wire and glass want low-threshold bloom.
   * Shadows only matter when lit solids are visible.
   */
  get look() {
    const lit = this.mode !== 'wire' && !this.glass;
    return {
      bloomThreshold: lit ? 1.05 : 0.22,
      bloomStrength: lit ? 0.25 : this.glass ? 0.35 : 0.22,
      exposure: lit ? 0.9 : 1.0,
      shadows: lit,
    };
  }

  applyMode() {
    const showWire = this.mode !== 'solid';
    const showSolid = this.mode !== 'wire';
    for (const p of this.parts) {
      p.wire.visible = showWire;
      p.wireMat.depthTest = this.mode === 'both' && !this.glass;
      for (const m of p.solids) {
        m.visible = showSolid;
        m.material = this.glass ? m.userData.glass : m.userData.pbr;
        m.castShadow = !this.glass;
        m.receiveShadow = !this.glass;
      }
    }
  }

  // ── per-frame ──────────────────────────────────────────────────────
  /** @param {number} dt @param {THREE.Camera} camera */
  update(dt, camera) {
    this.time += dt;

    // exploded view: lightly under-damped spring → smooth separation with a hint of settle
    const k = 90;
    const c = 2 * 0.78 * Math.sqrt(k);
    this.explodeVel += (k * (this.explodeTarget - this.explode) - c * this.explodeVel) * Math.min(dt, 0.033);
    this.explode += this.explodeVel * Math.min(dt, 0.033);

    // depth cue range around the model's centre
    const camDist = camera.position.distanceTo(this.root.position);
    const r = this.radius * this.frameScale * this.root.scale.x;
    const near = Math.max(0.1, camDist - r * 1.05);
    const far = camDist + r * 1.15;

    const blend = 1 - Math.exp(-dt / 0.09);
    const baseWire = this.mode === 'both' ? 0.75 : 0.9;
    for (const p of this.parts) {
      p.group.position.copy(p.offset).multiplyScalar(this.explode);

      let visT = 1;
      let hlT = 0;
      if (this.isolated) {
        if (p.def.id === this.isolated) {
          hlT = 0.35;
        } else {
          visT = 0.06;
        }
      } else if (this.hover) {
        if (p.def.id === this.hover) hlT = 1;
        else visT = 0.3;
      }
      p.vis += (visT - p.vis) * blend;
      p.hl += (hlT - p.hl) * blend;

      const u = p.wireMat.uniforms;
      u.uOpacity.value = baseWire * p.vis;
      u.uMix.value = p.hl;
      u.uNear.value = near;
      u.uFar.value = far;
      u.uFade.value = this.mode === 'wire' ? 1 : 0.5;

      for (const m of p.solids) {
        if (!m.visible) continue;
        if (this.glass) {
          const g = m.userData.glass.uniforms;
          g.uOpacity.value = p.vis;
          g.uMix.value = p.hl;
          g.uTime.value = this.time;
        } else {
          const mat = m.userData.pbr;
          const ghost = p.vis < 0.995;
          if (mat.transparent !== ghost) {
            mat.transparent = ghost;
            mat.depthWrite = !ghost;
            mat.needsUpdate = true;
          }
          mat.opacity = p.vis;
          mat.emissive.setRGB(0.1 * p.hl, 0.55 * p.hl, 0.75 * p.hl);
          m.castShadow = p.vis > 0.5;
        }
      }
    }
  }

  /** World position of an assembly's label anchor (follows explode offset + rotation). */
  anchorWorld(id, out = new THREE.Vector3()) {
    const p = this.byId.get(id);
    out.copy(p.anchor).add(_tmp.copy(p.offset).multiplyScalar(this.explode));
    return this.content.localToWorld(out);
  }
}
