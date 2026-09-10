# APEX

A physically-based 3D racing simulator that runs in the browser.

Five real downloaded car models, captured HDRI lighting, a Pacejka tyre model
with load sensitivity and thermal behaviour, raycast suspension with anti-roll
bars, a limited-slip differential, and aerodynamics that actually change how
the car behaves at 300 km/h. Five circuits, six weathers — from a clear
evening to a storm with standing water — and coloured pacing arrows on the
road that tell you where to brake.

**Play it:** https://waldnerc34-dotcom.github.io/wer/ — on a phone (turn it
sideways), a tablet or a desktop browser. Every push to this branch builds the
site and publishes it to the `gh-pages` branch through
`.github/workflows/pages.yml`.

If that link shows a 404, Pages is not switched on yet — a one-time step
only the repository owner can do: **Settings → Pages → Build and deployment
→ Source: GitHub Actions** (or *Deploy from a branch* → `gh-pages` / root;
the workflow prepares both). The site appears within a minute and stays up
to date from then on. GitHub only offers Pages on public repositories under
the free plan, which is why this repository is public; a private copy could
instead drop the built `dist/` folder onto any static host (Netlify Drop,
Cloudflare Pages, Vercel) for the same kind of link.

```bash
npm install
npm start            # builds, then serves the game on your network
```

`npm start` prints two addresses: `http://localhost:4173/` for the machine
you ran it on, and a `http://192.168.x.x:4173/` one for a phone or tablet on
the same Wi-Fi. Assets are committed, so there is nothing else to fetch.
`npm run dev` runs the Vite dev server instead, and `npm run build` produces
a static `dist/` you can host anywhere.

### Add it to your home screen

The site is an installable web app: a manifest, a set of icons (the pacing
chevron on tarmac — `npm run icons` redraws them from `tools/make-icons.mjs`)
and a service worker that caches everything after the first visit, so it
opens full-screen from the home screen and works offline.

- **iPhone / iPad** — open the address in Safari, tap Share → *Add to Home
  Screen*. Works from `npm start` on your own Wi-Fi as well as from the
  public site.
- **Android** — Chrome offers *Install app* from the menu. Android needs a
  secure address for that, so install from the GitHub Pages URL (or from
  `http://localhost` on the phone itself); a plain home-Wi-Fi address opens
  the game but stays a bookmark.
- **Desktop Chrome / Edge** — the install icon in the address bar, from
  `http://localhost:4173/` or the public site.

## As a single file

`npm run build:artifact` packs the entire game — code, four of the five
cars, the scenery, the surface maps and one sky — into `artifact/apex.html`,
a page with no network dependencies at all. It is built for hosts that run scripts
but never let a page fetch: a chat artifact, an email attachment, a USB stick.

To fit that under a 16 MB ceiling without a mesh decoder (decoders need
workers or wasm, which such hosts may refuse), the packer re-encodes the
models with KHR_mesh_quantization, which three.js reads natively, prunes
vertex attributes no material reads, simplifies each car to a budget, halves
the surface maps to 512², and turns every model texture into a data: URI so
the loader never fetches or creates a blob. The Ferrari needs more: it is
unwelded triangle soup, every vertex owned by one face with its own normal
and its own patch of a baked-AO UV layout, so nothing welds and nothing
simplifies. The packer strips those attributes, welds on position alone,
simplifies, and recomputes smooth normals — 5.1 MB becomes 1.4 MB, which is
what makes room for four cars. The Datsun, with 4 MB of textures, is the one
that stays on the site build; a build only lists the cars it can load. The
loader's embedded mode (`src/core/Assets.js`) parses models and the HDRI
straight from memory.

`npm run serve:artifact` serves that file under a Content-Security-Policy
stricter than any plausible sandbox — nothing fetchable, no blob:, no
workers, images only from data: — so a run against it proves the page will
boot where it is going.

## On a phone

Open the link above, tap **Go racing**, and turn the phone sideways. The left
thumb gets an analogue steering slider (or tilt the phone like a wheel — pick
*Tilt* on the start screen), the right thumb gets brake and throttle pads with
a handbrake above them, and the small buttons along the top switch camera,
look behind, rejoin the circuit and pause. Add it to your home screen for a
full-screen app with no browser chrome.

Phones get their own render path rather than a scaled-down desktop one:

- No post-processing chain. Tone mapping runs in the main pass and the
  hardware does the anti-aliasing — mobile GPUs are tile-based, so MSAA is
  close to free there while a half-float composer is anything but.
- Rendering at 0.8× CSS pixels, never at the 3× native density.
- Two shadow cascades at 1024², 140 m of shadow range, about half the
  scenery, and a quarter of the particle budget.
- A session downloads about 7 MB. Models are Draco-compressed with WebP
  textures, the authored surface maps are WebP, and only one HDRI is fetched.


---

## Controls

| | |
|---|---|
| `W` / `S` | Throttle · brake |
| `A` / `D` | Steer |
| `Space` | Handbrake |
| `Q` / `E` | Shift down · up (switches the box to manual) |
| `V` | Cycle camera — chase, close, bonnet, cockpit, TV |
| `C` | Look behind |
| `R` | Rejoin the circuit |
| `L` | Headlights |
| `Esc` / `P` | Pause, driver aids, restart |

A gamepad is picked up automatically (standard mapping: triggers for the
pedals, left stick to steer, bumpers to shift). The pause menu toggles ABS,
traction control, stability control, the automatic gearbox, inverted steering
and the **pacing arrows**.

A key is all-or-nothing, so `src/core/Input.js` stands in for a pair of
hands. Steering follows how long the key has been down and starts slow — the
first tenth of a second is a nudge, full lock takes a quarter of a second at
parking speeds and most of a second at 200 km/h — so a tap is a correction
and a hold is a corner, with room between the two. Releasing centres quickly.
What "full lock" means is decided by the car (below), not the key.

### Pacing arrows

Chevrons are laid along the racing line for the whole lap, each pointing
the way the car should travel, coloured by what you should be doing there:
**green** — accelerate, **yellow** — ease off and hold your speed, **red** —
brake. Follow them and you are on the line: wide into the corner, across the
apex kerb, wide out. They come from an ideal speed profile
(`src/track/Pacing.js`): the cornering limit from the line's curvature and
camber, a backward pass that pulls speed down ahead of every corner at
whatever braking the friction circle and the grade leave, and a forward pass
that lets it climb out at what the engine and traction can give. The profile
is rebuilt when the weather changes the grip, so in the rain the red zones get
longer and start earlier. The HUD spells the same instruction out under the
corner name.

---

## What is actually simulated

The car is a six-degree-of-freedom rigid body. Nothing about its behaviour is
scripted — understeer, snap oversteer, weight transfer under trail braking,
wheelspin out of a hairpin and the way the car settles over a crest all fall
out of the same loop.

**Tyres** — `src/physics/TireModel.js`

- Pacejka Magic Formula, evaluated on a **slip circle** so longitudinal and
  lateral demand share one friction budget. A locked wheel cannot also steer.
- **Load sensitivity**: peak grip rises less than linearly with vertical load,
  so a car that transfers weight badly loses total grip.
- **Relaxation length**: slip builds over distance travelled, not instantly.
  This is what makes the car stable at walking pace and gives steering its
  small, correct delay.
- **Temperature**: grip peaks in a working window. Abuse the tyres through a
  long corner and the outside front goes off — you can watch it happen on the
  HUD.

**Weather and the road** — `src/track/Track.js`, `src/game/Weather.js`

- Every surface has a dry grip figure and a wet one, blended by how soaked the
  track is. Tarmac loses about a quarter of its grip in the rain; painted
  kerbs lose half.
- **Aquaplaning**: on a soaked road, above ~130 km/h, the tyre starts to ride
  on the water film and grip falls further with speed.
- Kerbs are raised, with a 0.6 m ridge profile — at 150 km/h that buzzes
  through the suspension at about 70 Hz, which is what a kerb sounds like.
- **Slipstream**: a car tucked in behind another pays up to 30% less drag and
  loses some of its downforce with it, which is what makes the tow worth
  having on the straight and a liability into the braking zone.
- Tyres cool toward the ambient temperature the weather sets, so a wet track
  is also a cold one.

**Driver aids** — `src/physics/Vehicle.js`

These are what make a 600 hp rear-drive car drivable from a keyboard or a
thumb, and they are modelled on what the real systems do rather than on
clamping the physics:

- **Speed-sensitive lock.** Full lock at 100 km/h would put the front tyres
  20° past their peak slip angle, so the rack's travel is sized, every step,
  to the cornering the car can actually hold: the kinematic angle for its
  lateral limit (derived from its tyres, less what roll and a tall centre of
  gravity take away) plus the front slip it takes to reach the peak and a
  little to provoke — about 8° at 100 km/h for the 458, 12° at 60. It reads
  the surface under the front wheels, so a soaked road gives less lock.
- **Stability control** applies the yaw moment a real system gets by braking
  single wheels. Its reference is the yaw rate a car with this much
  understeer would produce for the current steer, **capped at what the tyres
  can deliver at this speed**. That cap is the whole point: the kinematic
  yaw rate for full lock at 100 km/h is three times what any tyre can
  produce, and a reference the car cannot reach turns the controller into a
  yaw booster — which is exactly what an earlier version of this game had,
  and why winding on lock at speed threw the rear out. Rotation beyond the
  reference, including the swing back the other way when a slide is caught,
  is damped hard; rotation short of it is left to the driver.
- **Counter-steer assist** adds lock into a slide once the body slip passes
  about 6°, at the rate a real system would, and never beyond the rack's
  mechanical limit.
- **Throttle bleed** past the same slip angle, proportional so it never
  snatches — lifting instantly mid-corner is how a mid-engined car swaps
  ends.
- **Brake-force distribution** eases the rear brakes as the body starts to
  slide, so the rear tyres keep their cornering grip while trail braking.
- **ABS** releases pressure on the tyre's *combined* slip, not its
  longitudinal slip alone: a tyre already leaning on its cornering grip is
  released sooner, because what anti-lock preserves in a corner is the
  steering, not the stopping.
- **Traction control** aims at the peak of the longitudinal curve and lowers
  that target as the rear tyres lean on their lateral peak.

`node tools/manoeuvres.mjs` is the bench these were tuned on: scripted taps,
holds, releases, lift-offs, trail-braking and full-throttle exits on a wide
synthetic oval, printing yaw rate, lateral g, body slip and both axles' slip
angles. With the aids on, a 0.2 s tap at 100 km/h is a 0.4 g nudge, a held
key settles at 1.25 g with 5° of body slip and the fronts just past their
peak, and a release straightens the car with no swing back — for every car
in the roster.

**Suspension** — `src/physics/Vehicle.js`

Each corner raycasts the circuit, resolves a spring/damper strut with separate
bump and rebound rates, adds a progressive bump stop, and couples left to right
through an anti-roll bar. Vertical load from the strut feeds the tyre; the
tyre's forces are applied back at the contact patch.

**Driveline** — `src/physics/Drivetrain.js`

A torque curve, an engine with its own inertia, a friction clutch that slips
under launch and locks up when the driveline catches it, a seven-speed box that
rev-matches on downshifts, and a limited-slip differential with preload and a
speed-sensitive locking term.

Two numerical details matter more than they look:

- The hub-to-road coupling is extremely stiff — an explicit step at any sane
  timestep rings itself apart. Wheel spin is integrated **semi-implicitly**,
  linearised about the tyre's slip stiffness.
- The clutch coupling is stiff for the same reason, worse by the square of the
  gear ratio, so its slope is folded into the same implicit step.

The simulation runs at a fixed 240 Hz, sub-stepped from the render frame.

### Measured behaviour

`npm test` runs seven headless suites — no renderer, so they work in CI:
physics, AI, effects, controls, camera, pacing and handling.

`tests/physics.test.mjs` drives both cars on a synthetic proving ground — 4 km
straights and a 120 m skidpad — and reports:

```
=== Rosso 458 — 1440 kg, 597 hp, RWD ===
  static: ride height 0.370 m · loads 2967/2967/4097/4097 N · 42% front
  0-100 4.27s · 0-200 10.47s · 0-300 25.29s
  top speed 337 km/h in gear 7 @ 7786 rpm
  100-0 km/h in 28.9 m / 2.11 s (peak 1.45 g)
  skidpad peak 1.36 g lateral @ 148 km/h (120 m radius)
```

`tests/ai.test.mjs` sends an AI driver round all five circuits for two laps
and asserts it completes them, stays inside track limits, never gets stuck and
posts consistent times:

```
=== Apex International — 4.42 km ===
  laps 1:43.442  1:42.117
  best 1:42.117 · avg 156 km/h · top 241 km/h
  off-track 0.0 s · stationary 1.1 s
```

`tests/effects.test.mjs` drives the particle system past the end of every
particle's life with deliberately coarse timesteps and asserts nothing
non-finite ever reaches the instance buffers. That is not a cosmetic concern: a
single NaN in the instance colour buffer reaches the HDR render target, bloom
spreads it across the mip chain, and the whole frame renders black — which is
exactly what used to happen the first time the tyres smoked.

`tests/pacing.test.mjs` checks the speed profile behind the arrows — the
hairpin is slow, the back straight is fast, the arrows say brake before the
hairpin and accelerate well before it, and the braking zone lengthens in the
wet. `tests/handling.test.mjs` drives every circuit the way a person on a
keyboard does — full lock, full pedal — with the driver aids on, and asserts
the car never spins and rarely gets sideways; it is the test the aids are
tuned against.

Static corner loads sum to the car's weight at the authored 42% front bias,
top speed and braking distance land where a real 458 does, and lateral grip
climbs with speed as downforce arrives. Standing-start acceleration is about a
second off a real launch-controlled car — the clutch model gives up that time
pulling away, which is the one number here I would still call approximate.

---

## The front end

The start screen is laid out like a race programme: the wordmark and the
vitals on the left, the entry form on the right. Cars are shown as
photographs rendered by the game's own renderer (`tools/car-thumbs.mjs`
drives a headless browser through every car and crops the frame), circuits
as their own outlines drawn from the layout data at runtime, the weather as
a row of chips. Typefaces are Bebas Neue and Barlow Condensed, self-hosted
under the SIL Open Font License; the single-file build takes them from
Google Fonts, the one stylesheet host a sandboxed page may reach.

On a phone the same screen collapses to one column with the start button
pinned to the bottom. Which layout you get is decided by either dimension,
not by width alone: **a phone held sideways is not a narrow screen**. An
iPhone Pro Max is 932 CSS px across in landscape — wider than the 900 px
breakpoint this once used, so it was served the desktop layout, two columns
squeezed onto a 430 px-tall screen with the start button past the right
edge. `tests/layout.test.mjs` now evaluates the breakpoint against the real
viewports of the phones the game is played on, and asserts the wide layout
survives on a laptop.

Card photographs are 16:9 and are never stretched. The rows that hold them
do not stretch a card to the height of the tallest in the row either: the
slack ends up centred by the `<button>`, and reads as a black band above the
picture.

## Sound

The engine is a recording — a V8 loop from the CC0 assets of the pmndrs
racing game — played back at the rate that puts its firing frequency where
the simulated engine's is: rpm and cylinder count set the pitch, so the
flat-six, the straight-six, the V8s and the V10 come out as different
engines. A second copy an octave down puts weight under it at high revs, a
low-pass opens with the throttle so lifting off sounds like lifting off, and
the limiter and gearshifts cut it the way they cut the real thing. Tyre
squeal is a recording too, played by slip; impacts get a recorded crash.
Wind, rain and a storm's rumble are shaped noise, which is what they are.
If the recordings cannot be loaded, a simple synthesised engine stands in.

## The cars

Every car is a downloaded model of a real car, driven by its own physics
specification — mass, weight distribution, centre of gravity, springs,
dampers, anti-roll bars, brakes, tyre size and grip, drag, downforce, engine
torque curve and gearing (`CARS` in `src/physics/Vehicle.js`).

| | Engine | Layout | Model |
|---|---|---|---|
| **Rosso 458** | 4.5 V8, 597 hp | mid-engine, RWD | Ferrari 458 Italia — vicent091036, CC BY 4.0 |
| **Khronos Concept** | 5.2 V10 twin-turbo, 681 hp | AWD | Car Concept — The Khronos Group, CC BY 4.0 |
| **Porsche 911 Carrera 4S** | 3.0 flat-six twin-turbo, 438 hp | rear-engine, AWD | Karol Miklas, CC BY-SA 4.0 |
| **Lamborghini Urus** | 4.0 V8 twin-turbo, 618 hp | AWD, 2.2 t SUV | Steven Grey, CC BY-NC 4.0 (non-commercial) |
| **1972 Datsun 240K GT** | 2.4 straight-six in period race trim, 196 hp | RWD | Karol Miklas, CC BY-SA 4.0 |

They drive differently because they *are* different: the 911 carries its
mass over the back axle, the Urus is tall and soft and leans on its active
anti-roll bars, and the Datsun sits on narrow period tyres with two thirds
of a modern slick's grip and a body that makes lift rather than downforce.
The AI plans each car's cornering budget from its specification.

Models arrive from different artists in different states — centimetre
scales, baked rotations, wheels merged in left/right pairs, or the whole
car in one mesh with a dozen material slots. `scripts/prepare-cars.mjs`
normalises them: it bakes every transform into the vertices, drops geometry
the game replaces (a separate clear-coat shell, ground planes), finds the
four tyres and carves everything inside each wheel's cylinder — tyre, rim,
disc, caliper, hub — out onto its own centred `wheel_fl` … `wheel_rr` node
that the rig can steer and spin, renames materials to the rig's vocabulary,
and simplifies the heaviest to a sensible budget. The measured figures for
all five (0–100, top speed, braking, skidpad) come out of
`tests/physics.test.mjs`.

---

## The AI

Opponents drive the same physics as the player — no rails, no scripted speeds.
Three parts:

- **Steering** is pure pursuit against a point on the racing line, roughly half
  a second of travel ahead, plus counter-steer proportional to the car's own
  slip angle so it catches slides instead of spinning. The pursuit's lateral
  demand is bounded by the grip the driver budgets: geometry alone would ask
  for a degree or two of lock when the line crosses the road at 200 km/h,
  which the tyres do not have. Each driver follows the line pulled slightly
  toward the centre by skill — the full line runs 1.6 m from the edge, closer
  than a driver who tracks it with any error can afford — and plans its speed
  from the curvature of that line, not the centreline's.
- **Speed** comes from the same whole-lap profile that paints the arrows,
  built for the grip this driver is willing to use: the cornering limit, then
  a backward braking pass that respects the friction circle — braking *into* a
  corner leaves far less than the full braking figure — and the grade of the
  road. It reads the profile a third of a second ahead so it brakes before the
  error has grown, which is the difference between trail-braking and arriving
  at the apex sideways. The grip budget is deliberately short of what the car
  can actually produce — a driver who plans to use every last newton arrives
  at the apex with nothing left for corrections. When the fronts pass their
  peak slip angle it unwinds the wheel rather than winding on more.
- **Avoidance** offsets the line when it finds a car alongside, and a recovery
  behaviour backs out of gravel, with a rejoin as a last resort so the field
  always keeps circulating.

`skill` (0…1) scales the grip it will use, how far ahead it looks and how tidy
its inputs are, which gives a grid a natural spread of pace.

---

## The circuit

Circuits are authored the way real ones are described — a run of straights and
constant-radius arcs, each with its own width, banking and elevation change
(`src/track/Layout.js`). A hand-written list never closes the loop exactly, so
a damped least-squares solve nudges the segment lengths and arc angles by the
smallest amount that brings the end of the lap back onto its start, in both
position and heading. Genuine straights and genuine constant-radius corners
survive, which is what makes a circuit learnable.

From that centreline, `Track.js` builds:

- A **racing line**: the minimum-curvature path through the corridor, then
  nudged for lap time. The line's lateral offset is described by control
  points every 15 m; its curvature is linear in those offsets, so minimising
  the summed squared curvature with the track edges as box constraints is a
  quadratic problem, solved by an active-set method (solve unconstrained, pin
  whatever left the road at the edge it crossed, re-solve, release what the
  gradient wants back inside). What falls out is the classic line — wide on
  entry, clipping the apex, wide on exit, straight across the road between
  corners that face the same way. A second, time-boxed pass then tries moving
  each control point near a corner and keeps what the pacing model says is
  quicker round the lap, which is where late apexes onto straights come
  from. The AI, the arrows and the rubber baked into the road all follow it.
- A **uniform spatial hash** so the physics can ask "what is under this point?"
  in constant time. There are no mesh raycasts in the hot loop — surface
  height, normal, banking and material are all answered analytically.

`TrackBuilder.js` turns that into geometry: the road ribbon, kerbs that only
exist where the track bends, run-off, gravel traps on the outside of the quick
corners, Armco with instanced posts, tyre walls, the start gantry, and a
terrain heightfield that matches the road surface exactly near the circuit and
blends into rolling ground further out.

The road carries two extra per-vertex channels the standard material knows
nothing about: `aWear` (rubber laid down on the racing line, which darkens the
surface and polishes it) and `aDust` (the marbles that collect off-line, which
lighten it and kill the gloss). Both are baked at build time and folded in with
a small shader patch, so they cost two varyings at runtime.

Five circuits:

- **Apex International** — 4.4 km, 15 m of elevation change, 11 corners.
- **Costa Brava Sprint** — 2.4 km, faster and more flowing.
- **Silverton Grand Prix** — 3.9 km of wide, fast, modern circuit: long
  straights into big stops and a flat-out sweeper sequence.
- **Col de l'Aigle** — 3.2 km of narrow mountain road: a switchback climb,
  a balcony and a col across the top, then a fast descent with a downhill
  braking zone that punishes trail-braking.
- **Delta Speedbowl** — 3.2 km, two banked ovals joined by an infield.

---

## Weather

Six presets on the start screen: clear, overcast, rain, storm, fog and night.
One captured HDRI serves all six for a circuit — `src/game/Weather.js`
reworks the panorama on the CPU (exposure, desaturation, tint, and flattening
the sun disc toward the sky's mean, which is what an overcast sky is) and
prefilters the result for the lighting, so the single-file build does not
carry six skies. Each preset also sets the sun, the hemisphere light, the fog,
the wind in the trees, the ambient temperature the tyres cool toward, and how
wet the track is.

Rain is a field of streaks that lives around the camera: a few thousand quads
with fixed offsets in a box, wrapped around the camera and slid down it in the
vertex shader, so it costs one draw call and no per-frame CPU. Wet tarmac is
darker, the whole surface goes glossy, and the low spots of the roughness map
— where water stands — become mirrors. Tyres throw spray instead of smoke and
leave far less rubber, headlights come on, and the engine audio gains a rain
bed and a storm rumble. Cars shower sparks when they hit the barriers.

**Rain on the lens** — `src/render/RainDrops.js`. Drops bead up on the glass,
sit there refracting the finished frame through themselves — the road and
the trees, upside down and squeezed, which is what makes them read as water
— and every so often one gathers enough to run, leaving a trail of beads
down the screen. It is all procedural in the fragment shader: a grid of
cells for the beads that sit, a set of columns for the ones that run, a
handful of hashes per pixel and no state. The glass fills over a few seconds
when the rain starts and clears when it stops, faster with the car moving,
and at speed fewer drops sit still. With a post chain it is one effect
among the others, before tone mapping; on the phone preset, which has no
chain, the scene is rendered to a texture only while it rains and the drops
are drawn over it in a second pass.

**Rain on the road** — `src/render/Splashes.js`. Each drop that lands throws
up a small crown and leaves a ring spreading over the wet surface for a
third of a second: a pool of instanced quads scattered on the tarmac ahead
of the camera, respawned wherever the track says there is road as they die.
The CPU places them; the shaders animate them.

---

## Rendering

three.js on WebGL2, with a post chain built on `postprocessing`:

- Image-based lighting from a real captured HDRI, prefiltered through PMREM.
- Cascaded shadow maps, so the shadow under the car stays sharp while the
  treeline several hundred metres away still casts.
- Ground-truth ambient occlusion (N8AO), bloom, a speed-driven radial blur,
  chromatic aberration, vignette, film grain, and **AgX tone mapping** — which
  holds highlights together far better than Reinhard on a scene lit by a real
  HDRI.
- Car paint is a metallic base coat under a near-perfect clear coat, with a
  fine flake normal map that only affects the base layer.

Four quality presets are selectable at launch and guessed from the device on
first load; a coarse pointer (a finger) selects the mobile preset.

### Asset pipeline

Every third-party asset is pinned to a specific upstream commit in
`scripts/sources.mjs`. `npm run assets` runs the whole pipeline — fetch,
author the surface maps, convert textures to WebP, Draco-compress the models
and re-encode their textures — and the committed files are its output, so a
fresh clone needs none of it. Credits are regenerated from the manifest into
`public/assets/CREDITS.md`, so they cannot drift.

The optimiser deliberately does not deduplicate materials and keeps empty leaf
nodes: the car rig classifies parts by material *name* and hangs wheels off
transform-only group nodes, and either pass would silently break that.

There is no CC0 asphalt scan reachable from the mirrors this pins against, so
the track surfaces are authored instead by `scripts/gen-textures.mjs`: a height
field built from wrapped Worley cells (the aggregate) plus fBm grain (the
binder), resolved into base colour, roughness and a Sobel-differentiated normal
map. Everything is periodic, so it tiles without a seam. Kerbs, concrete, the
smoke puff, the tyre-mark ribbon and the paint flake normal come from the same
script.

---

## Layout

```
src/
  core/       loaders, input, procedural engine audio, math
  physics/    tyre model, drivetrain, 6-DOF chassis + suspension
  track/      circuit authoring, runtime track model, geometry, scenery
  render/     renderer + post chain, materials, car rig, particles
  game/       session orchestration, AI drivers, camera, lap timing
  ui/         HUD and menus
scripts/      pinned asset manifest, fetcher, texture authoring, compression
tests/        physics, AI, effects, controls, camera, pacing and handling harnesses
tools/        browser screenshot / emulated-phone checks, racing-line maps
```

## Credits

Every model, HDRI and photographic texture here was downloaded from a public
repository — none of it is generated geometry. See
[`public/assets/CREDITS.md`](public/assets/CREDITS.md) for the full list.

- **Ferrari 458 Italia** — vicent091036, via the three.js examples (CC BY 4.0)
- **Car Concept** — The Khronos Group (CC BY 4.0)
- **Porsche 911 Carrera 4S** and **1972 Datsun 240K GT** — Karol Miklas, via
  pmndrs/examples (CC BY-SA 4.0)
- **Lamborghini Urus** — Steven Grey, via pmndrs/examples (CC BY-NC 4.0 —
  non-commercial use only; remove `urus` from the manifest for a commercial
  build)
- **Village Pack** trees, bushes and rocks — Babylon.js Assets (CC BY 4.0)
- **Engine, tyre and crash recordings** — pmndrs/racing-game (CC0)
- **Bebas Neue** (Dharma Type) and **Barlow Condensed** (Jeremy Tribby) —
  SIL Open Font License 1.1
- **HDRI environments** — Poly Haven (CC0), mirrored by three.js
- **Grass and rocky-ground PBR maps** — Babylon.js Assets (CC BY 4.0)

Built with [three.js](https://threejs.org),
[postprocessing](https://github.com/pmndrs/postprocessing) and
[N8AO](https://github.com/N8python/n8ao).
