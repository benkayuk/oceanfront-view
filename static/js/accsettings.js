// The ACC settings the comma sends the ADAS module: its ICC_0x52A override table (the bridge's /api/overrides,
// opendbc/car/fisker/values.py ICC_0x52A_OVERRIDES). openpilot re-sends every ICC_0x52A frame to the ADAS
// module with that table's signals replaced, live, so a change here takes effect within a frame (~200 ms).
// Car → Assist's cruise controls with an `acc` spec (carcatalog.js) read and write it.
//
// What reaches the ADAS module, per signal: the table's value; else, for auto speed and terrain, the comma's
// on-device toggles (FiskerACCAutoSpeed, FiskerACCTerrain); else the ICC's own. The table is stored whole
// (a stored message replaces the code defaults), so a change PUTs every override with it.
import { api } from './util.js';

export const ACC_MSG = 'ICC_0x52A';
const TOGGLE_PARAMS = { ICCACCAutoSpdSts: 'FiskerACCAutoSpeed', ICCACCTerrainSetting: 'FiskerACCTerrain' };

export class AccSettings {
  constructor(app) {
    this.app = app;
    this.table = null;     // the bridge's ICC_0x52A table: { signals: [...], customized }
    this.editable = false;
    this.params = {};
    this.error = null;
    this.loading = null;
    this.busy = 0;         // saves queued or in flight: each goes after the one before, on the table it left
    this.queue = Promise.resolve();
    this.saves = 0;        // a read that started before a save is stale when it lands
  }

  /** Why the settings can't be changed right now, or null. */
  get why() {
    if (!this.app.commaConnected) return 'Needs the comma: these settings are applied by it';
    if (this.error) return this.error;
    if (!this.table) return this.loading ? 'Loading the comma\'s ACC settings…' : 'The comma\'s sunnypilot is too old to set these from here: update it';
    if (!this.editable) return 'Parked only: the comma refuses changes while the car moves';
    return null;
  }

  /** Fetch the table and the toggles' defaults; resolves when done (never throws). */
  load() {
    if (!this.app.commaConnected) return Promise.resolve();
    if (this.loading) return this.loading;
    const saves = this.saves;
    this.loading = (async () => {
      try {
        const [ov, params] = await Promise.all([api('/api/overrides'), api('/api/params').catch(() => ({}))]);
        if (saves !== this.saves || this.busy) return;
        this.take(ov);
        this.params = params || {};
        this.error = null;
      } catch (e) {
        this.error = `Couldn't read the comma's ACC settings: ${e.message}`;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  take(ov) {
    this.table = (ov && ov.supported && (ov.tables || []).find(t => t.message === ACC_MSG)) || null;
    this.editable = !!(ov && ov.editable);
  }

  sig(name) { return this.table && this.table.signals.find(s => s.name === name); }

  /** The raw value the ADAS module gets for a signal, or undefined when it isn't known. */
  value(name) {
    const s = this.sig(name);
    if (!s) return undefined;
    if (s.override != null) return s.override;
    const p = TOGGLE_PARAMS[name];
    if (p && typeof this.params[p] === 'boolean') return this.params[p] ? 1 : 0;
    return s.current == null ? undefined : s.current;
  }

  /** Set signals ({ name: raw value }): the whole table goes back with them. Resolves true when saved. */
  set(changes) {
    this.busy++;
    this.saves++;
    const run = this.queue.then(() => this.save(changes)).finally(() => { this.busy--; });
    this.queue = run;
    return run;
  }

  async save(changes) {
    const why = this.why;
    if (why) { this.app.toast(why); return false; }
    const next = {};
    for (const s of this.table.signals) if (s.override != null) next[s.name] = s.override;
    Object.assign(next, changes);
    try {
      this.take(await api('/api/overrides', { method: 'PUT', body: { [ACC_MSG]: next } }));
      return true;
    } catch (e) {
      this.app.toast(`Not saved: ${e.message}`);
      return false;
    }
  }
}
