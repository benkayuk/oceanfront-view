// The comma's ticks folded into the car's own view (merge.js): the clock, which frames are taken, and the
// IBUS2 copies the comma's ADAS bus replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC, hexToBytes } from '../dbc.js';
import { StateBuilder } from '../state.js';
import { CommaMerge, COMMA_PREFER_S } from '../merge.js';
import { radarDbc } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ibusText = fs.readFileSync(path.join(here, '../../../../dbc/fisker_ocean_ibus.dbc'), 'latin1');

function carBuilder() {
  const b = new StateBuilder(new DBC(ibusText), radarDbc(), { gearMsg: 0x234, staleS: 3.0 });
  b.setBrand('fisker');
  return b;
}

const ACC = 0x313;    // ADAS_0x313, the ADAS module's own: native to the cam side
const SPEED = 0x318;  // ESP's speed: IBUS1 / the comma's vehicle bus
const HEX8 = '0102030405060708';

test('the ADAS messages are native to the cam side in the IBUS DBC, the vehicle ones are not', () => {
  const b = carBuilder();
  assert.equal(b.world.nativeBus.get(ACC), 2);
  assert.equal(b.world.nativeBus.get(SPEED), 0);
});

test('the clock offset is the fastest tick lately, and starts over after a jump', () => {
  const m = new CommaMerge(carBuilder());
  assert.equal(m.clock({ now: 100 }, 1100.05), 1000.05);
  assert.ok(Math.abs(m.clock({ now: 100.05 }, 1100.09) - 1000.04) < 1e-9);   // faster: taken at once
  const slow = m.clock({ now: 100.1 }, 1100.3);                               // slower: a small step toward it
  assert.ok(slow > 1000.04 && slow < 1000.05, String(slow));
  assert.equal(m.clock({ now: 5 }, 1100.4), 1095.4);                          // the bridge restarted
  assert.equal(m.clock({ now: 6, reset: true }, 1100.5), 1094.5);             // a new viewer's snapshot
});

test('only the ADAS module\'s messages and the radar are taken from the comma, on the page\'s clock', () => {
  const b = carBuilder();
  const m = new CommaMerge(b);
  const wall = 2000;
  m.feed({ now: 50, mode: 'live', can: [[49.9, [[ACC, 2, HEX8], [SPEED, 0, HEX8], [SPEED, 2, HEX8], [0x300, 1, '00'.repeat(48)]]]] }, wall);
  const acc = b.world.frames.get(ACC);
  assert.ok(acc, 'ADAS frame taken');
  assert.ok(Math.abs(acc[1] - (49.9 + 1950)) < 1e-9, 're-stamped onto the wall clock');
  assert.equal(b.world.frames.get(SPEED), undefined, 'the comma\'s vehicle-bus frames are not IBUS1\'s');
  assert.ok(b.radar.frames.get(0x300), 'radar header taken');
  assert.ok(m.active(wall + 0.5) && !m.active(wall + 2));
});

test('an IBUS2 copy of a message the comma gives is dropped; IBUS1 and other messages pass', () => {
  const m = new CommaMerge(carBuilder());
  const wall = 3000;
  m.feed({ now: 10, mode: 'live', can: [[10, [[ACC, 2, HEX8]]]] }, wall);
  const frames = [[ACC, hexToBytes(HEX8), 2], [0x31C, hexToBytes(HEX8), 2], [SPEED, hexToBytes(HEX8), 0]];
  assert.deepEqual(m.filterIbus(frames, wall + 0.1).map(f => f[0]), [0x31C, SPEED]);
  assert.deepEqual(m.filterIbus(frames, wall + COMMA_PREFER_S + 0.1).map(f => f[0]), [ACC, 0x31C, SPEED]);
});

test('openpilot\'s services join the car\'s view; carParams leaves the decoder on', () => {
  const b = carBuilder();
  const m = new CommaMerge(b);
  const wall = 4000;
  m.feed({ now: 20, mode: 'live', op: [
    ['carParams', 19, { brand: 'toyota' }],
    ['carState', 20, { vEgo: 12, gear: 'drive' }],
    ['radarState', 20, { leadOne: null, leadTwo: null, mdMonoTime: 19.95 }],
  ] }, wall);
  assert.equal(b.brand, 'fisker');
  assert.ok(Math.abs(b.serviceT.carState - 3980 - 20) < 1e-9);
  assert.ok(Math.abs(b.services.radarState.mdMonoTime - (19.95 + 3980)) < 1e-9);
  const snap = b.snapshot(wall);
  assert.equal(snap.op.carState.vEgo, 12);
});
