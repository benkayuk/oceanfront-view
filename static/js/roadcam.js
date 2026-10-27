// The camera view: the comma's road camera with what its own driving screen draws over it (the model's path,
// lane lines, road edges and the lead), from sunnypilot's webhud /video socket (relayed by the app like /ws).
// The video is H.264 from the comma's livestream encoder, decoded here with WebCodecs; the overlay is drawn
// here too, onto each frame from the model output computed from that frame (roadcam_geom.js has the maths).
import { $, setClass, setText } from './util.js';
import {
  CAMERAS, LINE_HALF_WIDTH, PATH_HALF_WIDTH, ZOOM, accelColor, avcCodec, fitStream, leadChevron, lineRibbon,
  modelFor, parseFrame, pathDistance, projector, indexAt,
} from './roadcam_geom.js';

const MODELS_KEPT = 30;          // 1.5 s of model output, to match frames against
const MODEL_WAIT_MS = 150;       // a frame waits this long for its model output before it's shown without it
const STALL_MS = 4000;           // no frame for this long: say so, and reconnect after twice that
const MAX_DECODE_QUEUE = 4;      // a decoder this far behind skips to the next keyframe
const PATH_COLORS = {            // bottom to top (model_renderer.py THROTTLE_COLORS / NO_THROTTLE_COLORS)
  throttle: ['rgba(13,248,122,.4)', 'rgba(114,255,92,.35)', 'rgba(114,255,92,0)'],
  idle: ['rgba(242,242,242,.4)', 'rgba(242,242,242,.35)', 'rgba(242,242,242,0)'],
};

export class RoadCam {
  constructor(app) {
    this.app = app;
    this.root = $('#roadcam');
    this.canvas = $('#roadcam-canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.status = $('#roadcam-status');
    this.camera = 'road';
    this.isOpen = false;
    this.ws = null;
    this.retry = 0;
    this.decoder = null;
    this.configuring = false;
    this.codec = null;
    this.needKey = true;
    this.pending = [];            // decoded frames waiting for their model output: {frame, frameId, camera, at}
    this.shown = null;            // the frame on screen
    this.models = [];
    this.calib = null;
    this.error = null;
    this.lastFrameAt = 0;
    this.dirty = false;
    for (const b of this.root.querySelectorAll('[data-roadcam]')) {
      b.addEventListener('click', () => this.setCamera(b.dataset.roadcam));
    }
  }

  static get supported() { return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window; }

  open(camera = this.camera) {
    this.camera = CAMERAS.includes(camera) ? camera : 'road';
    this.markCamera();
    if (this.isOpen) { this.send({ type: 'camera', camera: this.camera }); return; }
    this.isOpen = true;
    setClass(this.root, 'hidden', false);
    document.body.classList.add('roadcam-on');
    this.markButton();
    if (!RoadCam.supported) { this.say('This screen can’t decode the camera video (no WebCodecs in its WebView).'); return; }
    this.say('Connecting to the comma…');
    this.connect();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    setClass(this.root, 'hidden', true);
    document.body.classList.remove('roadcam-on');
    this.markButton();
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* gone */ } }
    this.resetDecoder();
    if (this.shown) { this.shown.frame.close(); this.shown = null; }
    this.models = [];
  }

  setCamera(camera) {
    if (!CAMERAS.includes(camera) || camera === this.camera) return;
    this.camera = camera;
    this.markCamera();
    this.app.setSetting?.('roadcam', camera);
    this.resetDecoder();   // its output is tied to the camera it decodes
    this.send({ type: 'camera', camera });
  }

  /** The dock's live camera button shows whether the camera view is up. */
  markButton() {
    const b = $('#btn-roadcam');
    if (!b) return;
    setClass(b, 'on', this.isOpen);
    b.setAttribute('aria-pressed', String(this.isOpen));
  }

  markCamera() {
    for (const b of this.root.querySelectorAll('[data-roadcam]')) setClass(b, 'on', b.dataset.roadcam === this.camera);
  }

  say(text) {
    setText(this.status, text || '');
    setClass(this.status, 'hidden', !text);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ---- the socket ----------------------------------------------------------------------------------------
  connect() {
    clearTimeout(this.retryTimer);
    if (!this.isOpen) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/video?camera=${this.camera}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.needKey = true;
    this.lastFrameAt = performance.now();   // the stall clock starts now
    ws.onopen = () => { if (this.ws === ws) { this.retry = 0; this.lastFrameAt = performance.now(); } };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onText(ev.data);
      else this.onFrame(parseFrame(ev.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.isOpen) return;
      if (!this.shown) this.say(this.app.commaConnected ? 'The comma’s camera isn’t answering. Trying again…' : 'The camera view needs the comma.');
      this.retryTimer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
    ws.onerror = () => ws.close();
  }

  onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'model') {
      this.models.push(msg);
      if (this.models.length > MODELS_KEPT) this.models.shift();
      this.dirty = true;
    } else if (msg.type === 'calib') {
      this.calib = msg;
      this.dirty = true;
    } else if (msg.type === 'error') {
      this.error = msg.message;
      if (!this.shown) this.say(`The comma couldn’t start the camera: ${msg.message}`);
    }
  }

  // ---- decoding ------------------------------------------------------------------------------------------
  onFrame(f) {
    if (!f || f.camera !== this.camera) return;
    this.lastFrameAt = performance.now();
    if (this.needKey && !f.key) return;
    if (f.key && !this.decoder) {
      if (!this.configuring) {
        const codec = avcCodec(f.data);
        if (codec) this.makeDecoder(codec);
      }
      return;   // decoding starts at the keyframe after the decoder is set up (one every 5 frames)
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE && !f.key) { this.needKey = true; return; }
    this.needKey = false;
    try {
      // the timestamp carries the frame id through the decoder
      this.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.frameId, data: f.data }));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Hardware decoding where the WebView offers it for this stream, else software. */
  async makeDecoder(codec) {
    this.configuring = true;
    const camera = this.camera;
    try {
      let config = null;
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const c = { codec, optimizeForLatency: true, hardwareAcceleration: hw };   // Annex B (SPS/PPS in band): no description
        if ((await VideoDecoder.isConfigSupported(c)).supported) { config = c; break; }
      }
      if (!this.isOpen || camera !== this.camera || this.decoder) return;
      if (!config) { this.error = `this screen can’t decode ${codec}`; this.say(`This screen can’t decode the camera’s video (${codec}).`); return; }
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (!this.isOpen || camera !== this.camera || decoder !== this.decoder) { frame.close(); return; }
          this.pending.push({ frame, frameId: frame.timestamp, camera, at: performance.now() });
          while (this.pending.length > 4) this.pending.shift().frame.close();
        },
        error: (e) => this.fail(e),
      });
      decoder.configure(config);
      this.codec = codec;
      this.decoder = decoder;
      this.needKey = true;
    } catch (e) {
      this.fail(e);
    } finally {
      this.configuring = false;
    }
  }

  fail(e) {
    this.app.reportError?.(e);
    this.resetDecoder();
  }

  resetDecoder() {
    if (this.decoder) { try { this.decoder.close(); } catch { /* closed */ } }
    this.decoder = null;
    this.needKey = true;
    this.dropPending();
  }

  dropPending() {
    for (const p of this.pending) p.frame.close();
    this.pending = [];
  }

  // ---- drawing (every animation frame, from main.js) ------------------------------------------------------
  frame() {
    if (!this.isOpen) return;
    const now = performance.now();
    const next = this.pick(now);
    if (next) {
      if (this.shown) this.shown.frame.close();
      this.shown = next;
      this.dirty = true;
      if (this.status.textContent) this.say('');
    } else if (this.ws && now - this.lastFrameAt > STALL_MS) {
      // the encoder takes a few seconds to come up (camerad too, parked)
      this.say(this.error ? `The comma couldn’t start the camera: ${this.error}` : 'Waiting for the comma’s camera…');
      if (now - this.lastFrameAt > 3 * STALL_MS) { this.lastFrameAt = now; this.reconnect(); }
    }
    if (this.dirty) this.draw();
  }

  reconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* gone */ } }
    this.resetDecoder();
    this.connect();
  }

  /** The newest decoded frame whose model output is here, or that has waited long enough without it. */
  pick(now) {
    if (!this.pending.length) return null;
    const latest = this.models.length ? this.models[this.models.length - 1] : null;
    const latestId = latest ? (this.camera === 'wide' ? (latest.frameIdExtra || latest.frameId) : latest.frameId) : -1;
    let idx = -1;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.frameId <= latestId || now - p.at > MODEL_WAIT_MS) { idx = i; break; }
    }
    if (idx < 0) return null;
    for (let i = 0; i < idx; i++) this.pending[i].frame.close();
    const [chosen] = this.pending.splice(0, idx + 1).slice(-1);
    return chosen;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.root.clientWidth * dpr), h = Math.round(this.root.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return [w, h];
  }

  draw() {
    this.dirty = false;
    const [vw, vh] = this.resize();
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);
    if (!this.shown) return;
    const { frame, frameId, camera } = this.shown;
    const width = frame.displayWidth, height = frame.displayHeight;
    const cam = this.calib?.cameras?.[camera];
    const M = cam?.M && cam.width === width && cam.height === height ? cam.M : null;
    const fit = fitStream(width, height, vw, vh, M, ZOOM[camera]);
    ctx.drawImage(frame, fit.tx, fit.ty, width * fit.scale, height * fit.scale);
    const model = M ? modelFor(this.models, frameId, camera) : null;
    if (model) this.drawModel(ctx, model, projector(M, fit), vw, vh);
  }

  drawModel(ctx, m, project, vw, vh) {
    const fill = (poly, style) => {
      if (poly.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    };
    const path = m.path || [];
    if (!path.length) return;
    const reach = pathDistance(path, null);
    (m.lanes || []).forEach((line, i) => {
      const p = m.laneProbs?.[i] ?? 0;
      fill(lineRibbon(line, LINE_HALF_WIDTH * p, 0, reach, project), `rgba(255,255,255,${Math.min(0.7, Math.max(0, p))})`);
    });
    (m.edges || []).forEach((line, i) => {
      const a = Math.min(1, Math.max(0, 1 - (m.edgeStds?.[i] ?? 1)));
      fill(lineRibbon(line, LINE_HALF_WIDTH, 0, reach, project), `rgba(255,0,0,${a})`);
    });

    const lead = m.leads?.[0] || null;
    const ribbon = lineRibbon(path, PATH_HALF_WIDTH, m.pathZ || 0, pathDistance(path, lead), project);
    if (ribbon.length >= 3) {
      const ys = ribbon.map(p => p[1]);
      const bottom = Math.min(vh, Math.max(...ys)), top = Math.max(0, Math.min(...ys));
      const g = ctx.createLinearGradient(0, bottom, 0, top);
      if (m.experimental && m.accel?.length) {
        // colored by the planned acceleration along the path: each point's color where it lands on screen
        const n = Math.min(Math.floor(ribbon.length / 2), m.accel.length);
        for (let i = 0; i < n; i += 2) {
          const y = ribbon[i][1];
          if (y < 0 || y > vh) continue;
          const along = 1 - y / vh;
          g.addColorStop(Math.min(1, Math.max(0, (bottom - y) / Math.max(1, bottom - top))), accelColor(m.accel[i], along));
        }
      } else {
        const colors = m.allowThrottle || !m.longControl ? PATH_COLORS.throttle : PATH_COLORS.idle;
        colors.forEach((c, i) => g.addColorStop(i / 2, c));
      }
      fill(ribbon, g);
    }

    if (m.longControl) {
      for (const ld of m.leads || []) {
        const i = indexAt(path, ld.d);
        const z = (path[i]?.[2] || 0) + (m.pathZ || 0);
        const pt = project(ld.d, ld.y, z);
        if (!pt) continue;
        const c = leadChevron(ld, pt, vw, vh);
        fill(c.glow, 'rgb(218,202,37)');
        fill(c.chevron, `rgba(201,34,49,${c.alpha})`);
      }
    }
  }
}
