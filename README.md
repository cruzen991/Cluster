# Classic Cluster

Round dials on the instrument cluster of an iDrive 7 car (MGU head unit, Live Cockpit Professional cluster): a
speedometer with a fuel gauge, a tachometer with boost (0-21 psi) and oil-temperature gauges and a gear window, and a centre panel with
the drive mode, the speed, the range and the odometer. By default the stock gauges are hidden behind a black
background while the dials are on; BMW's warning and indicator lights are drawn by the cluster above it.

![The Tech style](docs/cluster.png)

Two gauge styles (Settings → *Gauge style*):

- **Tech** (the default): Orbitron numerals, hollow red needles with a glow, a white ring along each dial that lights
  up behind the needle, and **shift lights**: ten segments outside the tach over the 2,000 rpm below the redline,
  lighting green, then yellow, then red, one more every 200 rpm, and all flashing red from the redline (setting
  *Shift lights*, on).
- **Arc**: one tachometer in the middle with the gear and speed inside it, a red arc that fills
  with the revs, a "red glass" needle (pale outline, see-through red middle, red glow) and the shift lights; numerals that grow as the needle comes up to them; big
  readouts left (oil, coolant, fuel bar, range) and right (boost with the drive's peak beside its label, torque,
  odometer; the peak ignores anything over 35 psi as a bad sample and resets after the engine has been off a minute); and a strip along the bottom
  with the outside temperature, the drive mode and the intake air temperature, over a red perspective grid that
  fades into a horizon below the middle ([picture](docs/arc.png)), or (setting *Background*) graphite: dark grey falling
  to black with a soft red pool of light under the dial ([picture](docs/arc-graphite.png)); dusk: a deep red rising
  from the bottom edge ([picture](docs/arc-dusk.png)); or twin glow: soft red light behind each side's readouts
  ([picture](docs/arc-twin.png)). The stock cluster is always
  hidden in this style. The background is drawn at half size (960x360, 1.4 MB of cluster-render's shared 16 MB) and
  stretched by the renderer.
  **Driver camera:** cars with Driving Assistant Professional have a driver camera on top of the cluster, over the
  middle. With the setting *Driver camera above the cluster* (on by default) the tach and the gear inside it are
  drawn 80 % size and lower, so no tick or numeral sits under it; turn it off on a car without the camera for the
  full-size tach.

The Sport and Classic styles were removed in 0.11.0 (they are in this repository's history up to 0.10.3); a car
set to either shows the Tech style.

The Tech style's speedometer is 0-160 mph by default (0-260 km/h in km/h).

It is an app for the [MGU Store](https://github.com/robertnisipeanu/mgu-store). It draws through
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render) on the cluster's
`panel` target (1920x720, over the stock gauges). The Store installs cluster-render with it.

> **Status: untested on a car.** Tested on a PC only: on a stubbed head unit with demo data, against a stand-in for
> cluster-render that checks every message against its protocol and composites what the cluster would show. Read
> "Before you drive with it" below.

## Road Hopper (game)

A second app in this repository: hop across a busy road and a river to fill the five homes at the top
([picture](docs/road-hopper.png)). An original game in the spirit of the arcade road-crossing games, with its own
artwork. **Parked only** by default (it pauses while the car moves; setting *Parked only*).

- **Controls:** turn the iDrive knob to hop left or right (one click, one hop), press to hop forward (when you let
  go), press and hold to hop back. Pushing the controller up / down / left / right also hops, but only where the
  HMI lets the game have the controller; otherwise the HMI acts on a push too (its menu, or back out of the app),
  so use the knob and press. If the car doesn't send the controller's state to apps, turn to pick Left / Hop /
  Back / Right on the hidden buttons and press to hop.
- **Rules:** cars and trucks end a life; in the river stand on logs and rafts (rafts with a dark flicker are about
  to sink); being carried off the side ends a life; a hop onto the bank between homes ends a life. 40 s per
  crossing, 3 lives, an extra life at 10,000. Each level is faster (12 % a level). Best score kept.
- **Menu:** Play / Continue, New game, settings (traffic speed, knob direction, parked only). BACK in the game
  returns to the menu; the game waits there and its clock stops.
- **Sound: none.** The app kit has no way for an app to play audio, and the head unit's audio is managed by its
  own system, so the game only reports its sound moments (hop, splash, squash, home, level, game over) internally.
- **Status: untested on a car.** Tested on a PC: its rules and controls with `node apps/mx_road_hopper/test.js`, a
  bot that plays it (reaching homes on every speed), and the kit's desk preview with the GPU renderer stand-in.


## Install

1. Have the MGU Store on the head unit (root SSH access is needed once for that; see its README).
2. Push this folder to a GitHub repository of your own (it can be private: add a token in the Store's
   Settings → Accounts).
3. In the Store: Settings → **Add source** → `<you>/<repo>`, channel **Branch: main**.
4. Install **Classic Cluster**. The Store builds it on the head unit (it takes BMW's app SDK from a BMW app already on
   the unit; none is in this repository) and installs cluster-render first.
5. Open the app once from *All apps*. The dials go on the cluster when the panel is free; the app's screen says
   what the cluster is doing.

To remove it: uninstall it in the Store. The stock cluster comes back as soon as the app's layers go.

## Turning it on and off

- **In the app:** the first button, *Cluster on / off*, or Settings → *Show on the cluster*. The choice is saved, so
  off stays off after the car restarts.
- **What off does:** the app closes its connection to cluster-render. cluster-render drops every layer of a client
  whose connection goes, so the dials disappear and the stock cluster is back within about 3 seconds, whatever state
  the app was in. The same happens if the app crashes or is stopped.
- **Uninstalling** in the Store removes the app and its layers; the cluster renderer can be removed after it.
- **If the head unit's screen is unusable:** over SSH, `systemctl stop cluster-render` takes every app's content off
  the cluster at once.

## Can it brick the car or leave the stock cluster stuck?

**Bricking:** this app writes nothing to the instrument cluster, any control unit, the head unit's firmware or its
coding. It only writes into its own data folder on the head unit. What it does to the cluster is ask cluster-render to
show a picture in the cluster's `panel` slot, the same display-sharing mechanism BMW's own head-unit software uses;
the cluster itself decides what to show and keeps it only while asked. The real bricking risk in this whole setup is
in rooting the head unit and installing the Store, not in this app.

**Stuck or restarting cluster:** the realistic failure is the cluster rejecting the content and restarting, or the
dials flickering. These protections are built in:

| Protection | What it does |
|---|---|
| Never takes the slot from BMW | cluster-render's panel never unmaps BMW's content (`panel_take_over_stock = 0`), and this app waits for the slot to be free by default rather than retrying against BMW's pop-ups (setting *Retry after BMW pop-ups*, off) |
| Drawn under the telltales | cluster-render's notes record the panel as drawn over the gauges and under the warning and indicator lights, checked on a car |
| Off releases everything | off closes the connection; nothing of the app is left on the cluster |
| Guard: losses | the dials lost within 10 s of showing, 3 times in 2 minutes, not to BMW's own content: one strike |
| Guard: restarts | the head unit, the cluster renderer or the app going down within 20 s of the dials first showing: one strike at the next start |
| Guard: errors | 5 errors in the drawing loop within a minute: one strike |
| Guard: off | 2 strikes turn the cluster off and keep it off across restarts; the app's screen says *Off for safety* and why. Turning it on again in the app clears the strikes |
| Stale data | no speed or engine speed for 1.5 s: needles to zero, LCDs `---` |

cluster-render has its own mapping guard, but for the panel it only logs; it never disables the panel. That is why
this app has one. One side effect: switching the car off within 20 s of the dials first appearing counts as a
strike, so two very short starts in a row can turn it off; turn it back on in the app.

Not handled: if the app froze without crashing, the connection would stay open and the needles would stop moving.
The app's own loop catches its errors, but a freeze is not something it can see from inside.

## What it shows and where the values come from

| Dial | Signal (SOME/IP, what the head unit already receives) |
|---|---|
| Speedometer, 0-160 mph (inner km/h scale) or 0-260 km/h | `Vehicle2.statusCarSpeed2` |
| Tachometer, scale to redline + 500 rpm, red from the redline | `CDS.statusEngineSpeed2` |
| Shift lights (Tech style) | `CDS.statusEngineSpeed2` |
| Oil temperature, 120-300 °F or 50-150 °C | `CDS.statusEngineTemperature` |
| Boost, 0-21 psi (small gauge, left of the tach's bottom) | `FES.statusSwitchDriveDynamicSport2` (`displayBoostPressure`), raw x 0.01 bar as the idrive7-apps Live Data app reads it (its scaling marked "scale?" there); setting *Boost signal*: gauge (default) or absolute (subtracts 14.7 psi). If it reads about 14 psi at idle, the signal is absolute: switch the setting |
| Fuel, 0-1/1 | `KombiIF.statusRangeTankStatus` (litres) over the tank size setting |
| Gear LCD: P, R, N, D1-D8 | `VehicleInformation.statusGearboxDrive` / `DataPowerTrain2` |
| Drive mode (centre panel, text) | `FES.statusFESVehicleDynamicSwitchHMI` (`actualValueModeDrivingExperience`), decoded with the idrive7-apps Live Data app's table; *DRIVE MODE ---* until the car sends one |
| Range and odometer (centre panel) | `KombiIF.statusRangeTankStatus` |
| Coolant (Arc) | `CDS.statusEngineTemperature` |

In the Arc style oil and coolant refresh every 3 s, intake every 2 s (read from the engine unit every 2 s), outside temperature every 2 minutes (boost, torque, speed and gear 4 times a second): temperatures move slowly, and a value flickering between two degrees would otherwise redraw and re-upload its big figures for nothing.

| Torque (Arc), lb-ft or Nm, in steps of 5 | `FES.statusActualValueTorque2` (`actualValueTorqueCrankshaft`, 0.5 Nm a bit, the kit's scaling); engine braking shows 0. Treat it as the engine unit's estimate, not a dyno figure; scaling unverified on this car |
| Outside temperature (Arc) | `EnvironmentalInformation.ExteriorTemperature` (raw x 0.5 - 40 °C) |
| Intake air temperature (Arc) | read from the engine unit (DME, 0x12) every 2 s over the head unit's diagnostic link, **read-only**: the kit's `readonly-diag.js` refuses anything but ReadDataByIdentifier / OBD reads, so the app cannot write to or reset any control unit. Same candidates as the kit's M Vitals app (`22 F40F`, `22 F477`, OBD PID 0F). Only while the Arc style is on the cluster; `--` when the engine unit does not answer |

The signal decoding is the idrive7-apps kit's (`kit/runtime/car.js`), which other apps already use on cars.

## Settings

Show on the cluster; gauge style (Tech, Arc); background (Arc: horizon grid, graphite, dusk or twin glow); torque in lb-ft or Nm (Arc); shift lights (on); stock cluster hidden (default) or showing
between the dials; mph or km/h; °F or °C; redline (7000 for a
B58); the needle sweep at start; tank size (59 l for a G20 M340i); moving the dials apart, together, up or down;
needles drawn as redrawn images (default), as a rotating layer (Arc style) or by a shader; boost signal gauge or absolute; retry after BMW pop-ups (off); demo data on the cluster
(never, by default).

The sweep takes about 2.5 s (up, a moment at full scale, back). The one at start waits 2.5 s after the dials show,
until their first pictures are uploaded (before 0.11.3 it ran at once and the renderer, still busy with that upload,
dropped its frames: it was never seen). In *Redrawn images* the needle moves 5 times a second, so the sweep steps;
in *Rotating layer* it is smooth.

The *Needle sweep* button sweeps whatever the *Needle sweep at start* setting says (that setting only controls the
automatic one); the app's screen says when it runs, or why it did not (the cluster off, or the car moving).

The app's own screen in the head unit always uses the HMI's own image (software rendering), never the Store's GPU
renderer. Version 0.1.0 let the kit switch to the GPU renderer once it found it running, which put a blank surface
over the app's screen and took the iDrive controller with it; 0.2.0 fixes that. If that blank screen ever shows
again, press the controller's MENU or HOME button, or hold the volume knob down until the head unit restarts.

## Before you drive with it

- **Check it parked, engine running, before anything else.** Put the car in P, start it, open the app, and compare
  the needles with the stock cluster (switch the app off and on with the first button). Then drive slowly in a car
  park.
- **Warning lights.** cluster-render's notes say the panel is drawn under the telltales (checked on one car, not on
  yours). Check anyway: with the dials on, turn the indicators on and look for the seat-belt, brake and check-engine
  lights at start. If any is hidden, switch the app off.
- **What hiding the stock cluster also hides.** The black background covers everything the cluster draws under the
  panel: the stock speedometer and tach, the centre area (navigation, media, the trip computer) and, possibly, Check
  Control message texts and cruise-control and driver-assist displays there. The warning lights stay above it. When
  BMW's own content takes the slot (a door-open warning, for one), the stock cluster shows until it goes. If you rely
  on adaptive cruise or lane-keeping displays, set *Stock cluster* to *Shows between the dials*.
- **Speed.** The needle and the LCD show the car's own vehicle speed as sent on the bus. The stock speedometer
  reads a little high on purpose (the law lets it over-read, never under-read); this one shows that value without the
  margin, so expect it to read about 1-3 mph lower than the stock one at highway speeds.
- **Stale data.** If no speed or engine speed has come for 1.5 s, the needles drop to zero and the LCDs show `---`,
  rather than freezing on an old value.
- **No demo data on the cluster** unless you switch the "Demo data on the cluster" setting on, which is for parked
  testing.
- **Who wins the cluster.** BMW's own content (door-open warnings, the speech dialog, phone pop-ups) can take the
  panel slot; the dials then wait until it is free. Expect them to disappear and come back.
- **The Waze HUD map** uses the same scene as the panel, so cluster-render never shows both at once.
- **Head-unit updates.** A BMW software update can stop third-party apps; reinstall from the Store.

## Files

| Path | |
|---|---|
| `apps/mx_classic_cluster/faces.js` | the still artwork: faces, LCDs, the centre panel; and each style's moving parts as numbers |
| `apps/mx_classic_cluster/arc.js` | the Arc style: its face, the growing numerals, the readout panels |
| `apps/mx_classic_cluster/fx.js` | the moving parts (needles, hubs, lit ring, shift lights) as a shader and as its JavaScript twin |
| `apps/mx_classic_cluster/cluster.js` | the cluster layers through cluster-render, needle smoothing, the sweep |
| `apps/mx_classic_cluster/main.js` | the app: car data, on/off, safety rules, its own screen |
| `apps/mx_classic_cluster/modes.js` | the drive mode as text |
| `apps/mx_classic_cluster/guard.js` | turns the cluster off by itself after repeated failures (above) |
| `apps/mx_classic_cluster/cluster_render_client.js` | cluster-render's Node client (MPL-2.0, unchanged) |
| `apps/mx_classic_cluster/test.js` | `node apps/mx_classic_cluster/test.js` |
| `kit/runtime/fonts/orb*.json` | Orbitron, baked for the kit's canvas (SIL Open Font License, `OFL-Orbitron.txt`) |
| `kit/` | the app kit from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT) |

Preview on a PC (no SDK, nothing installable): `python3 kit/tools/build.py --preview-only mx_classic_cluster`,
then `node kit/tools/preview.js dist/mx_classic_cluster preview wait=8 render`.

## Smooth needles (0.12.0)

The needles' motion is sent as **renderer animations**: about 10 times a second the app tells cluster-render
"from here to there over 100 ms", and the renderer plays it on the cluster's own clock, every frame. Before,
each step was a value in the renderer's next update, and an update waits for that moment's picture uploads, so
the needles moved in jerks however fast the app sent them. *Shader* (now the default: the needle, the lit arc
and the shift lights all glide) and *Rotating layer* use it; *Redrawn images* can't (the needle is pixels) and
stays the fallback.

## Performance (Arc style)

What the Arc style sends to the cluster while driving hard (a desk simulation: revs climbing 2,000 to 6,800
rpm every 3 s, boost and torque following), by needle setting:

| Needles | Sent to the cluster | How the needle moves |
|---|---|---|
| Redrawn images (default) | about 2.0 MB/s | 5 times a second, the dial's pixels redrawn |
| Rotating layer | about 0.6 MB/s | 30 times a second: the needle is its own small layer that the renderer turns (a message of a few bytes); only the lit arc, the shift lights and the growing numerals are redrawn |
| Shader | about 0.7 MB/s | every frame, from one uniform |

The readouts draw their figures in fixed slots, so a change of one digit sends only that digit; a growing
numeral sends only its changed ink. Before 0.11.0 the same drive sent about 3 MB/s (redrawn). cluster-render's
upload budget is 2-5.5 MB/s, shared by every app on the cluster.

*Rotating layer* and *Shader* are not yet confirmed on a car. If the needle does not show with either, set
*Redrawn images* again.

## How the cluster is drawn

**cluster-render lets one app have at most 8 layers** (and 32 for all apps together); a layer over the limit is
refused with "too many layers". Versions up to 0.6 asked for about 15, and the needles, made last, were the ones
refused: that is why the dials showed on the car and the needles did not. From 0.7 the app uses at most 7:

| Layer | |
|---|---|
| background | a 16x16 black image stretched over the whole cluster (only with *Stock cluster: hidden*) |
| centre panel | drive mode, speed, range, odometer; a speed change sends only the speed's rectangle |
| speedometer face, tachometer face | still images, drawn once |
| speedometer moving parts, tachometer moving parts | needle, hub, small needle, lit ring and shift lights of one dial, together (`fx.js`) |
| gear window | on the tach |
| (speed window) | on the speedometer, only when the centre panel is off |

The moving parts, two ways (setting *Needles drawn by*):

- **Redrawn images (default):** no shaders at all. The app draws the moving parts (`fx.js`) into the face image itself
  and sends only the rectangles that changed (at most 12 per update, as cluster-render rewrites the whole image past
  16), at most 6 times a second per dial: 1-4.5 MB/s of the link while the needles move, and real CPU work on the
  head unit. This is the mode seen working on a car.
- **Shader:** each dial's moving parts are one effect layer drawn by a fragment shader; the state is one uniform (4
  numbers), so a frame costs a few bytes. Smoother. In 0.7.0 it showed no needles on the car: that shader demanded
  `highp` precision, which many embedded GPUs do not have in fragment shaders, so it would not compile there. From
  0.8.0 it uses `highp` only where the GPU has it (as cluster-render's own examples do), and the redline flash is
  driven by the app, not a shader clock. Not yet seen on a car: if it shows no needles, the app screen's *moving*
  line says what cluster-render reported.

**Keeping the app responsive.** The app answers the iDrive screen on the same thread that draws the dials, so no
step may block for long. 0.8.0 blocked for up to about 1 s on this PC (several seconds on the head unit) whenever the
cluster turned on, and used about half the processor while the needles moved: the app took several tries to open,
and the on/off button seemed to need several presses. From 0.9.0:

- the redrawn mode's drawing does trig once per update instead of once per pixel and skips what a part cannot reach:
  a dial's first picture 470 → 8 ms, an update 42 → 7 ms (this PC);
- at most 5 updates a second per dial, none for a move under half a degree;
- the faces are drawn on separate turns of the event loop and cached, so turning the cluster on again does not draw
  them again;
- the cluster starts 1.5 s after the app, so the app's own screen opens first;
- the app's screen is status text, twice a second (0.8.0 drew two small moving dials four times a second, and every
  changed frame is compressed in JavaScript);
- on/off: one press is one change; presses within a second of the last are ignored, and the screen says *Turning
  on...* at once.

Measured with the needles moving, toggling on and off: the longest block 846 → about 90 ms, the app busy 50 % → about
9 % of the time (this PC; expect a few times more on the head unit).

The gear and speed windows are transparent apart from their figures (0.7.0's opaque box hid the needle at low rpm).

The app's screen in the head unit shows *Layers: n of 8* and, per group (background, centre, dials, moving, lcds),
what cluster-render reports for them (shown, waiting, stalled, hidden, error) and why. A photo of that screen says
where a problem is.

## Licences

The app's own files (`faces.js`, `fx.js`, `cluster.js`, `guard.js`, `main.js`, `modes.js`, `test.js`): MIT. Orbitron
(`kit/runtime/fonts/orb*.json`): SIL Open Font License 1.1, The Orbitron Project Authors. `cluster_render_client.js`: MPL-2.0
(Robert Nisipeanu). `kit/`: MIT (cauliflowermossgrape, `kit/LICENSE-idrive7-apps`). Not affiliated with or endorsed by
BMW AG.
