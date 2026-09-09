# APEX

A physically-based 3D racing simulator that runs in the browser.

Real downloaded supercar models, captured HDRI lighting, a Pacejka tyre model
with load sensitivity and thermal behaviour, raycast suspension with anti-roll
bars, a limited-slip differential, and aerodynamics that actually change how
the car behaves at 300 km/h.

**Play it now:** https://waldnerc34-dotcom.github.io/wer/ — works on a phone
(turn it sideways), a tablet or a desktop browser. Every push to this branch
redeploys it through `.github/workflows/pages.yml`.

```bash
npm install
npm run dev          # http://localhost:5173
```

Assets are committed, so there is nothing else to fetch. `npm run build`
produces a static `dist/` you can host anywhere.

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
pedals, left stick to steer, bumpers to shift).

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

`npm test` runs three headless suites — no renderer, so they work in CI.

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

`tests/ai.test.mjs` sends an AI driver round both circuits for two laps and
asserts it completes them, stays inside track limits, never gets stuck and
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

Static corner loads sum to the car's weight at the authored 42% front bias,
top speed and braking distance land where a real 458 does, and lateral grip
climbs with speed as downforce arrives. Standing-start acceleration is about a
second off a real launch-controlled car — the clutch model gives up that time
pulling away, which is the one number here I would still call approximate.

---

## The AI

Opponents drive the same physics as the player — no rails, no scripted speeds.
Three parts:

- **Steering** is pure pursuit against a point on the racing line, roughly half
  a second of travel ahead, plus counter-steer proportional to the car's own
  slip angle so it catches slides instead of spinning.
- **Speed** comes from scanning the racing line's curvature as far ahead as the
  car could brake from its current speed, taking the lowest limit it finds and
  working backwards. The grip budget it plans against is deliberately short of
  what the car can actually produce — a driver who plans to use every last
  newton arrives at the apex with nothing left for corrections.
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

- A **racing line**, by constrained Laplacian relaxation inside the track
  corridor. Repeatedly pulling each point toward the midpoint of its neighbours
  straightens the path; clamping to the usable width keeps it on the road. What
  falls out approximates the minimum-curvature line, and both the AI and the
  rubbered-in visual line follow it.
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

**Apex International** — 4.4 km, 15 m of elevation change, 11 corners.
**Costa Brava Sprint** — 2.4 km, faster and more flowing.

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
tests/        physics, AI and effects validation harnesses
tools/        browser screenshot / emulated-phone checks
```

## Credits

Every model, HDRI and photographic texture here was downloaded from a public
repository — none of it is generated geometry. See
[`public/assets/CREDITS.md`](public/assets/CREDITS.md) for the full list.

- **Ferrari 458 Italia** — vicent091036, via the three.js examples (CC BY 4.0)
- **Car Concept** — The Khronos Group (CC BY 4.0)
- **Village Pack** trees, bushes and rocks — Babylon.js Assets (CC BY 4.0)
- **HDRI environments** — Poly Haven (CC0), mirrored by three.js
- **Grass and rocky-ground PBR maps** — Babylon.js Assets (CC BY 4.0)

Built with [three.js](https://threejs.org),
[postprocessing](https://github.com/pmndrs/postprocessing) and
[N8AO](https://github.com/N8python/n8ao).
