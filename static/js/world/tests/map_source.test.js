// The OSM map follows the position source (state.js setPositionSource): a drive on a real road from the fixture
// tile, with the car's buses through the IBUS DBC and a TBOX that puts the car on another road 10 km away. On
// 'car' the map matches the TBOX's road; on 'device' the screen's fixes place the car and the map matches the road
// it is really on; switching mid-drive moves the map over at once.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC } from '../dbc.js';
import { MapData } from '../mapdata.js';
import { StateBuilder } from '../state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ibusDbc = new DBC(fs.readFileSync(path.join(here, '../../../../dbc/fisker_ocean_ibus.dbc'), 'latin1'));
const TILE_FILE = '32.000000_-83.500000_32.250000_-83.250000';
const TILE = new Uint8Array(fs.readFileSync(path.join(here, 'fixtures/osm_' + TILE_FILE)));
const DEG = Math.PI / 180, R = 6378137.0;

// two straight stretches of road in the tile (from its own geometry), each driven from `a` toward `b`
const REAL = { name: 'Log Cabin Road', a: [32.165405, -83.306885], b: [32.1999159, -83.2660331] };
const TBOX = { name: 'Woodard Road', a: [32.181038, -83.4010433], b: [32.217583, -83.356878] };

/** The point s meters from road.a toward road.b, and the bearing (deg, clockwise from north). */
function along(road, s) {
  const [la, lo] = road.a, [lb, lob] = road.b, c = Math.cos(la * DEG);
  const n = (lb - la) * DEG * R, e = (lob - lo) * DEG * R * c, len = Math.hypot(n, e);
  return { lat: la + (n / len) * s / (DEG * R), lon: lo + (e / len) * s / (DEG * R * c), bearing: (Math.atan2(e, n) / DEG + 360) % 360 };
}

function builder() {
  const md = new MapData(async (cell, file) => (cell === '32/-84' && file === TILE_FILE ? TILE : null), async () => null);
  const b = new StateBuilder(ibusDbc, null, { gearMsg: 0x234, mapData: md });
  b.setBrand('fisker');
  return b;
}

const settle = () => new Promise(r => setImmediate(r));

/** Drive straight at v for `seconds` from t0: odometry at 100 Hz, the TBOX's fixes and heading on its road and the
 *  screen's fixes on the real one at 10 Hz (both 0.2-0.3 s late, as measured). `at(t)` runs before each 0.1 s. */
async function drive(b, { t0 = 0, seconds = 12, v = 15, at = null } = {}) {
  const enc = (addr, values) => ibusDbc.messages.get(addr).encode(values);
  const kph = v / 1.031 * 3.6;
  let snap = null;
  for (let i = 0; i <= Math.round(seconds * 100); i++) {
    const t = t0 + i / 100;
    if (i % 10 === 0 && at) at(t);
    const frames = [[0x318, enc(0x318, { ESP_VehSpd: kph, ESP_VehSpdVld: 1 }), 0], [0x112, enc(0x112, { YRS_YawRate: 0.0 }), 0],
                    [0x234, enc(0x234, { VCU_GearSig: 4 }), 0]];
    if (i % 10 === 0) {
      const p = along(TBOX, 200 + v * Math.max(0, t - 0.2));
      frames.push([0x526, enc(0x526, { TBOX_GPSLati: p.lat, TBOX_GPSLongi: p.lon }), 2], [0x179, enc(0x179, { TBOX_Heading: p.bearing, TBOX_HeadingStdDev: 0.15 }), 0]);
    }
    b.feedCan(frames, t);
    if (i % 10 === 0 && t >= 0.3) {
      const p = along(REAL, 200 + v * (t - 0.3));
      b.feedLocation({ lat: p.lat, lon: p.lon, acc: 4, speed: v, bearing: p.bearing, fixT: t - 0.3 }, t);
    }
    if (i % 10 === 0) {
      snap = b.snapshot(t);
      await settle();   // the tile loads
    }
  }
  return snap;
}

const near = (pose, road, s, m) => {
  const p = along(road, s);
  const d = Math.hypot((pose.lat - p.lat) * DEG * R, (pose.lon - p.lon) * DEG * R * Math.cos(p.lat * DEG));
  assert.ok(d < m, `${d.toFixed(1)} m from ${road.name}`);
};

describe('the OSM map follows the position source', () => {
  test("'car': the TBOX's fixes place the car and the map matches its road", async () => {
    const b = builder();
    const s = await drive(b);
    near(s.pose, TBOX, 200 + 15 * 12, 5);
    assert.equal(s.map.way.name, TBOX.name);
    assert.ok(s.map.distance < 5, `distance ${s.map.distance}`);
  });

  test("'device': the screen's fixes place the car, the map matches the road it's on, and the roads layer is built there", async () => {
    const b = builder();
    b.setPositionSource('device');
    const s = await drive(b);
    near(s.pose, REAL, 200 + 15 * 12, 5);
    assert.ok(Math.abs(((s.pose.h / DEG) - (90 - along(REAL, 0).bearing) + 540) % 360 - 180) < 3, `heading ${s.pose.h / DEG}`);
    assert.equal(s.map.way.name, REAL.name);
    assert.ok(s.map.distance < 5 && s.map.conf > 0.5, `distance ${s.map.distance}, conf ${s.map.conf}`);
    assert.ok(Math.abs(b.map.origin.lat - REAL.a[0]) < 0.01 && Math.abs(b.map.origin.lon - REAL.a[1]) < 0.01, 'the map frame is anchored on the real road');
    assert.ok(b._roads && b._roads.layer.ways.some(w => w.name === REAL.name), 'the roads layer has the road');
  });

  test('switching mid-drive moves the map to the new source at once, and back', async () => {
    const b = builder();
    let s = await drive(b, { seconds: 8 });
    assert.equal(s.map.way.name, TBOX.name);
    const seq = b.pose.seq;
    b.setPositionSource('device');
    s = await drive(b, { t0: 8.1, seconds: 4 });
    assert.ok(b.pose.seq > seq, 'a new origin');
    near(s.pose, REAL, 200 + 15 * 12.1, 5);
    assert.equal(s.map.way.name, REAL.name);
    b.setPositionSource('car');
    s = await drive(b, { t0: 12.2, seconds: 4 });
    near(s.pose, TBOX, 200 + 15 * 16.2, 5);
    assert.equal(s.map.way.name, TBOX.name);
  });
});
