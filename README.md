# Oceanfront View

A Tesla-style car view for the Fisker Ocean's own center screen: a web page with a 3D model of the car,
the lanes, cars, signs and lights its ADAS sees, the road from the map, the car's own state and
controls, music and navigation. Its driving data comes from the car's own buses, IBUS1 and IBUS2, which
Pulse (the add-on board the app runs on) reads. A comma device running
[sunnypilot](https://github.com/moistpope/sunnypilot) is optional: when it's there it adds the ADAS bus
itself, the radar and openpilot, and the app manages it over SSH (the *Comma* tab).

## How it runs

**Standalone.** Everything the HUD is happens in the page: `static/` is plain ES modules with no build
step, and the CAN decoding, the sensor fusion, the pose estimate and the map matching run in a web worker
(`static/js/world/`). On the car the Android app in [`android/`](android/README.md) carries the page in its
APK, serves it to its own WebView, reads the car's IBUS1/IBUS2 through Pulse's CAN controllers and feeds
them to the page, so the car, its controls, the live read-out, music and navigation work with nothing
else present. On a PC, `python3 serve.py` serves the same page at `http://localhost:18088` with the same
URL layout (`/`, `/vendor/`, `/models/`, `/dbc/`).

**From the car's own buses.** On Pulse the app reads IBUS1 and IBUS2 and hands every frame to the page,
whose worker decodes them with the IBUS DBC: the gateway mirrors the ADAS bus onto IBUS2 with the same
layout, so the status card, lanes, objects, signs, lights, parking sensors, the pose and the map all run
from the car alone (see *The car's own buses* below). This is the primary source: nothing waits for the
comma, and nothing on screen says it's missing.

**Joined by the comma (optional).** More data comes from sunnypilot's `webhud` process on the comma
(`openpilot/sunnypilot/webhud/server.py` there, *Settings → Developer → Web HUD*, port 8088). It is a
bridge: it reads the ADAS bus, the radar's private bus and openpilot's own services and streams them as
they are, in ticks at 20 Hz over a WebSocket (`/ws`): raw CAN frames allowlisted by message (the set in
`dbc/fisker_ocean_adas_world.dbc`, which both sides keep a copy of), and openpilot's services in compact
form. Its REST API (`/api/...`) carries status, replay of recorded routes, the editable CAN overrides and
a few params, and `/map/...` fetches OSM road tiles. The Android app finds the comma on the head unit's
hotspot and relays `/api` and `/ws` to it; `serve.py --bridge sunnypilot.local` does the same on a PC.
While the comma streams live, the worker folds its ticks into the car's view (`static/js/world/merge.js`):
the ADAS module's own messages from the comma's ADAS bus (complete, where Pulse drops a share of the IBUS2
mirror; the mirror's copy of a message is dropped while the comma gives it), the radar's private bus and
openpilot's services, all re-clocked onto the page's clock, so the world model fuses the radar and
openpilot's leads with the car's own data. A *comma* chip shows while it's connected (tap it for the Comma
tab). The comma's own view is drawn only while it replays a drive, or where there are no car buses (a
browser on a PC). With neither, the driving data leaves the screen; the car controls, music and navigation
carry on.

| Path | What |
|------|------|
| `static/` | the page: `index.html`, `app.css`, `design.css`, `sw.js`, `js/` (view, car controls, infotainment, `comma.js` the Comma tab), `js/world/` (worker: DBC decoding, the comma merge, world model, pose, map) and its Node tests |
| `android/` | the app for the car's screen (Kotlin, a local server, the CAN helper in Go, the comma's SSH management and its scripts in `app/src/main/assets/comma/`) |
| `dbc/` | `fisker_ocean_adas_world.dbc` (the ADASBUS subset the page decodes and the bridge streams; `tools/gen_world_dbc.py`), `fisker_ocean_ibus.dbc` (IBUS1/IBUS2 for the car-only view; `tools/gen_ibus.py`), `fisker_ocean_mrr.dbc` (the radar, reverse-engineered; a copy of opendbc's) |
| `third_party/` | three.js r160 and the Pulse Ocean model (`third_party/README.md`) |
| `tools/` | the DBC generators, the Blender export of the model, and the Node tools that record and replay the bridge's tick stream |
| `serve.py` | dev server: the page, with `--bridge` relaying `/api`, `/ws` and `/map` to a comma |
| `DESIGN.md`, `CAR_CONTROLS_PLAN.md` | the design language of the car controls and the plan they were built from |

```
python3 serve.py --bridge sunnypilot.local     # then open http://localhost:18088
npm test                                       # node --test static/js/world/tests/*.test.js
cd android && ./gradlew assembleRelease        # the APK (JDK 17+, Android SDK)
```

A built APK is attached to each [release](https://github.com/moistpope/oceanfront-view/releases).

## What it shows

Speed, gear, MADS steering state, ACC set speed and time gap, speed limit, alerts, the ADAS module's
lane lines and object list in 3D, parking sensors, and the comma's CAN overrides
(`opendbc/car/fisker/values.py`) and replay of recorded routes, through the bridge.

The ego car mirrors the real one: a detailed, rigged Ocean model (Pulse Ocean v0.10, at its true
size in meters) in any of the factory paints and five wheel options (Settings > Display). A fine
textured ground moves under it with speed and steering (dead-reckoned about the rear axle with the
bicycle model from `steeringAngleDeg`), the wheels roll and the front pair steers, and the model's own
lamps light up, following the BCM's lamp outputs (`BCM_0x335`, falling back to carState): DRLs,
headlights, the lower front strips (white DRL, amber while indicating), quarter-panel and rear turn
indicators, tail, brake, third brake light and reversing lamps (`static/js/lamps.js`). The red and amber
lamps get a soft glow so they read from the chase camera. The car reflects a soft studio environment of its own
(`studioEnvironment` in `scene.js`), so its glossy paint, glass and chrome trim catch highlights.

Lanes and objects are filtered before drawing (`static/js/road.js`, `scene.js`): lane lines are
carried with the car's motion and eased toward each measurement by confidence, with hysteresis on
validity; objects are tracked with an alpha-beta filter. The default *Blended* lane source takes
the ADAS lines and refines each with openpilot's matching line where they agree, adding lines only
openpilot sees when it's confident. Lanes neither reports are filled in as a softer, inferred road:
lane count and width from ADAS lines/lane info and openpilot's outer lines and road edges (the road
between the edges is split into lanes and the car put in its slot), held for a while, else the
car's own path. A lane count drops only after 8 s without the lane, since the outer lines flicker.
The cameras name lines by where they are from the car, so a lane change renames every line at once.
That's recognized (both ego lines a lane over from where the carried lane puts them), and the carried
road is renamed with them, so it stays put on the ground instead of sliding a lane sideways.

Lanes are drawn only when the HUD is confident of them. *Lane confidence* is spatio-temporal: it's
kept on stations fixed to the road every 5 m of distance driven, from just behind the car to 100 m
ahead, so what was learned about a stretch of road stays with it as the car drives onto it. Each
station eases toward how much stable lane evidence there is at its distance: the ego lane's lines
where they're plausible (on their side of the car, a lane's width apart, along our heading),
weighted by their confidence, by how far ahead they can be trusted, and by how stable they've been
(a running mean of how far each new measurement lands from where the carried line predicted it), or
else openpilot's road edges. It rises within a second or so and falls slowly: over 10 s standing
still, faster with distance driven (2 s in Park), so a lane has to hold steady to be trusted and a
short dropout doesn't lose it. The lanes show once the stations over the next 30 m average past the
threshold (*Display → Lane confidence*, 50% by default, with a live readout), and hide below 80% of
it. On the logged drive, clean highway lanes show 1–2 s after they appear and settle at 90–97%.

The ground (`static/js/ground.js`) is drawn as one field with the road. With no lanes to show (at
start, in a parking lot, at low speed without lines) it's a disc of about 10 m radius around the car
that fades out over its outer half. Once the lanes show, the disc grows out into the road, first
across to the outer lines plus a shoulder, then down the road as far as the lane confidence reaches
(70–80 m on the highway), fading out at the far end. Disc and road are signed distance fields joined
with a smooth minimum, the road's computed in its own coordinates (station along it and offset across
it, exact for the arcs the lines are drawn as), and every part of the shape is eased on springs. So
any change morphs: lanes found or lost, a lane added or dropped, the road bending. The edge is
roughened with noise fixed to the ground, which ripples and flows while the shape is changing and
holds still when it isn't. Lane lines, stop lines, crosswalks and the headlight throw are cut by the
same field, so they grow, bend and dissolve with the road. Ground texture and inferred road can be
turned off under *Display*.

Traffic lights, signs and road markings (`static/js/furniture.js`) come from the car's ADAS camera
only; sunnypilot adds map speed limits (`liveMapDataSP`) but no signs or lights. The camera reports
what it saw and, for lights and markings, how far ahead, never where across the road: the ego-lane
traffic light (color, arrow, solid/blinking, lamp count, orientation) floats over our lane at its
distance (else the stop line's or a landmark's, else an estimate); a speed-limit sign the camera
just read (`ADAS_TSRSts` Vision mode or a new value) or a prohibition sign (`ADAS_FobdSign`) goes up
at the roadside a little ahead, beyond the outer lane on our side; stop lines and crosswalks are
drawn across the road at their distance. All of them are anchored to the road, not to the ground: a
station down the road (distance driven) and an offset across it, placed each frame on the road as
it's drawn then (`RoadModel.place`). A sign 50 m down a road drawn curving left that turns out to
run straight is, 10 m later, 40 m down the straight road and still beside it. The camera doesn't
classify stop or yield signs. The ICC also
sends an ADASIS v2 map horizon (`ICC_0x250`..`0x255`, `0x361`) with map signs and lanes per
direction; its sign type table isn't in the matrix, so it isn't used yet.

*Power trails* (`static/js/tracks.js`, *Display*): the rear tires leave trails of fine glowing
particles on the road, a dense bright band as wide as each tire with a soft glow about it and
sparser dust that spreads out behind, colored by how hard the motors are asked to pull when each is
laid: blue at a light load through the spectrum to red at full power (150 kW demanded, or 6000 Nm of
wheel torque for a hard launch; regen counts as light), and denser with more dust the harder the car
pulls. Laid particles keep their color, so a burst of power slides back behind the car as a red
stretch. The trail grows with speed to one car length at 70 mph and fades out toward its end. The
load is the
driver's torque request per axle (`VCU_0x102`, wheel torque) times motor speed (`MCU_F_0x150`,
`MCU_R_0x151`) over the ~11.5:1 drive ratio; on other cars it's estimated from openpilot's
acceleration. The chase camera also backs off with speed, up to 1.5x its distance at 70 mph,
keeping any zoom you set. In every view the camera's heading follows the car's on a critically
damped spring (`CAM_YAW_W` in `scene.js`, at most 0.6 rad behind): in a sharp low-speed turn the car
swings round in the frame and the camera catches up as it straightens out; on the highway the lag
is a degree or two.

*Radar objects* (*Display*, off by default): the tracks of the car's mid-range radar, read from its
private CAN-FD link on panda bus 1 (`static/js/world/fisker_radar.js`), drawn as see-through teal cars with a ring on
the ground at the point each track reports. It's there to check the radar decoding against the
camera's cars before the radar feeds openpilot. The radar's messages aren't in the FM29 matrix:
`dbc/fisker_ocean_mrr.dbc` (a copy of opendbc's) is reverse-engineered from a drive, and its comments
say how each scale was checked and which are still open. Tracks are drawn close to raw (each 65 ms
cycle's position, carried on the radar's own velocity for at most a cycle), so a scale or sign error
shows up as an offset from the camera's car; like those cars, a car ahead sits with its rear on the
reported point. A chip at the top right shows the radar's track count, or *no radar* when the log (or harness)
has no radar frames.

*Objects* (*Display*): the default *World model* (`static/js/world/world_model.js`) fuses the radar, the ADAS camera list
and openpilot's leads into one object set in a ground-fixed frame: each measurement is placed at the
time it was taken (radar MeasTime from the bus's time sync; the others by typical latency) using an
ego pose dead-reckoned from ESP wheel speed and the YRS yaw-rate gyro, and weighted by its source's
noise model (radar: range and Doppler; camera: bearing, class, size; openpilot leads only corroborate
on this car). The view anchors the objects to the ground, so parked cars stay put through turns; the
scene's own ego motion now uses the gyro too. *Raw sources* draws each source as it reports. Radar
tracks younger than 1.3 s are hidden unless *All radar tracks* is on. A world object is drawn with its
center half a car length beyond the reported point along the car's own axis (half a width when seen
side-on), since every source reports the face nearest us.

Before fusing, each source is corrected by the *measured sensor calibration* (`MEASURED_CALIBRATION` in
`world_model.js`, *Display → Geometry calibration*, on by default). Its values come from replaying
`000000b5--bfe13ac451` and `000000b4--d0f733ebb2` against GPS, openpilot's leads and lane lines:
- The ADAS object list's range is 0.8× the radar's plus ~3 m (~0.25 m/bit from about the rear axle), so
  it's read as `x / 0.80 − 3.7`.
- Its lateral reads 1.35× too wide.
- Its latency is ~0.23 s.
- The radar's Doppler is 1/16 m/s per bit (not 0.06), and its output is turned 0.6° left.
- The wheel speed reads 3.1% under GPS, which the odometry and the view's ego motion correct.
- openpilot's leads read 0.2 m short (the camera is ~1.72 m behind the radar).

Uncorrected, a car the ADAS list and the radar both see splits in two at range and the copies cross at
~10–15 m. The switch is a setting of this screen (*Display → Debug*). The radar
sometimes sends a cycle twice, and `fisker_radar.js` hands each cycle out once. openpilot's `leadTwo`
(its lead 2 s from now) only counts when it's clearly another car than `leadOne`. Two tracks one radar or
ADAS id fed within a second are merged.

Each world-model object has a confidence, and the view fades it in between 35% and 65% and hides it
below that. The radar measures no elevation (nothing decoded so far gives height), so overhead
traffic lights, sign gantries and bridges read as stopped cars in our lane until it passes under
them and drops the track (radar track 791 on `000000b5--bfe13ac451--12` at 0:45–0:48: a traffic
light the radar called a 3 m wide, 0.6 m long car, dropped 24 m out). A camera positively
classifying an object (an ADAS class, or an openpilot lead) settles it at 100%. The radar alone
never shows a point target it hasn't classified: that takes a second, camera detection (anything in
the ADAS list, or an openpilot lead). A class counts once the radar has given it for 5 cycles, since
a class can flicker on for a single cycle (radar track 468). A radar-only object it has classified
stays hidden until its radar track has lasted 1.3 s. After that it gets 85% if it moves over the
ground and 60% (drawn a little see-through) if it stands. A standing object drops to about 33% if
the radar has drawn it at least 4 times wider than long and 1.5 m wide, and to 15% once openpilot's
model has missed it for 0.5 s in plain view: standing within 1.5 m of our path, 8–80 m ahead, above
5 m/s, with no camera-seen or moving object in front of it. Once no source has reported an object for
0.3 s it can't rise; a moving one fades out (*coasting*) rather than carry on along a velocity that's
now a guess, while a standing one waits (a parked car the radar loses in a turn). *Low-confidence objects*
(*Display*, off by default) draws the hidden ones faintly, and *Object stats* gives each object's
confidence and the reason for it (*vision*, *moving*, *standing*, *thin*, *unseen*, *young*,
*unclassified*, *coasting*). Paused, each object shows its settled confidence.

*Object stats* (*Display*, off by default, `static/js/labels.js`): a debug tag over every object the
view draws, giving its source (the ADAS camera's list, an openpilot lead, the radar), track ID and
class, position (x ahead, y left/right), speed over the ground and relative, heading and size, in m,
m/s and degrees. The ADAS list has no speeds; its tags show this view's tracking estimate (*est*). An
openpilot lead merged into an ADAS car is listed on that car's tag. Tags stack instead of overlapping,
so an object two sources report shows both.

Music and navigation (`static/js/infotainment.js`, *Display*, on): on the car's screen, the Android
app passes on what the head unit is playing and its navigation's next turn (see
[`android/`](android/README.md#music-and-navigation)). What's playing shows in a card at the bottom
with its art, progress and previous / play-pause / next, which control the head unit's player. The
next turn shows in a card at the top: the maneuver, its distance, the street and the trip (time,
distance, arrival). Within 160 m an arrow lies on the ego lane at the turn, bending the way it goes
(`static/js/navarrow.js`). The navigation app rounds its distances (0.3 mi is anywhere from 0.25 to
0.35), so the turn is pinned to the road when it's first given and carried along with the car, and
each later distance only nudges it back inside what that distance allows. In a plain browser, without
the app, neither card shows. *Display → Debug → Demo music & navigation* plays a made-up playlist and
route (the turns come nearer as the car drives), for trying them without the car.

The car's own buses (`static/js/carstate.js`, `cancmd.js`, `ibus_tables.js`): on Pulse — the add-on board
the app runs on — the two CAN controllers are wired to the car's IBUS1 and IBUS2. The app reads what
the gateway broadcasts there and forwards every frame to the page (see
[`android/`](android/README.md#the-cars-own-buses)). Two things come of that:

- **The HUD.** The gateway mirrors the ADAS bus onto IBUS2 for the head unit, with the same layout and
  signal names, and IBUS1 carries speed, gear, steering, yaw and the body. The page's world-model worker
  decodes these frames with a DBC generated from the IBUS matrices (`dbc/fisker_ocean_ibus.dbc`,
  `tools/gen_ibus.py`): the status card, lanes, objects, signs, lights and parking sensors all work from
  the car alone. The comma, when connected, joins this view with openpilot and the radar (above); with no
  frames at all, the driving data comes off the screen and the car controls, music and navigation carry
  on. The *Signals* tab browses IBUS1 and IBUS2 live, every message the app reads (and the comma's ADAS
  bus while it's connected).
- **Live car controls.** The car-control menus show a "From the car" block at the top of each menu and
  their controls follow what the car reports (`carcatalog.js` `live`, from the generated table of status
  signals): locks, doors, the liftgate, windows, sunroof, mirrors, lights, climate, seat heat, gear, drive
  mode, battery and charging. The 3D car follows the same values: open doors swing open, windows sit
  where they are, the liftgate lifts as far as the car says. Setting a control **sends the head unit's
  own control message** to the car (`tx`: windows auto up/down, lock, liftgate, sunroof position,
  mirrors, lamps, climate, seat heat and seat moves, the locking settings), and the car's answer shows
  when it comes. What can't be sent is greyed with why (`off`): either the car has no message for it, or
  the head unit sends that message itself every second with its own values (drive mode, regen, creep,
  charge limit and current, brightness, ambient light, California Mode), or one frame would carry every
  audio volume along (ICC_0x44/0x46). Energy shows the charging power, pack voltage and current, time
  left, limits and the battery's health. In a plain browser nothing is live and nothing is sent: the
  controls stay a mockup. *Display → Debug → Demo live car state* fills the read-out with made-up values.

Pulse's CAN driver has hardware acceptance filters (`/sys/module/mcp251x/parameters/rxb_*`) whose
defaults pass only parts of the ID range and would keep the seat and mirror positions, the liftgate's,
the steering angle, yaw rate, battery current and the charging times from ever arriving. The app sets
them at start to the tightest filters that pass every ID it reads (`CanIds.HW_FILTERS`, generated by
`tools/gen_ibus.py`); that needs its root shell, and without root those read-outs stay empty and the
car-only view has no steering or yaw. See `android/README.md`.

Frame rate (`static/js/perf.js`, *Display → Debug*, on for now): a counter under the status card,
over the car controls' panel. Tap it for the slowest frame of the last second, the HUD's own script
time per frame, draw calls, triangles and the render resolution. *Render resolution* is *Auto* by
default: while frames come slower than the screen refreshes (88% of it, two seconds running), it first
drops the blur behind the HUD's cards, then lowers the 3D view's resolution in steps to 60%, and brings
them back a step at a time once frames have kept up for 8 s (a step that slows things straight down
again waits a minute). *Full*, *75%* and *50%* fix it, for comparing on the car.

Where the work is done: the car's buses are decoded in the page (above), and the comma's process is a
*bridge*. It reads its buses and openpilot's services and streams them to the page as they are -- the ADASBUS and radar frames the HUD decodes
(raw, allowlisted by message), and openpilot's services in compact form (`extract.py`) -- in ticks at
20 Hz over the WebSocket. The page decodes them and runs the world model itself, in a worker off its
main thread (`static/js/world/`: `dbc.js`, `fisker_world.js`, `fisker_radar.js`, `world_model.js`,
`state.js`, `merge.js`, `worker.js`), and hands the view the same state snapshots the comma used to
build. So the car's own screen carries the HUD, the comma stays light, and the Android app runs the
whole page from its own package, from the car's buses, with or without the comma. The
DBCs come down as files (`/dbc/`). `tools/record_ticks.mjs` saves a running server's tick stream and
`tools/replay_ticks.mjs` runs the same pipeline in Node over it, for working on the decoding and fusion
without a browser; the tests are in `static/js/world/tests/` (`node --test static/js/world/tests/*.test.js`).

Where the car is (`static/js/world/pose.js`, the snapshot's `pose`): the worker keeps the rear axle's
pose in a local east/north frame from the car's odometry (wheel speed and yaw-rate gyro at CAN rate),
corrected by the telematics box's GPS fixes (`TBOX_0x526`, 10 Hz, mirrored on bus 0 and IBUS2) and its
fused heading (`TBOX_0x179`), or by the comma's `gpsLocation(External)` when the car's own isn't there.
A fix describes where the car was ~0.2 s earlier (measured on both receivers), so it is matched against
the pose the odometry had then and the difference nudges the whole recent track; the heading sensor keeps
the gyro's integration straight and estimates its bias; the fixes calibrate the wheel speed (it reads ~3%
low) and, on drives varied enough to tell, the GPS lag. The view's ground frame follows this pose
(`scene.js` `_followPose`), so GPS corrections slide the ground under the car instead of stepping it, and
map geometry can be drawn in the same frame. `tools/pose_eval.mjs` reports how it did on a recording.

The road from the map (`static/js/world/osmtile.js`, `mapdata.js`, `mapmatch.js`; the snapshot's `map`): the
worker reads the OpenStreetMap road tiles sunnypilot's mapd uses (one packed Cap'n Proto file per 0.25 deg
tile, 2 x 2 deg cells from `map-data.pfeifer.dev`, the same files mapd keeps under `<media>/osm/offline/`),
asks its own server for them (`GET /map/tile/<lat>/<lon>/<name>`: `maptiles.py` on the comma or a PC,
`MapTiles.kt` in the app, both downloading a cell the first time and keeping it), projects the drivable
ways into the pose's frame and indexes their segments on a grid. The matcher scores the ways within 40 m
by distance and heading (one-way respected), stays on the current way until an unconnected one has won for
a while or the current one has ended, and follows the most likely continuation (same ref or name, then the
smallest turn) ~500 m ahead into a *horizon*: the centerline polyline in the pose frame with the roads
branching off it (offset along, angle, class, name). The match is which road and roughly where along it,
never which lane. On the recorded drives it agreed with mapd's road name 90-100% of the time
(`tools/map_eval.mjs`).

Drawing it (`static/js/mapsurface.js`, `ground.js`, `scene.js` `_road`; *Display → Map road*): two separate
road sources, never blended. The cameras' road model (`road.js`, the single arc from the lane lines) always
runs and is what the view draws when there is no map: no tiles, no match, the toggle off. Once the matcher
has had the road under us for half a second the view switches to the map's road and stays on it until the
match has been gone for two seconds (the last good match carries it through a short coast). The map is
then the road's only geometry: its centerline polyline is the ground field's reference instead of the arc,
with the carriageway as wide as the lane count says, and the lane lines are the map road's own structure
(edges, a two-way road's centerline, lane boundaries) as parallel offsets of it, opened at the junctions
along it. What the cameras add is *which lane* the car is drawn in: the map has no lanes and the GPS and
the OSM centerline are both meter-level, so the car is placed in a lane of the map's road (counted from the
right) and the whole map slides sideways -- with a 1.5 s time constant, never faster than 0.4 m/s -- so
that lane's center passes where the cameras see the ego lane's center at the car (lanes 3.6 m wide, the
map's, since the network's lines are drawn with that). A lane change moves the lane index, not the map. Without lanes
seen the car keeps the lane it had (or starts in the right lane); only a GPS that insists for five seconds
that we are 0.8 lane widths over moves the drawn lane by one. The lanes may also turn the map about the
car by at most 2 deg (3 s time constant). The two structure lines bounding the drawn lane are the ego
lane's: they take the HMI's blue and red like the cameras' lines did. Junctions are drawn as a map draws
them (`mapsurface.js` `junctions`): each road leaving or joining ours is a strip of ground in its own
width for its first 60 m whose edges curve into ours with fillets (tight at a street corner, a long taper
at a ramp's gore), our edge line opens across the mouth between the fillets, our lane dashes stop inside a
crossing with arms on both sides, and the arm gets its own centerline or lane boundaries past the mouth.
One-way roads that end at a node on our road (on-ramps, merging lanes) are included as arms too.

Under all of it lies the map itself: every road within 320 m of the car (`roadnet.js`, from the snapshot's
`map.roads`, rebuilt by the worker once the car has moved 40 m) as ground-fixed strips in their own widths
with edges, centerlines and lane boundaries. This is the one source of lane lines for every road, the one
we're on included (so nothing toggles when the match or the horizon moves from one way to the next); the
field only highlights the drawn lane's two lines in the HMI's blue or red on top of them, and draws the
junction fillets. Lines open where roads meet: an edge between the fillets' tangent points (the geometry the
fillets are drawn with, so they meet), the inner lines across the other road's width; a way that simply
goes on into the next (the same road split, a shallow end-to-end bend) opens nothing. The map's layers sit
under a group (`scene.js` `_alignMap`) that takes the same
slide and turn the lane placement gives the road we're on, so the whole map moves as one with it. And what
stands along the roads (`mapfeatures.js`, from the layer's `features`): the road tiles hold no point
features, so the server fetches them from the Overpass API once per 0.05 deg cell (`GET
/map/features/<klat>/<klon>`, `maptiles.py` `MapFeatures` / `MapFeatures.kt`, kept under
`<media>/osm/features/`; a busy Overpass is retried, a cell that fails is asked for again later) and the
worker keeps the ones that sit on a node of a road it knows (state.js `_features`), each with the road
directions arriving at it. A traffic signal gets a head over the right lane of each arriving direction,
facing it, with a stop line; the head ahead on our own road takes the camera's light state (`fisker.tlr`),
so the map says where the light is and the camera what it shows, and the camera's own floating light is
not drawn then. Stop and give-way signs stand at the right edge of their road 4 m before the node, facing
the traffic they hold (OSM's `direction`, a stop at a way's end holds the traffic reaching it, one on an
intersection node the minor roads unless `stop=all`), with a stop line; marked pedestrian crossings are
striped across the road; level crossings get a crossbuck and a line; traffic calming three stripes; a
mini-roundabout its ring. Speed limits are left to the camera's read of the real sign (the map's are often
stale, and two signs for one limit confuse). So the car is placed on the map, and
the roads around it and what stands along them are there whether or not the matcher has an opinion about
them.

Nothing of the map is ever dropped from disk, and it is fetched ahead: as the car moves, the worker asks its
server to download everything within *Display → Map download* (default 25 km; `POST /map/prefetch {lat, lon,
radius_km}`, every 3 km or 2 min), and the server (`maptiles.py` `MapPrefetch` / `MapPrefetch.kt`) works
through the 0.25 deg tiles within that radius nearest first, in one background thread: the road tile's 2 x 2
deg cell if it isn't on disk, then the tile's features in one Overpass request (a tile at a time, split into
the 0.05 deg cells the page reads; ~0.5 MB and a few seconds for a town, with a pause between requests). `GET
/map/status` says how far it has got, and the settings panel shows it. A later drive through the area needs
no network at all. The road we're on is named at the bottom center of the screen (the match's name and ref,
else mapd's road name). At a junction the horizon takes a continuation only if it turns less than 55 deg (any turn short of
a U-turn when it keeps the name or ref, or is the only way on, i.e. a bend OSM split into two ways; drops
down the road hierarchy penalized) and stops where the road would double back, so a wrong guess at a turn
is a road that ends rather than one that loops; where the road itself ends the field fades within 12 m. A
way the current one leads into takes over only when the current one ends within 6 m; any other way must
win clearly for 8 snapshots, so a ramp running beside the road doesn't pull the horizon onto itself. The
head unit's ADASIS horizon (`ICC_0x361`, `0x250`, `0x251`, `0x255`) is the same idea from the car's own
navigation and serves as the cross-check.

The pose the map is placed by is the *shown* pose (`pose.js` `SHOW_*`; the snapshot's `pose.x/y/h`, with the
estimate itself in `pose.est` and the difference in `pose.offset`): the same odometry, so the car's own
motion is exact and immediate, but the GPS and heading corrections reach it with a 2 s time constant and
never faster than 0.05 + 0.02 |v| m/s sideways, 0.1 + 0.05 |v| m/s along, 1.5 deg/s in heading. The ground
never steps under the car; a lane line never jumps with a fix. Only the first fix, the first heading, and a
disagreement past 10 m or 15 deg (a restart on persistent outliers) move it outright (`pose.snaps` counts
those). The matcher still uses the estimate. On the recorded drives the shown pose trailed the estimate
sideways by 0.1-0.8 m typically and up to 3.5 m briefly after a correction; since the lane placement
absorbs sideways error, that shows as the map gliding under the car, not as the car off its lane.

Loading: static files carry an `ETag`/`Last-Modified`, and the server answers a current copy with
`304`. In a browser the page's service worker (`static/sw.js`) keeps the car model, three.js and the
app's files in Cache Storage and checks them on each load, so the ~25 MB model crosses the network
once. It needs a secure context, such as `localhost`; a plain `http://sunnypilot.local` tab uses the
HTTP cache instead. The Android app serves everything from its own APK and doesn't use it. The
day/night theme is applied from the saved setting before the first paint.

**Open:** on the car's own screen, the Android app in [`android/`](android/README.md): it runs the HUD
full screen from the car's buses, and finds the comma on the hotspot when there is one (where `.local`
names don't resolve). In a browser, `python3 serve.py --bridge sunnypilot.local` (or the device's IP) and
open `http://localhost:18088`; there the comma is the only source. For the comma's part the bridge must
be on: *Settings → Developer → Web HUD* (`EnableWebHud`, on by default), port 8088 on the comma.

## Managing the comma

The *Comma* tab (`static/js/comma.js`, `android/` `CommaManager`), on the car's screen. The app makes an
SSH key pair of its own, ECDSA P-256 in the head unit's Android Keystore (the private half never leaves it;
it signs there), and *Authorize on the comma* sends the public half to the bridge (`POST /api/ssh/authorize`),
which adds it to openpilot's `GithubSshKeys` beside any keys already there and turns SSH on. From then on the
app logs in as `comma` (the comma's host key is pinned on first use) and runs everything over SSH:

- **Overview:** the connection, the key, SSH, a summary of the device; start, stop and restart openpilot
  (its manager is stopped with SIGTERM so it takes its processes down, then the `comma` tmux session;
  started through AGNOS's `comma.service`, else the launch script in a new `comma` session), reboot.
- **Log:** openpilot's tmux session as it scrolls (`tmux capture-pane`), 200 to 3000 lines.
- **Processes:** `managerState`'s processes with CPU and memory from `/proc`, and `deviceState`.
- **Routes:** the drives in `/data/media/0/realdata`, with their files and sizes; *Play* replays one in the HUD.
- **Updates:** the install (repository, branch, commit, ahead/behind), openpilot's updater (check and
  download: `SIGUSR1` and `SIGHUP` to `updated`), git fetch and pull, switching branches (any branch of the
  repository; the updater follows it too), installing a fork (any `https://` or `git@` repository and branch:
  cloned beside the install, swapped in, the old one kept as `/data/openpilot.bak` and restorable, then a
  reboot into it), and the panda's firmware: build, build and flash, recover from DFU.
- **Debug:** a command on the comma, recent jobs, and everything the app read.

Long actions are jobs on the app: their output streams into the tab and they carry on if it's closed. Anything
that disturbs openpilot asks first and is refused while the car moves (by the bridge's word or the car's speed).
The scripts are in `android/app/src/main/assets/comma/` (`prelude.sh`, `actions.sh`, `info.py`, `routes.py`).
The page reaches them at `/app/comma/...` on the app's own server, with a per-launch token from the app, so
other apps on the head unit can't. Adding keys needs a bridge from sunnypilot with `/api/ssh` (else add the
public key shown in the tab to `GithubSshKeys` by hand).

## Car controls

Fuller car controls on top of the HUD (`static/js/carcontrols.js`, `carcatalog.js`, `cutaway.js`,
`apamock.js`). On the car they are live and they send (above); in a browser they are a mockup, and the
ribbon says which. The driver-assistance switches are shown greyed on the car: those settings go through
the comma, under the *CAN settings* tab.

Tap the car. A ribbon of categories slides up, the camera goes to a top view with the roof (everything
between the side rails above the doors, and the rear window) faded to a faint outline so the cabin
shows, and the part of the car each category is about pulses in turn under a badge. A badge, a part or
a ribbon item opens its category; a tap on the background goes back, and from there (or with ✕)
closes it and restores the car and your view. Auto view and the replay bar wait while it's open.

The car's parts come first: Lighting, Climate, Seats, Driving, Assist, Energy, Audio, Doors & Windows,
Service and Display; then Connectivity, Profiles & Keys, Navigation, General and Software. Lighting and Seats put
their settings on cards beside the lamps and seats (in a panel when the screen is too narrow for them);
the rest open a half-screen panel, beside the car in landscape and under it in portrait, with the car
framed in what's left. Each category moves the camera to its part and shows its settings on the car:
the lighting preview drives the model's lamps; seat heat glows orange, and the seat's adjusters (the
cushion slides, its front and rear edges rise and drop, the back reclines) move the model's seat;
Climate blows air from the vents, tinted by each side's temperature; Seats
and Driving turn the rest of the car see-through; Driving shows the drive units in x-ray, and a drive
mode change sends a ring of particles out from the car in the mode's color (Earth green, Fun blue,
Hyper orange), styled like the tire trails; Assist draws the sensors' coverage on the ground; Energy
opens a charge-port door on the left front fender and fills an x-ray battery to the charge level;
Audio lights the trunk amplifier and rings over the seats of the chosen sound stage; Doors & Windows
locks and unlocks, swings the doors and the liftgate open, winds each of the four door windows, the two
quarter (doggie) windows and the rear window down to where its slider says (its own top edge, curved or
slanted, sinking into the door), opens or tilts the sunroof (its front panel lifts and slides back over
the rear one), and California Mode opens all eight windows at once. Each door's chip on the car has a
button for the door and one for its window, and rides on the door. Display's Hollywood Mode turns the
center screen to landscape.

*Mock APA* (*Assist → Parking*) demos automated parking in a parking lot drawn around the car. The car
scans along the aisle and reports the open spaces it passes; you pick one (on the ground or in the
panel), the ADAS confirms it, and *Start parking* backs it in (or drives it in nose first) on its own.
`apamock.js` plays both sides of the CAN exchange from `fisker_ocean_adas_world.dbc`: the head unit's
`ICC_0x35B` (`ICC_APAActivation`, `ICC_APAParkSelect`, `ICC_APAParkInDirSetting`) and the ADAS's slots
(`ADAS_APASlot1..6`), state (`ADAS_APASts`), confirmed slot (`ADAS_APASlotSel*`), gear and standstill
requests (`ADAS_0x117`) and chime. The panel shows every signal's value and a log of each change. The
DBC doesn't say in what order these come, so the sequence is our reading of it, not a recorded drive.
While it runs, its simulated drive replaces the live data in the HUD, decoded as `fisker_world.js` would,
so the HUD's own parking drawing (slot outlines, parking-sensor arcs, closest distance per bumper) and
the status card show it.

The menus follow the Ocean user guide where it shows them. Lighting, locking, windows and driver
assistance use the option values the head unit sends on CAN (`carcatalog.js` names each list's DBC signal); the rest are
plausible values for a mockup.

**Design language.** `DESIGN.md` defines the look of the car controls on the Ocean's portrait 1080 × 1920
screen, with Tesla's in-car interface as the reference: a flat ground, hairline cells, small radii, regular
type and almost no color; a sheet with three heights over the 3D car and a flat dock of categories; the
car showing the state (windows, doors, the pack filling with charge) with drag controls pinned to its parts;
Tesla's climate bar; and a power bar on the status card. `static/design.css` holds the tokens and components
(in rem against a 1080-wide frame, so one layout serves the Pulse display, the AVD and a browser) and
`/design.html` on the server renders them, day and night. The HUD uses them: `carcontrols.js` builds the
sheet, the dock and the on-car controls from them.

The model's roof, sunroof, seats (cushion and back apart), windows, vents, screens and console are meshes
of their own in `pulse_ocean_v0.10_parts.glb`. `tools/export_ocean_glb.py` splits them out of the Pulse
Ocean package's glb, which merges every part into one mesh per material: it matches each triangle to the
part it came from in the package's master .blend (and, for parts made of several pieces, which piece),
puts the seat backs and the screen on pivots of their own, leaves out the bent caps the package added
to close the seats (they cut through the cushions and backs as dark wedges), and leaves everything else
(rig, materials, textures, animations) as it was:

```
blender -b Pulse-Ocean-Master.blend --python tools/export_ocean_glb.py -- \
  --glb Pulse-Ocean-ADAS.glb --out third_party/models/pulse_ocean_v0.10_parts.glb
```

## Pieces

The comma's half lives in sunnypilot under `openpilot/sunnypilot/webhud/`: `server.py` (the `webhud`
process: stdlib `http.server` + WebSocket, the 20 Hz tick stream, the REST API; niced, reads nothing while
no viewer is connected), `state.py` and `extract.py` (the frames and service extracts gathered since the
last tick, and the latest of each for a viewer that just connected), `sources.py` (live cereal and
rlog/qlog replay), `demo.py` (a synthetic drive that encodes real ADASBUS frames, `--demo` or *Playback →
Play demo drive*), `dbc.py` (the twin of `static/js/world/dbc.js`, for the demo and the overrides' live
values), `mdns.py` (`sunnypilot.local`), `maptiles.py`, `websocket.py`, and
`selfdrive/car/can_overrides.py` behind the overrides API.

| File | Role |
|------|------|
| `static/js/world/fisker_world.js` | Realtime world model from ADASBUS (see below), in the page's worker. |
| `static/js/world/fisker_radar.js` | Mid-range radar tracks from its private CAN (bus 1), decoded with the reverse-engineered `fisker_ocean_mrr.dbc`. Kept apart from ADASBUS: the radar reuses its IDs. |
| `static/js/world/world_model.js` | Ego odometry and the multi-source object tracker behind the *World model* view. |
| `static/js/world/state.js`, `worker.js` | Fold the bridge's ticks into the one snapshot the view renders; the worker hosts it all off the main thread. |
| `static/js/world/dbc.js` | Small DBC reader/decoder: latest value of every signal at display rate, plus the metadata opendbc drops (value tables, comments, units, ranges) for the UI and the signal browser. |
| `static/` | The app (plain ES modules, no build step). three.js and the Ocean model live in `third_party/`, the DBCs in `dbc/`. |
| `serve.py` | Dev server for a browser: the page with the same URL roots as the app, `--bridge` relaying `/api`, `/ws` and `/map` to a comma. |
| `tools/gen_world_dbc.py`, `tools/gen_ibus.py` | Generate the ADASBUS subset and the IBUS DBC (with `ibus_tables.js` and the app's `CanIds.kt`) from the FM29 matrices; the outputs are checked in. |
| `tools/record_ticks.mjs`, `replay_ticks.mjs`, `pose_eval.mjs`, `map_eval.mjs` | Save a bridge's tick stream and run the worker's pipeline over it in Node, for the decoding, the fusion, the pose and the map matcher without a browser. |
| `tools/export_ocean_glb.py` | Rebuilds the Ocean model with its roof, sunroof, seats, windows and dash parts split out, for the car controls (run in Blender). |
| `android/` | The app for the car's screen (Pulse): carries the page in its APK, finds the comma on the hotspot and relays its API and stream, reads IBUS1/IBUS2. |

## ADASBUS signals used

Bus 2 (ADAS module) unless noted; the full set is in the *Signals* tab.

- **Lanes:** `0x339` LeLine1, `0x20A/0x20B` LeLine2/3, `0x20C/0x20D/0x20E` RiLine1/2/3 (offset, heading, curvature radius, type, color, confidence); `0x20F` lane width + lane types; `0x340` what the cluster draws (blue while lane centering, red/flash on departure); `0x350` adjacent lane widths/types, oncoming lanes, landmarks, crosswalk/stop line, construction; `0x210` curbs.
- **Objects:** `0x33B 0x34B 0x32D 0x33D 0x34D 0x32F 0x33F 0x34F` ADAS_Obj1..8 (position, size, heading, class, brake light). Highlights come from `0x31C` ACC primary/secondary target, `0x353` leading vehicle, `0x315` BSD/DOW threat IDs, `0x31A` AEB/rear-AEB/BACM threat IDs, `0x31B` ELKA threat. Positions decode at 0.2 m/bit, not the matrix's 0.5 (checked against openpilot's leads; corrected in `tools/gen_world_dbc.py`), so the list reaches ~50 m. Against the radar the range fits ~0.25 m/bit from about the rear axle instead; the world model's sensor calibration corrects for that, and the raw view shows the list as decoded. Cars are drawn from this list; openpilot's two leads (from the comma camera; the Fisker port has no radar) fill in only where the ADAS has no car, and a re-IDed ADAS track is merged rather than shown twice.
- **ACC / assist:** `0x313` ACC state, TJA autosteer, ISA/TSR/TLR state; `0x31C` set speed, time gap (+ recommendation), icon, function type; `0x314` LKA/ELKA/ESA/LCA/APA/DOW/BSD/DCAA/AHBA states; `0x31B` lane-change trajectory and hands-on request; `0x342` HOD, haptic and turn-lamp requests.
- **Warnings:** `0x317` chimes, takeover request, cluster/mirror warnings, fault text; `0x31A` AEB warning/intervention and telltales; `0x311` degradation pop-ups.
- **Signs & lights:** `0x311` TSR speed limit (+ unit), `0x210` sign condition, no-passing, traffic light color/shape, `0x351` traffic light distance, lead turn signal/brake, `0x334` prohibition signs, camera blockage.
- **Parking:** `0x352` ultrasonic zones (front/rear/left/right × 4), `0x356/0x359` park-distance (cm), `0x2C7..0x2EA` APA slots, `0x2CD` curb warnings, `0x316` surround-view state.
- **Driver monitoring:** `0x527`. **Camera:** `0x32B`.
- **Vehicle (bus 0):** `VCU_0x102` driver torque request per axle, `MCU_F_0x150`/`MCU_R_0x151` motor torque + speed, `VCU_0x214` gear/ready/pedal, `ICC_0x531` cluster speed + unit, `BCM_0x335` lamp outputs, `EPS_0x1C2` steering angle, `BCM_0x343` doors/locks/windows, `PLGM_0x471` liftgate, `ECC_0x373` outside temp, `VCU_0x358` regen/e-pedal, `ICC_0x52A`/`ICC_0x35B` the ICC's own settings (shown next to the overrides).
- **Position (bus 0, from the telematics box through the gateway):** `TBOX_0x526` GPS lat/lon (10 Hz), `TBOX_0x525` altitude, `TBOX_0x179` fused heading + std dev, `TBOX_0x174..0x176` its IMU (the forward velocity calibrates the wheel speed; the angular rates don't match the chassis gyro's scale and aren't used). The fix quality (`0x46B..0x473`: fix OK, HDOP, satellites, horizontal accuracy) is on IBUS1 only, so the app sees it and the comma doesn't.
- **Map horizon (bus 0, the head unit's ADASIS v2 from its navigation):** `ICC_0x361` position on path (offset, probability, age ~150 ms, relative heading), `ICC_0x250` segment (road class, form of way, lanes, speed-limit class), `ICC_0x251` stubs (branches, turn angle), `ICC_0x255` profile short (curvature, slope, ~900 m ahead; value 511 = straight), `ICC_0x252` profile long (signs), `ICC_0x362` meta. Forwarded by the bridge and read on IBUS2, not decoded yet (the IBUS2 matrix has 0x255's header three bits off; `tools/gen_ibus.py` corrects it to the standard layout the car sends).

Not documented in the matrix, so exposed as display toggles (*Display → Geometry calibration*): the
sign of lane curvature and of object heading (lane heading grows to the right, verified on the car).
Verify them on a drive with good lane confidence against the openpilot lanes (*Lane lines → Both*).

## API

`GET /api/status`, `GET /api/routes`, `POST /api/replay {action: load|play|pause|toggle|seek|step|speed|live|demo, ...}`,
`GET /api/ssh`, `POST|DELETE /api/ssh/authorize {publicKey}` (the app's SSH key into or out of `GithubSshKeys`),
`GET /map/tile/<lat>/<lon>/<name>` (an OSM road tile, fetched into mapd's folder on first use),
`PUT /api/upload?name=<file>` (raw rlog/qlog body), `GET|PUT /api/params` (personality, experimental
mode, units), `GET|PUT|DELETE /api/overrides`. Static (the app and `serve.py`; the bridge serves `/dbc/` only, and the
page with `WEBHUD_PAGE_DIR` set): the page, `/vendor/`, `/models/` and `/dbc/`. WebSocket `/ws`: the server sends
`{type: hello}` then `{type: tick, data: {now, reset?, brand, can: [[t, [[addr, bus, hex], ...]], ...],
op: [[service, t, extract], ...], mode, replay, server}}` at 20 Hz (the first tick for a new viewer is a
snapshot of the latest frame of every message, with `reset`); the client sends `{type: replay, ...}`.
A viewer that falls behind gets its missed ticks merged into one, never dropped. The world model's
sensor calibration is a page setting now (*Display → Debug*).

Writes are accepted from private addresses only, never cross-origin, and CAN override changes, SSH keys
and replay are refused while the car is moving (replay also stops itself if the car starts moving).

## Development

```
python3 serve.py --bridge sunnypilot.local       # the page at http://localhost:18088, fed by the comma
python3 serve.py --bridge 127.0.0.1:8088         # fed by a bridge on this PC (below); without --bridge the page runs offline
node --test static/js/world/tests/*.test.js      # the page's decoding and world model (also: npm test)
node tools/record_ticks.mjs http://sunnypilot.local:8088 ticks.jsonl --seconds 120   # save a bridge's tick stream
node tools/replay_ticks.mjs ticks.jsonl          # the same pipeline over a recorded tick stream
node tools/pose_eval.mjs ticks.jsonl             # how the pose estimator did on it (fix innovations, heading, scale, lag)
node tools/map_eval.mjs --tiles ~/.comma/media/0/osm/offline ticks.jsonl   # how the map matcher did (vs mapd's road name)
python3 tools/gen_world_dbc.py FM29_ADASBUS_Matrix_CANFD_V390.8_20230524.dbc   # regenerate dbc/fisker_ocean_adas_world.dbc (copy it to sunnypilot too)
python3 tools/gen_ibus.py FM29_IBUS1_Matrix.xlsx FM29_IBUS2_Matrix.xlsx       # regenerate the IBUS DBC, ibus_tables.js and CanIds.kt
cd android && ./gradlew assembleRelease          # the APK
```

A bridge on a PC, from a sunnypilot checkout (it serves no page of its own; point `serve.py --bridge` at it,
or set `WEBHUD_PAGE_DIR` to this checkout and it serves the page too):

```
python -m openpilot.sunnypilot.webhud.server --demo                       # synthetic drive
python -m openpilot.sunnypilot.webhud.server --replay <rlog.zst | segment dir | route dir>
python -m openpilot.sunnypilot.webhud.server --replay <rlog.zst> --map-root <dir of OSM cells>   # the map from somewhere other than mapd's folder
pytest openpilot/sunnypilot/webhud/tests                                  # the bridge's tests
```

On a PC without the native params library, the bridge keeps settings in `~/.comma/webhud_dev_params.json`.
