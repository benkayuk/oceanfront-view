// The VCU's energy counters (energy.js): their signals in the generated tables, their scaling, and the log behind the graphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNALS, decodeFrame, packFrame } from '../../carstate.js';
import { MODES, MODE_SIGNAL, EnergyLog, niceMax } from '../../energy.js';

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)));

test('every signal the energy details read is in the tables, on IBUS1', () => {
  const names = [MODE_SIGNAL];
  for (const m of MODES) { names.push(m.total); for (const r of m.rows) names.push(r.sig, r.perc); }
  for (const n of names) {
    const s = SIGNALS.get(n);
    assert.ok(s, n);
    assert.equal(s.bus, 'IBUS1', n);
    assert.ok(s.addr >= 0x578 && s.addr <= 0x57C, n);
  }
  assert.equal(new Set(names).size, names.length);
});

test('the counters decode to kWh in 0.1 steps, the shares to percent, the view type to its enum', () => {
  const f = packFrame('IBUS1', 0x578, { VCU_NotChrgModVehDrvCnseEgy: 1234, VCU_NotChrgModExtDchaCnseEgy: 7 });
  const d = decodeFrame('IBUS1', 0x578, bytes(f.data));
  assert.ok(Math.abs(d.VCU_NotChrgModVehDrvCnseEgy - 123.4) < 1e-9);
  assert.ok(Math.abs(d.VCU_NotChrgModExtDchaCnseEgy - 0.7) < 1e-9);
  assert.equal(d.VCU_NotChrgModECCCnseEgy, 0);
  const g = packFrame('IBUS1', 0x57C, { VCU_ChrgModVehChrgEgyPerc: 1000, VCU_ChrgModChrgEffCnseEgyPerc: 123, VCU_ActEgyCnsTyp: 2 });
  const e = decodeFrame('IBUS1', 0x57C, bytes(g.data));
  assert.ok(Math.abs(e.VCU_ChrgModVehChrgEgyPerc - 100) < 1e-9);
  assert.ok(Math.abs(e.VCU_ChrgModChrgEffCnseEgyPerc - 12.3) < 1e-9);
  assert.equal(e.VCU_ActEgyCnsTyp, 2);
  assert.equal(SIGNALS.get(MODE_SIGNAL).enum[2], 'Inactive_(energy_consumption_Wh_per_km)');
});

test('the log counts up the positive steps only, so a reset adds nothing, and keeps one sample before the window', () => {
  const log = new EnergyLog(10);
  const vals = [10.0, 10.1, 10.3, 10.3, 0.0, 0.2, undefined, 0.5];
  vals.forEach((v, i) => log.push(i, { a: v }));
  assert.ok(Math.abs(log.used('a') - 0.8) < 1e-9);
  assert.deepEqual(log.series('a').map(p => +p[1].toFixed(2)), [0, 0.1, 0.3, 0.3, 0.3, 0.5, 0.5, 0.8]);
  for (let i = 8; i < 30; i++) log.push(i, { a: 0.5 });
  assert.equal(log.samples[0].t, 18);   // t=29: the window starts at 19, and the sample before it is kept
  assert.equal(log.span, 11);
  assert.equal(log.used('a'), 0);
});

test('the average power is read between the counter\'s step edges, so the 0.1 kWh steps do not bias it', () => {
  const log = new EnergyLog(600);
  // 20 kW: a 0.1 kWh step every 18 s, sampled twice a second
  for (let t = 0; t <= 60; t += 0.5) log.push(t, { a: 10 + 0.1 * Math.floor(t / 18), b: 5 });
  assert.equal(log.rate(['b']), null);                       // never stepped
  assert.ok(Math.abs(log.rate(['a']) - 20) < 1e-6);          // steps at 18, 36, 54: 0.2 kWh over 36 s
  assert.ok(Math.abs(log.rate(['a', 'b']) - 20) < 1e-6);
  const one = new EnergyLog(600);
  for (let t = 0; t <= 30; t += 0.5) one.push(t, { a: 10 + 0.1 * Math.floor(t / 18) });
  assert.equal(one.rate(['a']), null);                       // one step: no interval yet
});

test('the scale rounds up to a round number', () => {
  assert.equal(niceMax(0.1), 0.1);
  assert.equal(niceMax(0.13), 0.2);
  assert.equal(niceMax(0.7), 1);
  assert.equal(niceMax(1.5), 2);
  assert.equal(niceMax(3), 5);
  assert.equal(niceMax(7.2), 10);
  assert.equal(niceMax(11), 20);
});
