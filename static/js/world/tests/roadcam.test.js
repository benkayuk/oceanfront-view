// The camera view's arithmetic (roadcam_geom.js): frames off the comma's /video socket, the codec string, the
// fit and the projection of the model's lines.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_HEADER_BYTES, accelColor, avcCodec, fitStream, leadChevron, lineRibbon, modelFor, nalUnits, parseFrame,
  pathDistance, projectRaw, projector,
} from '../../roadcam_geom.js';

// What webhud sends for a calibrated comma 4 road camera at rpy 0, 1280x720 (sunnypilot webhud/video.py)
const K = [[1087.14, 0, 640], [0, 1080.79, 360], [0, 0, 1]];
const M = [[0, 1087.14, 0], [0, 0, 1080.79], [1, 0, 0]].map((row, r) => row.map((_, c) => {
  // K . view_from_device: view x = device y, view y = device z, view z = device x
  const view = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
  return K[r][0] * view[0][c] + K[r][1] * view[1][c] + K[r][2] * view[2][c];
}));

function frameBuffer({ key = true, camera = 0, frameId = 0, ts = 0n, payload = [] }) {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, key ? 1 : 0);
  v.setUint16(2, camera, true);
  v.setUint32(4, frameId, true);
  v.setBigUint64(8, ts, true);
  new Uint8Array(buf, FRAME_HEADER_BYTES).set(payload);
  return buf;
}

const SPS_PPS_IDR = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88];

describe('roadcam frames', () => {
  test('the header and the access unit come apart', () => {
    const f = parseFrame(frameBuffer({ key: true, camera: 1, frameId: 1234, ts: 98765432101n, payload: SPS_PPS_IDR }));
    assert.equal(f.key, true);
    assert.equal(f.camera, 'wide');
    assert.equal(f.frameId, 1234);
    assert.equal(f.tsNs, 98765432101);
    assert.deepEqual([...f.data], SPS_PPS_IDR);
    assert.equal(parseFrame(new ArrayBuffer(4)), null);
  });

  test('NAL units and the codec string from the SPS', () => {
    const data = Uint8Array.from(SPS_PPS_IDR);
    assert.deepEqual(nalUnits(data).map(([t]) => t), [7, 8, 5]);
    assert.equal(avcCodec(data), 'avc1.64001F');
    assert.equal(avcCodec(Uint8Array.from([0, 0, 1, 0x65, 0x88])), null);   // a delta frame has none
  });
});

describe('roadcam projection', () => {
  test('straight ahead is the principal point, and the road ahead is below it', () => {
    const [u, v] = projectRaw(M, 1000, 0, 0);
    assert.ok(Math.abs(u - 640) < 1e-6 && Math.abs(v - 360) < 1e-6);
    const [u2, v2] = projectRaw(M, 20, 0, 1.22);
    assert.equal(u2, 640);
    assert.ok(v2 > 400);
    assert.equal(projectRaw(M, -5, 0, 0), null);   // behind the camera
  });

  test('the stream covers the view, centred on the vanishing point as far as it can', () => {
    const fit = fitStream(1280, 720, 1920, 720, M, 1);
    assert.equal(fit.scale, 1.5);
    assert.equal(fit.tx, 0);
    assert.ok(fit.ty <= 0 && fit.ty >= 720 - 1.5 * 720);
    const p = projector(M, fit)(1000, 0, 0);
    assert.ok(Math.abs(p[0] - 960) < 1e-6);
  });

  test('a line becomes a ribbon out to the draw distance', () => {
    const line = [[0, 0, 1.2], [10, 0, 1.2], [20, 0, 1.2], [40, 0, 1.2]];
    const proj = projector(M, { scale: 1, tx: 0, ty: 0 });
    const poly = lineRibbon(line, 0.5, 0, 15, proj);
    // 10 and 15 (interpolated) each side; x = 0 is in the camera's own plane and can't be drawn
    assert.equal(poly.length, 4);
    assert.ok(poly[0][0] < 640 && poly[3][0] > 640);              // left edge, then the right edge back
    assert.ok(Math.abs(poly[1][1] - (360 + 1080.79 * 1.2 / 15)) < 1e-6);
    assert.deepEqual(lineRibbon([], 0.5, 0, 15, proj), []);
  });

  test('the path stops short of the lead', () => {
    const path = [[0, 0, 0], [50, 0, 0], [150, 0, 0]];
    assert.equal(pathDistance(path, null), 100);
    assert.equal(pathDistance(path, { d: 20 }), 30);               // 2 x 20 - min(14, 10)
    assert.equal(pathDistance([[0, 0, 0], [5, 0, 0]], null), 10);
  });

  test('the lead chevron fills as the lead gets close', () => {
    const far = leadChevron({ d: 60, v: 0 }, [500, 300], 1280, 720);
    const near = leadChevron({ d: 10, v: -5 }, [500, 300], 1280, 720);
    assert.equal(far.alpha, 0);
    assert.equal(near.alpha, 1);
    assert.equal(near.chevron[1][0], 500);
  });

  test('experimental colours: green speeding up, red slowing, fading up the path', () => {
    assert.match(accelColor(2, 0.2), /^hsla\(120,/);
    assert.match(accelColor(-2, 0.2), /^hsla\(0,/);
    assert.match(accelColor(0, 0.9), /, 0\.000\)$/);
  });

  test('each frame gets the model output computed from it', () => {
    const models = [{ frameId: 10, frameIdExtra: 10 }, { frameId: 11, frameIdExtra: 12 }, { frameId: 13, frameIdExtra: 13 }];
    assert.equal(modelFor(models, 11, 'road'), models[1]);
    assert.equal(modelFor(models, 12, 'road'), models[1]);          // none for 12: the latest before it
    assert.equal(modelFor(models, 12, 'wide'), models[1]);          // the wide camera's frame is frameIdExtra
    assert.equal(modelFor(models, 9, 'road'), null);
  });
});
