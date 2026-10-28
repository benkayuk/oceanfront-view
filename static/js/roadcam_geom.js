// The camera view's arithmetic (roadcam.js): the comma's /video frames, the H.264 codec string, fitting the
// stream to the screen, and projecting the model's lines onto it the way the comma's own driving screen does
// (sunnypilot selfdrive/ui/onroad/model_renderer.py). No DOM here, so Node tests it.

export const FRAME_HEADER_BYTES = 16;   // <BBHIQ: kind, flags, camera, frameId, timestampEof (ns)
export const CAMERAS = ['road', 'wide'];
export const MIN_DRAW_DISTANCE = 10, MAX_DRAW_DISTANCE = 100;
export const PATH_HALF_WIDTH = 0.9;     // m
export const LINE_HALF_WIDTH = 0.025;   // m, times the lane line's probability
export const ZOOM = { road: 1.1, wide: 1.0 };

/** A binary /video message: {key, camera, frameId, tsNs, data}, or null if it isn't a frame. */
export function parseFrame(buf) {
  if (!buf || buf.byteLength < FRAME_HEADER_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 1) return null;
  return {
    key: (v.getUint8(1) & 1) === 1,
    camera: CAMERAS[v.getUint16(2, true)] || 'road',
    frameId: v.getUint32(4, true),
    tsNs: Number(v.getBigUint64(8, true)),
    data: new Uint8Array(buf, FRAME_HEADER_BYTES),
  };
}

/** The NAL units of an Annex B access unit, as [type, offset of the unit's first byte after its start code]. */
export function nalUnits(data) {
  const out = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const start = i + (data[i + 2] === 1 ? 3 : 4);
      if (start < data.length) out.push([data[start] & 0x1f, start]);
      i = start;
    }
  }
  return out;
}

/** 'avc1.PPCCLL' from the access unit's SPS (profile, constraints, level), or null without one. */
export function avcCodec(data) {
  const sps = nalUnits(data).find(([type]) => type === 7);
  if (!sps || sps[1] + 3 >= data.length) return null;
  const hex = (b) => b.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(data[sps[1] + 1])}${hex(data[sps[1] + 2])}${hex(data[sps[1] + 3])}`;
}

/** Applies a 3x3 matrix to [x, y, z]; [u, v] in the stream's pixels, or null behind the camera. */
export function projectRaw(M, x, y, z) {
  const w = M[2][0] * x + M[2][1] * y + M[2][2] * z;
  if (w < 1e-6) return null;
  return [(M[0][0] * x + M[0][1] * y + M[0][2] * z) / w, (M[1][0] * x + M[1][1] * y + M[1][2] * z) / w];
}

/**
 * Where the stream goes on a view of vw x vh: covering it, `zoom` times more, and centred on the vanishing
 * point (straight ahead) as far as the frame still covers the view. Screen = scale * stream + [tx, ty].
 */
export function fitStream(width, height, vw, vh, M = null, zoom = 1) {
  const scale = Math.max(vw / width, vh / height) * zoom;
  const vp = (M && projectRaw(M, 1000, 0, 0)) || [width / 2, height / 2];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    scale,
    tx: clamp(vw / 2 - scale * vp[0], vw - scale * width, 0),
    ty: clamp(vh / 2 - scale * vp[1], vh - scale * height, 0),
  };
}

/** A projector from the car frame (x forward, y right, z down) to the screen, for a stream fitted by `fit`. */
export function projector(M, fit) {
  return (x, y, z) => {
    const p = projectRaw(M, x, y, z);
    return p && [fit.scale * p[0] + fit.tx, fit.scale * p[1] + fit.ty];
  };
}

/** The index of the last point at or before x = d (0 if none). */
export function indexAt(points, d) {
  let idx = 0;
  for (let i = 0; i < points.length; i++) if (points[i][0] <= d) idx = i;
  return idx;
}

/**
 * A line of [x, y, z] points as a ribbon `halfWidth` wide either side, `zOff` lower, out to maxDistance:
 * the left edge forward and the right edge back, on screen (model_renderer.py _map_line_to_polygon).
 */
export function lineRibbon(points, halfWidth, zOff, maxDistance, project) {
  if (!points || !points.length) return [];
  const maxIdx = indexAt(points, maxDistance);
  let pts = points.slice(0, maxIdx + 1);
  if (maxIdx > 0 && maxIdx < points.length - 1) {   // end exactly at maxDistance so the path's end doesn't jump
    const [x0, y0, z0] = points[maxIdx], [x1, y1, z1] = points[maxIdx + 1];
    const f = x1 > x0 ? (maxDistance - x0) / (x1 - x0) : 0;
    pts.push([maxDistance, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f]);
  }
  pts = pts.filter(p => p[0] >= 0);
  const left = [], right = [];
  for (const [x, y, z] of pts) {
    const l = project(x, y - halfWidth, z + zOff), r = project(x, y + halfWidth, z + zOff);
    if (l && r) { left.push(l); right.push(r); }
  }
  if (left.length < 2) return [];
  return left.concat(right.reverse());
}

/** How far the path is drawn: the model's reach, short of the lead (model_renderer.py _update_model). */
export function pathDistance(path, lead) {
  if (!path || !path.length) return 0;
  let d = Math.min(MAX_DRAW_DISTANCE, Math.max(MIN_DRAW_DISTANCE, path[path.length - 1][0]));
  if (lead) {
    const leadD = lead.d * 2;
    d = Math.min(d, Math.max(0, leadD - Math.min(leadD * 0.35, 10)));
  }
  return d;
}

/** The lead's chevron and glow (model_renderer.py _update_lead_vehicle), at its screen point [x, y]. */
export function leadChevron(lead, point, vw, vh) {
  const speedBuff = 10, leadBuff = 40;
  let alpha = 0;
  if (lead.d < leadBuff) {
    alpha = 255 * (1 - lead.d / leadBuff);
    if (lead.v < 0) alpha += 255 * (-lead.v / speedBuff);
    alpha = Math.min(alpha, 255);
  }
  const sz = Math.min(30, Math.max(15, (25 * 30) / (lead.d / 3 + 30))) * 2.35 * Math.min(1, vh / 1080);
  const x = Math.min(Math.max(point[0], 0), vw - sz / 2);
  const y = Math.min(point[1], vh - sz * 0.6);
  const gx = sz / 5, gy = sz / 10;
  return {
    glow: [[x + sz * 1.35 + gx, y + sz + gy], [x, y - gy], [x - sz * 1.35 - gx, y + sz + gy]],
    chevron: [[x + sz * 1.25, y + sz], [x, y], [x - sz * 1.25, y + sz]],
    alpha: alpha / 255,
  };
}

/** The colour along the path in experimental mode, from the planned acceleration (model_renderer.py). */
export function accelColor(a, along) {
  const hue = Math.min(120, Math.max(0, 60 + a * 35));
  const sat = Math.min(Math.abs(a * 1.5), 1);
  const light = 0.95 + (0.62 - 0.95) * sat;
  const alpha = along <= 0.375 ? 0.4 : along >= 0.75 ? 0 : 0.4 * (0.75 - along) / 0.375;
  return `hsla(${hue.toFixed(0)}, ${(sat * 100).toFixed(0)}%, ${(light * 100).toFixed(0)}%, ${alpha.toFixed(3)})`;
}

/** The model output for a frame: the one computed from it, else the latest before it. */
export function modelFor(models, frameId, camera) {
  let best = null;
  for (const m of models) {
    const id = camera === 'wide' ? (m.frameIdExtra || m.frameId) : m.frameId;
    if (id === frameId) return m;
    if (id < frameId && (!best || id > (camera === 'wide' ? (best.frameIdExtra || best.frameId) : best.frameId))) best = m;
  }
  return best;
}
