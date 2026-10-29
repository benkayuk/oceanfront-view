// A road's full OSM detail (roaddetail.js) and how it reaches the matched way, the road reference and the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWidth, parseTurns, wayDetail, laneLayout } from '../roaddetail.js';
import { MapData, keyOf } from '../mapdata.js';
import { decodeTile, tileFor } from '../osmtile.js';
import { FIXTURE } from './osmtile.test.js';
import { mapReference, roadNetwork, laneCenters } from '../../mapsurface.js';

describe('parsing', () => {
  test('widths in meters and feet; nonsense is null', () => {
    assert.equal(parseWidth('7'), 7);
    assert.equal(parseWidth('7.5 m'), 7.5);
    assert.equal(parseWidth('6,5'), 6.5);
    assert.ok(Math.abs(parseWidth("23'") - 7.0104) < 1e-9);
    assert.ok(Math.abs(parseWidth('6\'6"') - 1.9812) < 1e-9);
    assert.equal(parseWidth('narrow'), null);
    assert.equal(parseWidth(undefined), null);
  });

  test('turn lanes left to right, an empty lane as none', () => {
    assert.deepEqual(parseTurns('left|through;right|'), [['left'], ['through', 'right'], ['none']]);
    assert.equal(parseTurns(''), null);
  });

  test('lanes each way: told, by difference, from the arrows', () => {
    assert.deepEqual(wayDetail({ lanes: '3', 'lanes:forward': '2', width: '10' }), { width: 10, lanes: 3, fwd: 2, bwd: 1, both: 0, turnsFwd: null, turnsBwd: null, roundabout: false });
    const d = wayDetail({ 'turn:lanes:backward': 'left|through', 'lanes:forward': '1' });
    assert.equal(d.bwd, 2); assert.equal(d.fwd, 1); assert.deepEqual(d.turnsBwd, [['left'], ['through']]);
    const one = wayDetail({ 'turn:lanes': 'through|through;right', junction: 'roundabout' }, true);
    assert.equal(one.fwd, 2); assert.equal(one.bwd, 0); assert.ok(one.roundabout);
    // arrows that don't match the count are dropped
    assert.equal(wayDetail({ lanes: '3', 'turn:lanes': 'left|through' }, true).turnsFwd, null);
  });
});

describe('laneLayout', () => {
  const way = { lanes: 3, oneWay: false, className: 'primary', detail: wayDetail({ lanes: '3', 'lanes:forward': '2', 'turn:lanes:forward': 'left|through', width: '9.9' }) };
  test('the split follows the direction of travel; the width sets the lane width', () => {
    const f = laneLayout(way, 1), b = laneLayout(way, -1);
    assert.deepEqual([f.ours, f.theirs, f.centre, f.lanes], [2, 1, 0, 3]);
    assert.deepEqual([b.ours, b.theirs], [1, 2]);
    assert.ok(Math.abs(f.laneW - 3.3) < 1e-9 && f.detailed);
    assert.deepEqual(f.turns, [['left'], ['through']]);
    assert.equal(b.turns, null);
  });
  test('without detail: halved, odd with a center lane, at 3.6 m; an implausible width is ignored', () => {
    assert.deepEqual((({ ours, theirs, centre, laneW }) => [ours, theirs, centre, laneW])(laneLayout({ lanes: 3, oneWay: false }, 1)), [1, 1, 1, 3.6]);
    assert.equal(laneLayout({ lanes: 2, oneWay: false, detail: wayDetail({ width: '20' }) }, 1).laneW, 3.6);
  });
  test('lane centers with a split: two of ours on the right of a 2+1 road, or on the left driving on the left', () => {
    assert.deepEqual(laneCenters(3, false, 3.6, false, { ours: 2, theirs: 1, centre: 0 }), [-3.6, 0]);
    assert.deepEqual(laneCenters(3, false, 3.6, true, { ours: 2, theirs: 1, centre: 0 }), [0, 3.6]);
  });
});

describe('the map', () => {
  test('MapData hangs the tile\'s way tags on its ways, whichever arrives first', async () => {
    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    const t = tileFor(32.1, -83.3);
    const id = decodeTile(bytes).ways.find(w => w.cls > 0).id;
    const asked = [];
    const md = new MapData(async (cell, file) => (`${cell}/${file}` === keyOf(t) ? bytes : null), null, null,
      async (tlat, tlon) => { asked.push([tlat, tlon]); return { ways: { [id]: { lanes: '4', 'lanes:forward': '3' } } }; });
    md.setOrigin({ lat: 32.125, lon: -83.375, seq: 1 });
    md.ensure(32.125, -83.375, 0);
    await md.settle();
    assert.deepEqual(asked, [[128, -334]]);
    const ways = md.tiles.get(keyOf(t)).tile.ways;
    const w = ways.find(x => x.id === id);
    assert.equal(w.detail.fwd, 3); assert.equal(w.detail.bwd, 1);
    assert.ok(ways.filter(x => x.id !== id).every(x => !x.detail));
  });

  test('the road reference: our lanes, the center line between the sides and the carriageway bounds from the split', () => {
    const pts = []; let ci = 0;
    for (let x = -60; x <= 300; x += 20) { if (x === 0) ci = pts.length; pts.push([x, 0]); }
    const layout = laneLayout({ lanes: 3, oneWay: false, detail: wayDetail({ lanes: '3', 'lanes:forward': '2' }) }, 1);
    const map = { way: { lanes: 3, oneWay: false, layout }, horizon: pts, carIndex: ci, conf: 1 };
    const ref = mapReference(map, { x: 0, y: 0, h: 0 }, null, {}, 3.845);
    assert.equal(ref.lanes, 3);
    assert.deepEqual(ref.structure.filter(l => l.kind === 'center').map(l => +l.d.toFixed(6)), [1.8]);
    assert.deepEqual([+ref.ourRight.toFixed(6), +ref.ourLeft.toFixed(6)], [-5.4, 1.8]);
  });

  test('the network draws the center line where the sides meet and dashes between lanes going the same way', () => {
    const road = (left, us = true) => roadNetwork({ ways: [{ id: 1, lanes: 3, oneWay: false, width: 10.8, laneW: 3.6, fwd: 2, bwd: 1, centre: 0, detailed: true, pts: [[0, 0], [100, 0]] }] }, left, us);
    const ys = (lines) => lines.map(l => +l[0][1].toFixed(2)).sort((a, b) => a - b);
    const r = road(false);
    assert.deepEqual(ys(r.centers), [1.69, 1.91]);   // a double line 1.8 m left of the centerline
    assert.deepEqual(ys(r.lanes), [-1.8]);
    const l = road(true);
    assert.deepEqual(ys(l.centers), [-1.91, -1.69]);
    assert.deepEqual(ys(l.lanes), [1.8]);
    // the UK's center is one white line, not a double yellow one
    const uk = road(true, false);
    assert.equal(uk.centerStyle, 'single');
    assert.deepEqual(ys(uk.centers), [-1.8]);
  });

  test('turn arrows: one per lane and turn, near the junction at the way\'s end, pointing the way the lane goes', () => {
    const net = roadNetwork({ ways: [
      { id: 1, lanes: 3, oneWay: false, width: 10.8, laneW: 3.6, fwd: 2, bwd: 1, centre: 0, detailed: true,
        turnsFwd: [['left'], ['through', 'right']], turnsBwd: null, pts: [[0, 0], [200, 0]] },
      { id: 2, lanes: 2, oneWay: false, width: 7.2, pts: [[200, -100], [200, 0], [200, 100]] },
    ] }, false, true);
    assert.ok(net.arrows.length > 0);
    const xs = net.arrows.flat().map(p => p[0]), ys = net.arrows.flat().map(p => p[1]);
    assert.ok(Math.max(...xs) <= 200 - 12 + 1e-6 && Math.min(...xs) >= 200 - 42 - 6 - 1e-6, 'within the approach');
    // our two lanes lie between the right edge (-5.4) and the center line (1.8): centers 0 and -3.6; the left arrow bends
    // left of its lane, never past the center line by more than its head
    assert.ok(ys.every(y => y < 3 && y > -5.4), String([Math.min(...ys), Math.max(...ys)]));
    const tails = net.arrows.filter(t => t.some(p => Math.abs(p[0] - (200 - 12 - 6 * 0.75)) < 0.01));   // 6 m arrows at 3/4 size
    assert.ok(tails.some(t => t.some(p => Math.abs(p[1]) < 0.2)) && tails.some(t => t.some(p => Math.abs(p[1] + 3.6) < 0.2)), 'tails on the lane centers');
    // they stay inside their lanes: clear of the edge lines (3.3 m from the 3.6 m lanes' outer edges) by more than 0.3 m
    const narrow = roadNetwork({ ways: [
      { id: 1, lanes: 2, oneWay: true, width: 5.6, laneW: 2.8, turnsFwd: [['left'], ['right']], pts: [[0, 0], [200, 0]] },
      { id: 2, lanes: 2, oneWay: false, width: 7.2, pts: [[200, -100], [200, 0], [200, 100]] },
    ] });
    assert.ok(narrow.arrows.flat().every(p => Math.abs(p[1]) < 2.8 - 0.3 - 0.3), 'inside a narrow road\'s edge lines');
    // a way ending in nothing (no junction) gets none
    const lone = roadNetwork({ ways: [{ id: 1, lanes: 2, oneWay: true, width: 7.2, laneW: 3.6, turnsFwd: [['left'], ['through']], pts: [[0, 0], [200, 0]] }] });
    assert.equal(lone.arrows.length, 0);
  });

  test('a road split into two ways at a bend: their edge lines meet where the ways join', () => {
    const th = 15 * Math.PI / 180;
    const net = roadNetwork({ ways: [
      { id: 1, lanes: 2, oneWay: false, width: 7.2, pts: [[-120, 0], [-60, 0], [0, 0]] },
      { id: 2, lanes: 2, oneWay: false, width: 7.2, pts: [[0, 0], [60 * Math.cos(th), 60 * Math.sin(th)], [120 * Math.cos(th), 120 * Math.sin(th)]] },
    ] }, true, false);
    const endsNear = (p) => net.edges.filter(e => [e[0], e[e.length - 1]].some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 4));
    // each side's two pieces end within a few centimeters of each other at the join
    for (const side of [1, -1]) {
      const near = endsNear([0, side * 3.3]).map(e => [e[0], e[e.length - 1]].reduce((a, q) => (Math.hypot(q[0], q[1] - side * 3.3) < Math.hypot(a[0], a[1] - side * 3.3) ? q : a)));
      assert.equal(near.length, 2, String(side));
      assert.ok(Math.hypot(near[0][0] - near[1][0], near[0][1] - near[1][1]) < 0.1, JSON.stringify(near));
    }
  });
});
