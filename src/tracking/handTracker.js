/**
 * Webcam + MediaPipe HandLandmarker wrapper.
 * Responsible only for getting raw landmarks out of the camera; everything
 * downstream (filtering, gestures) lives in handPipeline.js / gestures.js.
 */
// @mediapipe/tasks-vision is imported lazily (see loadModel) so the app boots without it.

const BASE = import.meta.env.BASE_URL || '/';
const LOCAL_WASM = `${BASE}wasm`;
const LOCAL_MODEL = `${BASE}models/hand_landmarker.task`;
// pinned to the installed package (injected by vite.config.js) so the WASM ABI always matches the JS loader
const MP_VERSION = typeof __MEDIAPIPE_VERSION__ !== 'undefined' ? __MEDIAPIPE_VERSION__ : '1.2.2';
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html'); // SPA fallbacks return html
  } catch {
    return false;
  }
}

export class CameraError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // denied | notfound | insecure | unsupported | busy | other
  }
}

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.active = false;
    this.lastVideoTime = -1;
    this.lastTs = 0;
    this.delegate = '';
  }

  /** Loads once; concurrent callers share the same promise. */
  loadModel(onStatus = () => {}) {
    if (!this._loading) this._loading = this._loadModel(onStatus).catch((err) => {
      this._loading = null; // allow a retry after a failure
      throw err;
    });
    return this._loading;
  }

  async _loadModel(onStatus) {
    if (this.landmarker) return;
    onStatus('Loading hand-tracking model…');
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const haveLocal = (await exists(`${LOCAL_WASM}/vision_wasm_internal.wasm`)) && (await exists(LOCAL_MODEL));
    const wasm = haveLocal ? LOCAL_WASM : CDN_WASM;
    const model = haveLocal ? LOCAL_MODEL : CDN_MODEL;
    const fileset = await FilesetResolver.forVisionTasks(wasm);
    const make = (delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[tracker] GPU delegate failed, falling back to CPU', err);
      this.landmarker = await make('CPU');
      this.delegate = 'CPU';
    }
  }

  async start(onStatus = () => {}) {
    if (!window.isSecureContext) throw new CameraError('insecure', 'Camera access needs HTTPS or localhost.');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported', 'This browser has no camera API.');
    await this.loadModel(onStatus);
    onStatus('Requesting camera…');
    try {
      this.stream?.getTracks().forEach((t) => t.stop()); // never orphan a previous stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, min: 24 } },
        audio: false,
      });
    } catch (err) {
      const map = { NotAllowedError: 'denied', PermissionDeniedError: 'denied', NotFoundError: 'notfound', OverconstrainedError: 'notfound', NotReadableError: 'busy' };
      throw new CameraError(map[err.name] || 'other', err.message || 'Camera unavailable');
    }
    this.video.srcObject = this.stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();
    this.lastVideoTime = -1;
    this.active = true;
  }

  stop() {
    this.active = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get aspectInv() {
    return this.video.videoWidth ? this.video.videoHeight / this.video.videoWidth : 0.75;
  }

  /** Returns {hands, t(seconds)} when a new camera frame was analysed, else null. */
  detect() {
    if (!this.active || !this.landmarker) return null;
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 0.01;
    this.lastTs = ts;
    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch (err) {
      console.warn('[tracker] detect failed', err);
      return null;
    }
    const hands = (res.landmarks || []).map((lm, i) => ({
      landmarks: lm,
      world: res.worldLandmarks?.[i] ?? lm,
    }));
    return { hands, t: ts / 1000 };
  }
}
