// The comma's bridge, folded into the car's own view. The car's IBUS1/IBUS2 (through the Android app) are
// the HUD's primary source; when the comma is connected and live, its ticks add what only it has: the ADAS
// bus itself (complete, where Pulse drops a share of the gateway's IBUS2 mirror), the radar's private bus and
// openpilot's services (its lanes, leads, path, alerts). They are fed into the same builder as IBUS, on the
// page's clock, so the world model fuses the radar and openpilot's leads with the car's own data.
//
// Clocks: the bridge stamps its ticks with the comma's monotonic clock; the IBUS frames carry the page's wall
// clock (Date.now()/1000). The offset is the smallest (wall at receipt - tick.now) seen lately -- the tick that
// crossed the link fastest -- relaxed slowly so drift is followed, and taken afresh after a jump (a restarted
// bridge, a new viewer's snapshot).
//
// Only the ADAS module's own messages (native to the cam side in the IBUS DBC) are taken from the comma's
// bus 2: its bus 0 is the gateway's ADAS-side vehicle bus, whose IDs don't mean what IBUS1's do. While the
// comma has given a message lately, the IBUS2 mirror's copy of it is dropped, so each message has one source.
import { hexToBytes } from './dbc.js';
import { BUS_CAM } from './fisker_world.js';
import { BUS_RADAR } from './fisker_radar.js';

export const COMMA_PREFER_S = 0.5;   // an IBUS2 frame is dropped while the comma gave the same message this recently
const OFFSET_JUMP_S = 2.0;           // a step this large in the clock offset is a restart, not jitter
const OFFSET_RELAX = 0.02;           // per tick, toward a larger offset (the minimum filter's slow leak)
const ACTIVE_S = 1.0;                // the comma counts as merged this long after its last tick

export class CommaMerge {
  /** local: the car's own StateBuilder (IBUS DBC, the radar's DBC, brand fisker). */
  constructor(local) {
    this.local = local;
    this.offset = null;        // wall - comma clock (s)
    this.seen = new Map();     // addr -> wall time the comma last gave it
    this.lastAt = -1e9;        // wall time of the last merged tick
  }

  reset() {
    this.offset = null;
    this.seen.clear();
    this.lastAt = -1e9;
  }

  /** wall - comma clock, updated with this tick's arrival. */
  clock(tick, wall) {
    const m = wall - tick.now;
    if (this.offset === null || tick.reset || Math.abs(m - this.offset) > OFFSET_JUMP_S || m < this.offset) this.offset = m;
    else this.offset += (m - this.offset) * OFFSET_RELAX;
    return this.offset;
  }

  /** Feed a live bridge tick (see worker.js) into the car's builder; wall = Date.now()/1000 at receipt. */
  feed(tick, wall) {
    const off = this.clock(tick, wall);
    const local = this.local, native = local.world.nativeBus;
    for (const [t, frames] of tick.can || []) {
      const mine = [];
      for (const [addr, src, hex] of frames) {
        if (src === BUS_RADAR) mine.push([addr, hexToBytes(hex), src]);
        else if (src === BUS_CAM && native.get(addr) === BUS_CAM) {
          mine.push([addr, hexToBytes(hex), src]);
          this.seen.set(addr, wall);
        }
      }
      if (mine.length) local.feedCan(mine, t + off);
    }
    for (const [which, t, data] of tick.op || []) {
      // the one service field on the comma's clock: when the model output radarState's leads came from
      const d = which === 'radarState' && data && data.mdMonoTime ? { ...data, mdMonoTime: data.mdMonoTime + off } : data;
      local.feedService(which, d, t + off);
    }
    local.setBrand('fisker');   // carParams must not switch the car's own decoder off
    this.lastAt = wall;
  }

  /** Whether the comma's data is part of the car's view right now. */
  active(wall) { return wall - this.lastAt < ACTIVE_S; }

  /** Whether the comma gave this message lately (its IBUS2 copy is dropped then). */
  fromComma(addr, wall) {
    const at = this.seen.get(addr);
    return at !== undefined && wall - at < COMMA_PREFER_S;
  }

  /** IBUS frames ([addr, data, src]) less the IBUS2 copies of messages the comma is giving. */
  filterIbus(frames, wall) {
    if (!this.active(wall)) return frames;
    return frames.filter(f => f[2] !== BUS_CAM || !this.fromComma(f[0], wall));
  }
}
