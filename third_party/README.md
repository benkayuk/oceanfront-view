# Third-party assets

Served at `/vendor/` (three) and `/models/` by `serve.py`, the Android app and, with `WEBHUD_PAGE_DIR`
set, the comma bridge.

| Path | What | Source / license |
|------|------|------------------|
| `three/three.module.min.js` | three.js r160 (single-file module build; r160 still supports WebGL 1 for older in-car browsers) | npm `three@0.160.1`, MIT (`three/LICENSE`) |
| `three/OrbitControls.js`, `three/GLTFLoader.js`, `three/BufferGeometryUtils.js` | three.js r160 examples, imports rewritten to `./three.module.min.js` so no import map is needed | same |
| `models/pulse_ocean_v0.10_parts.glb` | Fisker Ocean 3D model, ego car: detailed, rigged (steering, wheels, doors, lamps), with paint and wheel options, and the parts the car controls move as meshes of their own | Pulse Ocean v0.10, `Pulse-Ocean-ADAS.glb` with parts split out by `tools/export_ocean_glb.py`; provenance and the open license question in `models/LICENSE.md` |

The DBCs are under `dbc/` at the top of the checkout (see the main README).
