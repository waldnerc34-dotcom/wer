import * as THREE from 'three';

import { Assets } from '../core/Assets.js';
import { EngineAudio } from '../core/Audio.js';
import { Input } from '../core/Input.js';
import { clamp, damp, wrapDelta } from '../core/MathUtils.js';
import { CarRig } from '../render/CarRig.js';
import { TyreEffects } from '../render/Effects.js';
import { RemoteCar } from '../net/Remote.js';
import { Materials } from '../render/Materials.js';
import { RacingLineMesh } from '../render/RacingLine.js';
import { RainSystem } from '../render/Rain.js';
import { SplashSystem } from '../render/Splashes.js';
import { QUALITY, Renderer } from '../render/Renderer.js';
import { CIRCUITS } from '../track/Layout.js';
import { DrivingAssist } from './Assist.js';
import { Pacing } from '../track/Pacing.js';
import { SURFACE } from '../track/Track.js';
import { Scenery } from '../track/Scenery.js';
import { Props } from '../track/Props.js';
import { Ocean } from '../track/Ocean.js';
import { Track } from '../track/Track.js';
import { buildTrack } from '../track/TrackBuilder.js';
import { CARS, Vehicle } from '../physics/Vehicle.js';
import { Driver, FieldPace, makeField } from './AI.js';
import { ChaseCamera } from './Camera.js';
import { LapTimer } from './Timing.js';
import { RaceControl } from './RaceControl.js';
import { Weather } from './Weather.js';

/**
 * How far away a rival still throws a visible wake, and how many of them
 * do at once. Beyond this the spray is a smear in the fog anyway, and the
 * particle pool is better spent on the cars you are actually racing.
 */
const WAKE_RANGE = 85;
const WAKE_CARS = 3;

const PAINTS = [0x9d0208, 0x0b3d91, 0xf2f2f0, 0x111214, 0xd6a419, 0x1f6f4a, 0x6d28d9, 0xc2410c];

/** The cars this build can actually load: the single-file build embeds a subset. */
export function availableCars() {
  const cars = CARS.filter((c) => Assets.available(c.model));
  return cars.length ? cars : [CARS[0]];
}

/**
 * The session: one circuit, one player car, and a field of AI.
 *
 * Owns the fixed ordering of a frame — input, AI, physics, effects, camera,
 * render — and everything that has to be torn down when the player changes
 * car or track.
 */
export class Game {
  constructor(canvas, { quality = 'high', onProgress, onReady, onState, onContextLost } = {}) {
    this.canvas = canvas;
    this.onProgress = onProgress;
    this.onReady = onReady;
    this.onState = onState;

    this.renderer = new Renderer(canvas, quality);
    this.renderer.onContextLost = () => onContextLost?.();
    this.assets = new Assets(this.renderer.renderer);
    this.input = new Input();
    this.audio = new EngineAudio();
    this.materials = new Materials();
    this.weather = new Weather(this);

    // The pacing arrows are on by default: they are how a new driver learns
    // where to brake. Remembered between sessions.
    this.showRacingLine = readPref('apex.racingLine', true);

    this.opponents = [];
    this.wakeRank = [];
    this.paused = false;
    this.running = false;
    this.mode = 'time-trial';
    this.headlightsOn = false;
    this.frameTimes = [];
    this.fps = 0;
    this.simTime = 0;

    this.assets.onProgress = (p) => this.onProgress?.(p);
    this._onResize = () => this.renderer.resize();
    window.addEventListener('resize', this._onResize);
  }

  /* ----------------------------------------------------------------- setup */

  /**
   * Builds a session. Safe to call again to switch car, circuit or mode.
   */
  async load({
    circuitId = 'apex',
    carId = 'rosso',
    mode = 'time-trial',
    opponents = 5,
    laps = 5,
    weather = 'clear',
    assist = 'high',
    // Multiplayer. `net` is the room; `remotes` are the other people in it,
    // each carrying the grid slot every machine independently agreed on;
    // `slot` is ours.
    net = null,
    remotes = [],
    slot = 0,
  } = {}) {
    this.net = net;
    this.mySlot = slot;
    this.assist = new DrivingAssist(assist);
    // A race is a set distance from a standing start; a time trial is neither.
    this.race = new RaceControl({
      laps: mode === 'race' ? laps : 0,
      standing: mode === 'race',
    });
    this.running = false;
    this.#teardown();

    this.mode = mode;
    const circuit = CIRCUITS.find((c) => c.id === circuitId) ?? CIRCUITS[0];
    const roster = availableCars();
    const carDef = roster.find((c) => c.id === carId) ?? roster[0];
    this.circuit = circuit;
    this.carDef = carDef;

    this.onProgress?.(0.02, 'Surveying the circuit');
    this.track = new Track(circuit);
    // The ideal speed profile for this car on this lap: drives the arrows.
    this.pacing = new Pacing(this.track, pacingCar(carDef.spec));
    // The same profile is the ruler the field measures everybody against, so
    // that "as fast as the player" means one thing on every circuit.
    this.field = new FieldPace(this.pacing);

    this.onProgress?.(0.08, 'Loading materials');
    await this.materials.load(this.assets);

    this.onProgress?.(0.24, 'Reading the sky');
    // Fetched here so the progress bar is honest; the weather dresses it.
    await this.assets.environment(circuit.hdri);

    this.onProgress?.(0.38, 'Laying the tarmac');
    const built = buildTrack(this.track, this.materials);
    this.trackGroup = built.group;
    this.startLights = built.startLights;
    this.startLights?.set(0);
    this.renderer.scene.add(this.trackGroup);

    this.racingLine = new RacingLineMesh(this.track, this.pacing, { spacing: 5 });
    this.racingLine.visible = this.showRacingLine;
    this.renderer.scene.add(this.racingLine.mesh);

    this.onProgress?.(0.52, 'Planting the trees');
    this.scenery = new Scenery(this.track, {
      density: this.renderer.settings.sceneryDensity,
    });
    await this.scenery.build(this.assets);
    this.renderer.scene.add(this.scenery.group);

    // `?props=0` leaves the circuit bare, which is how the cost of dressing
    // it was measured in the first place.
    if (new URLSearchParams(location.search).get('props') !== '0') {
      this.onProgress?.(0.60, 'Building the paddock');
      this.props = new Props(this.track, { density: this.renderer.settings.sceneryDensity });
      await this.props.build(this.assets);
      this.renderer.scene.add(this.props.group);
    }

    if (circuit.sea) {
      // Waves cost fill rate over the largest area on screen, so they are a
      // property of the preset rather than of the circuit.
      const waves = (this.renderer.settings.sceneryDensity ?? 1) >= 0.7;
      this.ocean = new Ocean({ ...circuit.sea, waves });
      if (waves) this.ocean.setNormals(await this.assets.texture('textures/water_normals.webp'));
      this.renderer.scene.add(this.ocean.mesh);
    }

    this.onProgress?.(0.72, 'Warming the cars');
    await this.#spawnCars(carDef, mode === 'race' ? opponents : 0, remotes);
    await this.audio.load(this.assets);

    this.onProgress?.(0.86, 'Setting the weather');
    const settings = this.renderer.settings;
    const small = (settings.particles ?? 700) <= 300;
    this.rain = new RainSystem({ count: settings.rainCount ?? (small ? 1500 : 3600) });
    this.renderer.scene.add(this.rain.mesh);
    this.splashes = new SplashSystem({ count: settings.splashCount ?? (small ? 240 : 480) });
    this.renderer.scene.add(this.splashes.mesh);
    await this.weather.apply(weather);

    this.onProgress?.(0.94, 'Final checks');
    this.effects = new TyreEffects(this.renderer.scene, this.materials, {
      particles: this.renderer.settings.particles ?? 700,
      skidSegments: this.renderer.settings.skidSegments ?? 900,
    });
    // The weather was set before there was anything to tell.
    this.effects.light = 0.35 + 0.65 * (this.weather.current?.sky.exposure ?? 1);
    this.camera = new ChaseCamera(this.renderer.camera, this.track);
    this.camera.reset(this.player);
    this.timer = new LapTimer(this.track);

    // Prime the shader cache so the first corner does not stutter.
    this.renderer.renderer.compile(this.renderer.scene, this.renderer.camera);

    this.renderer.resize();
    this.running = true;
    this.clock = new FrameClock();
    this.onProgress?.(1, 'Ready');
    this.onReady?.();
  }

  /**
   * @param {object} carDef the player's car
   * @param {number} opponentCount how many cars to put on the grid in total
   * @param {object[]} remotes the people in the room, if this is a race
   *                           between people; each carries its grid slot
   */
  async #spawnCars(carDef, opponentCount, remotes = []) {
    // Player.
    const playerModel = await this.assets.instance(carDef.model);
    this.player = new Vehicle(carDef.spec, this.track);
    this.player.assists.autoReverse = true;
    this.playerRig = new CarRig(playerModel, carDef.spec, this.materials, {
      paint: carDef.paint,
      isPlayer: true,
    });
    this.renderer.scene.add(this.playerRig.group);

    const grid = this.track.gridSlot(this.mySlot);
    this.player.reset(grid.position, grid.heading);
    this.playerRig.update(this.player, 0.016);

    const roster = availableCars();

    // The people, first, in the slots the room agreed on. A car driven from
    // another machine gets the same rig and the same physics body as any
    // other — only the thing that decides where it goes is different.
    for (const person of remotes) {
      const def = roster.find((c) => c.id === person.carId) ?? roster[0];
      const vehicle = new Vehicle(def.spec, this.track);
      // Nothing local ever pushes it: the machine it belongs to has the only
      // say, and a shove applied here would be overwritten by the next
      // snapshot anyway. The collision solver reads this and gives the whole
      // of the contact to the car that is actually simulated here.
      vehicle.kinematic = true;
      const rig = new CarRig(await this.assets.instance(def.model), def.spec, this.materials, {
        paint: PAINTS[(person.slot + 1) % PAINTS.length],
      });
      this.renderer.scene.add(rig.group);
      const place = this.track.gridSlot(person.slot);
      vehicle.reset(place.position, place.heading);
      rig.update(vehicle, 0.016);
      this.opponents.push({
        vehicle,
        rig,
        remote: new RemoteCar(vehicle, person),
        timer: new LapTimer(this.track),
        name: person.name,
      });
    }

    // Then computed drivers, to fill whatever is left of the grid.
    const aiCount = Math.max(0, opponentCount - remotes.length);
    const field = makeField(aiCount);
    const mine = Math.max(0, roster.indexOf(carDef));
    for (let i = 0; i < aiCount; i++) {
      // Everyone else in the field, in turn, then the player's own model.
      const def = roster[(mine + 1 + i) % roster.length];
      const model = await this.assets.instance(def.model);
      const vehicle = new Vehicle(def.spec, this.track);
      const rig = new CarRig(model, def.spec, this.materials, {
        paint: PAINTS[(i + 1) % PAINTS.length],
      });
      this.renderer.scene.add(rig.group);

      const place = this.track.gridSlot(remotes.length + i + 1);
      vehicle.reset(place.position, place.heading);
      // A computed driver keeps the full rack and catches its own slides.
      vehicle.assists.stability = false;
      vehicle.assists.steerLimiter = false;

      const driver = new Driver(vehicle, this.track, {
        skill: field[i].skill,
        aggression: field[i].aggression,
        name: field[i].name,
        pace: this.field,
      });
      const timer = new LapTimer(this.track);
      rig.update(vehicle, 0.016);
      this.opponents.push({ vehicle, rig, driver, timer, name: field[i].name });
    }
  }

  #teardown() {
    if (this.trackGroup) {
      this.renderer.scene.remove(this.trackGroup);
      disposeTree(this.trackGroup);
      this.trackGroup = null;
    }
    if (this.scenery) {
      this.renderer.scene.remove(this.scenery.group);
      this.scenery = null;
    }
    if (this.props) {
      this.renderer.scene.remove(this.props.group);
      disposeTree(this.props.group);
      this.props = null;
    }
    if (this.ocean) {
      this.renderer.scene.remove(this.ocean.mesh);
      this.ocean.dispose();
      this.ocean = null;
    }
    if (this.playerRig) {
      this.renderer.scene.remove(this.playerRig.group);
      this.playerRig.dispose();
      this.playerRig = null;
    }
    for (const o of this.opponents) {
      this.renderer.scene.remove(o.rig.group);
      o.rig.dispose();
    }
    this.opponents = [];
    if (this.effects) {
      for (const m of this.effects.meshes) this.renderer.scene.remove(m);
      this.effects = null;
    }
    if (this.racingLine) {
      this.renderer.scene.remove(this.racingLine.mesh);
      this.racingLine.mesh.geometry.dispose();
      this.racingLine = null;
    }
    if (this.rain) {
      this.renderer.scene.remove(this.rain.mesh);
      this.rain.mesh.geometry.dispose();
      this.rain = null;
    }
    if (this.splashes) {
      this.renderer.scene.remove(this.splashes.mesh);
      this.splashes.dispose();
      this.splashes = null;
    }
    this.renderer.setRainOnLens(0);
  }

  /* ------------------------------------------------------------------ loop */

  start() {
    if (this._raf) return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this.frame();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  frame() {
    if (!this.running) return;
    const raw = this.clock.getDelta();
    // Clamp so an alt-tab does not launch the car into orbit.
    const dt = Math.min(raw, 0.05);

    this.#trackFps(raw);

    try {
      if (!this.paused && dt > 0) {
        this.#step(dt);
        this.simTime += dt;
      }
      this.renderer.render(dt);
    } catch (error) {
      this.#fault(error);
      return;
    }
    this.input.endFrame();
  }

  /**
   * What to do when a frame throws.
   *
   * The next animation frame is requested *before* the current one runs, so
   * an exception in here does not stop the loop — it just skips the render.
   * The result is a black canvas with a HUD frozen at its opening values and
   * nothing on screen to say why, which is the single worst way for a bug to
   * present itself: it looks exactly like a graphics driver problem, and it
   * sends you looking at the GPU for hours. (It did.)
   *
   * So a throw is now loud. One is logged. Three in a row and the session
   * stops and says so, out loud, with the message.
   */
  #fault(error) {
    this.faults = (this.faults ?? 0) + 1;
    if (this.faults === 1) console.error('APEX: the simulation threw —', error);
    if (this.faults < 3) return;
    this.stop();
    this.running = false;
    this.onFault?.(error);
  }

  #step(dt) {
    const player = this.player;

    /* -- the starter ------------------------------------------------------ */
    if (this.raceStart !== undefined && this.net) {
      // Everyone's lights go out together, off the host's clock rather than
      // off however long each machine has happened to be running.
      this.race.syncTo((this.net.room.now() - this.raceStart) / 1000, this.raceHold);
    } else {
      this.race.update(dt);
    }
    this.startLights?.set(this.race.lamps);

    /* -- input ------------------------------------------------------------ */
    const controls = this.input.update(dt, player.speedKph);
    this.#handleActions();

    // On the grid the brakes are on and the wheel is straight, but the engine
    // is the player's: holding the throttle against the lights is how a
    // standing start is done, and hearing it is half of what makes the wait
    // worth having.
    if (this.race.holding) {
      controls.brake = 1;
      controls.handbrake = 1;
      controls.steer = 0;
    } else {
      this.race.noteLaunch(controls.throttle > 0.15);
    }
    if (this.race.finished) {
      // Flag out: the driver is a passenger from here.
      controls.throttle = 0;
      controls.brake = Math.max(controls.brake, 0.35);
    }

    // Braking help reads the same speed profile the arrows are drawn from,
    // a moment ahead of where the car is. Last frame's position is a metre
    // or so stale at racing speed, which is nothing next to the second of
    // road it looks down.
    this.assist?.apply(controls, {
      speed: player.speed,
      s: this.playerQuery?.s ?? 0,
      pacing: this.pacing,
    });

    /* -- simulate --------------------------------------------------------- */
    player.update(dt, controls);
    if (this.race.holding) this.#pin(player);

    // How quick the player is, measured rather than assumed. Last frame's
    // query is a few centimetres stale, which is nothing over the five
    // seconds of driving one measurement is made of.
    this.field?.observe(dt, {
      speed: player.speed,
      s: this.playerQuery?.s ?? 0,
      offTrack: this.playerOffTrack ?? false,
    });

    // The player is a rival like any other, and flagged as *the* rival so the
    // field knows whose gearbox it is racing for.
    const all = [{ vehicle: player, q: this.playerQuery, isPlayer: true }, ...this.opponents];
    const netNow = this.net?.room.now() ?? 0;
    for (const o of this.opponents) {
      if (o.remote) {
        // Somebody else's car. Its position is not computed here, it is
        // reported — all this does is draw it at the moment the interpolator
        // says, and read the ground under its wheels.
        o.remote.update(dt, netNow);
        o.rig.group.visible = o.remote.visible;
        o.rig.update(o.vehicle, dt);
        o.q = this.track.query(o.vehicle.position.x, o.vehicle.position.z, o.q ?? {});
        continue;
      }
      const c = o.driver.update(dt, all);
      if (this.race.holding) {
        c.throttle = 0;
        c.brake = 1;
        c.handbrake = 1;
        c.steer = 0;
      } else if (this.race.finished) {
        c.throttle = 0;
        c.brake = Math.max(c.brake, 0.3);
      }
      o.vehicle.update(dt, c);
      if (this.race.holding) this.#pin(o.vehicle);
      o.rig.update(o.vehicle, dt);
      o.q = this.track.query(o.vehicle.position.x, o.vehicle.position.z, o.q ?? {});
      o.timer.update(dt, o.q.s, false);
    }

    this.#resolveCarCollisions();

    /* -- timing ----------------------------------------------------------- */
    const q = this.track.query(player.position.x, player.position.z, {});
    this.playerQuery = q;
    // The racing definition: all four wheels beyond the kerb.
    const offTrack = player.wheels.every((w) => w.surface > SURFACE.KERB);
    this.playerOffTrack = offTrack;
    this.timer.update(dt, q.s, offTrack);

    this.#slipstream(q);
    this.#checkFlag(q);

    // Twenty times a second, whatever the frame rate: the far end interpolates
    // between snapshots and gains nothing from more of them.
    this.net?.send(dt, player);
    this.#watchLaps();

    /* -- visuals ---------------------------------------------------------- */
    this.playerRig.update(player, dt);
    // Rivals emit into the same pool, so they go in before the player's own
    // update integrates and draws it.
    this.#rivalWakes(dt);
    this.effects.update(player, dt, this.renderer.camera);
    this.scenery?.update(dt);

    const impact = player.lastImpact ? clamp(player.lastImpact / 14, 0, 1) : 0;
    if (player.lastImpact) {
      this.audio.impact(impact);
      this.effects.impact(player, impact);
      player.lastImpact = 0;
    }
    this.renderer.setSkyboxCentre(player.position);
    this.camera.update(player, dt, impact);
    this.rain?.update(dt, this.renderer.camera);
    this.ocean?.update(dt, this.renderer.camera);
    if (this.materials) this.materials.rippleTime.value += dt;
    this.splashes?.update(dt, this.renderer.camera, this.track);
    this.renderer.setSpeedBlur(player.speedKph);
    this.renderer.setRainFlow(player.speedKph);

    this.audio.update(player, dt);

    this.onState?.(this.state());
  }

  /**
   * Spray and thrown dirt from the cars around you.
   *
   * Only the player's car carries the full effects rig — rubber, tyre smoke,
   * sparks. Rivals get the wake alone, and only the nearest few, fading out
   * with distance so a pack up the road cannot spend the particle pool that
   * the car alongside you needs. Without this a wet race has a wall of spray
   * behind your own car and nothing at all behind the one you are chasing.
   */
  /**
   * Notices when a lap is completed, and tells the room about it.
   *
   * The timer has no callback of its own and nothing else needs one, so this
   * simply watches the lap counter go up. A lap that was thrown away — four
   * wheels off, a cut corner — is still announced, because the standings care
   * how far round somebody is even when the time does not count.
   */
  #watchLaps() {
    const lap = this.timer.lap;
    if (lap === this.seenLap) return;
    const previous = this.seenLap ?? 0;
    this.seenLap = lap;
    if (lap <= previous || !this.timer.lastLap) return;

    const best = this.timer.bestLap !== null && this.timer.lastLap <= this.timer.bestLap;
    this.onLapDone?.({
      n: lap,
      time: this.timer.lastLap,
      sectors: this.timer.lastSectors,
      valid: !this.timer.invalid,
      best,
    });
    this.net?.reportLap({ n: lap, time: this.timer.lastLap, best });
  }

  #rivalWakes(dt) {
    if (!this.opponents.length) return;
    const eye = this.renderer.camera.position;
    const rank = this.wakeRank;
    let n = 0;
    for (const o of this.opponents) {
      const d = o.vehicle.position.distanceTo(eye);
      if (d >= WAKE_RANGE) continue;
      const entry = (rank[n] ??= { vehicle: null, d: 0 });
      entry.vehicle = o.vehicle;
      entry.d = d;
      n++;
    }
    // Nearest first. An insertion sort over a handful of cars, in place, so
    // this costs nothing and allocates nothing after the first lap.
    for (let i = 1; i < n; i++) {
      const entry = rank[i];
      let j = i - 1;
      while (j >= 0 && rank[j].d > entry.d) {
        rank[j + 1] = rank[j];
        j--;
      }
      rank[j + 1] = entry;
    }
    for (let i = 0; i < n && i < WAKE_CARS; i++) {
      const gain = clamp(1 - (rank[i].d - 15) / (WAKE_RANGE - 15), 0.12, 1) ** 1.5;
      this.effects.wake(rank[i].vehicle, dt, gain);
    }
  }

  /**
   * Slipstream: a car tucked in behind another sits in its wake and pays less
   * drag — and, with the clean air gone, loses some of its downforce too.
   * That is what makes the tow worth having on the straight and a liability
   * into the braking zone.
   */
  #slipstream(playerQ) {
    const cars = [{ vehicle: this.player, q: playerQ }, ...this.opponents];
    for (const a of cars) {
      let scale = 1;
      if (a.q) {
        for (const b of cars) {
          if (a === b || !b.q) continue;
          const gap = wrapDelta(b.q.s, a.q.s, this.track.length);
          if (gap < 3 || gap > 34) continue;
          const across = Math.abs(b.q.lateral - a.q.lateral);
          if (across > 3.2) continue;
          const tuck = (1 - clamp((gap - 8) / 26, 0, 1)) * (1 - clamp((across - 1.4) / 1.8, 0, 1));
          scale = Math.min(scale, 1 - 0.3 * tuck);
        }
      }
      a.vehicle.dragScale = scale;
    }
  }

  /** Shows or hides the pacing arrows on the road. */
  /** @param {'high'|'medium'|'low'|'off'} level */
  setAssist(level) {
    this.assist?.setLevel(level);
  }

  setRacingLine(on) {
    this.showRacingLine = Boolean(on);
    if (this.racingLine) this.racingLine.visible = this.showRacingLine;
    writePref('apex.racingLine', this.showRacingLine);
  }

  /** Switches weather mid-session. */
  async setWeather(id) {
    return this.weather.apply(id);
  }

  /** Attaches on-screen controls (phones and tablets). */
  setTouch(touch) {
    this.touch = touch;
    this.input.setTouch(touch);
  }

  #handleActions() {
    const input = this.input;
    const pad = input.padButtons;

    if (input.tapped('camera') || pad?.camera) this.camera.cycle();
    if (input.tapped('reset') || pad?.reset) this.respawn();
    if (input.tapped('shiftUp') || pad?.shiftUp) {
      this.player.assists.autoShift = false;
      this.player.drivetrain.shiftUp();
    }
    if (input.tapped('shiftDown') || pad?.shiftDown) {
      this.player.assists.autoShift = false;
      this.player.drivetrain.shiftDown();
    }
    if (input.tapped('headlights')) {
      this.headlightsOn = !this.headlightsOn;
      this.playerRig.setHeadlights(this.headlightsOn);
    }
    this.camera.lookBack = input.held('look') || Boolean(this.touchLookBack);
  }

  /**
   * Cars push each other apart rather than passing through.
   *
   * A full convex collision solve is overkill here: treating each car as a
   * capsule and resolving the overlap along the line between centres gives
   * contact that feels right at racing speeds without destabilising the
   * suspension solver.
   */
  #resolveCarCollisions() {
    const cars = [this.player, ...this.opponents.map((o) => o.vehicle)];
    const RADIUS = 1.35;
    const d = new THREE.Vector3();

    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        d.subVectors(b.position, a.position);
        d.y *= 0.5;
        const dist = d.length();
        const overlap = RADIUS * 2 - dist;
        if (overlap <= 0 || dist < 1e-4) continue;

        d.divideScalar(dist);

        // A car driven from another machine cannot be pushed from this one:
        // whatever we did to it would be undone by its next snapshot, and
        // meanwhile the car that *is* simulated here would only have received
        // half of the contact. So the whole of it goes to the local car, and
        // the other driver's machine does exactly the same for theirs. Both
        // people feel the hit, and neither is shoved by a machine that does
        // not own their car.
        const aFree = !a.kinematic;
        const bFree = !b.kinematic;
        if (!aFree && !bFree) continue;
        const share = aFree && bFree ? 0.5 : 1;
        const push = overlap * share;
        if (aFree) a.position.addScaledVector(d, -push);
        if (bFree) b.position.addScaledVector(d, push);

        // Exchange the closing velocity, with a lot of it lost to the panels.
        const closing = b.velocity.clone().sub(a.velocity).dot(d);
        if (closing < 0) {
          const impulse = -closing * 0.45 * (share === 1 ? 2 : 1);
          if (aFree) {
            a.velocity.addScaledVector(d, -impulse);
            a.angularVelocity.multiplyScalar(0.9);
          }
          if (bFree) {
            b.velocity.addScaledVector(d, impulse);
            b.angularVelocity.multiplyScalar(0.9);
          }
          if (a === this.player || b === this.player) {
            this.audio.impact(clamp(-closing / 18, 0, 1));
            this.camera.shake = Math.max(this.camera.shake, clamp(-closing / 20, 0, 1));
          }
        }
      }
    }
  }

  #trackFps(dt) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((s, v) => s + v, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? 1 / avg : 0;
  }

  /* --------------------------------------------------------------- actions */

  respawn() {
    this.player.respawn();
    this.effects?.clear();
    this.camera.reset(this.player);
    this.timer.invalid = true;
  }

  restart() {
    const grid = this.track.gridSlot(0);
    this.player.reset(grid.position, grid.heading);
    this.timer.reset();
    this.effects?.clear();
    this.camera.reset(this.player);
    this.simTime = 0;
    for (const [i, o] of this.opponents.entries()) {
      const slot = this.track.gridSlot(i + 1);
      o.vehicle.reset(slot.position, slot.heading);
      o.timer.reset();
    }
  }

  setPaused(p) {
    this.paused = p;
    if (!p) this.clock.getDelta(); // discard the paused interval
  }

  setQuality(name) {
    // A quality change rebuilds the GPU-side pipeline, so the caller reloads.
    this.pendingQuality = name;
  }

  /** Snapshot for the HUD. */
  state() {
    const p = this.player;
    const dt = p.drivetrain;
    const t = this.timer;

    return {
      speedKph: p.speedKph,
      rpm: dt.rpm,
      limiterRpm: dt.spec.limiterRpm,
      gear: dt.gear,
      throttle: p.controls.throttle,
      brake: p.controls.brake,
      steer: p.steerAngle / (p.steerLock || p.spec.maxSteerAngle),
      gLong: p.telemetry.gForceLong,
      gLat: p.telemetry.gForceLat,
      lap: t.lap,
      lapTime: t.currentLapTime,
      lastLap: t.lastLap,
      bestLap: t.bestLap,
      delta: t.delta,
      sector: t.sector,
      sectors: t.lastSectors,
      bestSectors: t.bestSectors,
      invalid: t.invalid,
      corner: this.track.cornerAt(this.playerQuery?.s ?? 0),
      offTrack: p.telemetry.wheelsOnTrack < 3,
      tyres: p.wheels.map((w) => ({
        temp: w.tyre.temp,
        wear: w.tyre.wear,
        load: w.load,
        slip: w.tyre.gripUsed,
        lockup: w.lockup,
        spin: w.spinning,
        surface: w.surface,
      })),
      fps: this.fps,
      // What is actually being drawn, which is not the size of the window:
      // Ultra renders above it, and dynamic resolution moves it.
      render: this.renderer.drawingBufferSize,
      position: this.#racePosition(),
      opponents: this.opponents.length,
      camera: this.camera.mode,
      assists: p.assists,
      headlights: this.headlightsOn,
      damage: p.damage,
      progress: this.playerQuery ? this.playerQuery.s / this.track.length : 0,
      trackName: this.circuit.name,
      carName: this.carDef.name,
      weather: this.weather.current?.label ?? 'Clear',
      wet: this.track.wetness,
      racingLine: this.showRacingLine,
      assist: this.assist?.level ?? 'off',
      assistBraking: this.assist?.braking ?? 0,
      pace: this.pacing.phaseAt(this.playerQuery?.s ?? 0),
      paceSpeedKph: this.pacing.speedAt(this.playerQuery?.s ?? 0) * 3.6,
      raceLaps: this.race.laps,
      callout: this.race.callout,
      lamps: this.race.lamps,
      holding: this.race.holding,
      finished: this.race.finished,
      classification: this.race.classification,
      reaction: this.race.reaction,
      detail: this.renderer.detailNote,
    };
  }

  /**
   * Holds a car exactly where it is.
   *
   * Brakes and a handbrake nearly do it, but "nearly" on a cambered grid box
   * is a car that has crept a metre by the time the lights go out, and on a
   * downhill start it is a car that has jumped them. Zeroing the velocity
   * outright is the only thing that actually means stationary.
   */
  #pin(vehicle) {
    vehicle.velocity.set(0, 0, 0);
    vehicle.angularVelocity.set(0, 0, 0);
  }

  /** Everyone's progress, in the order the flag would classify them. */
  #order(playerQ) {
    const length = this.track.length;
    const cars = [
      {
        name: 'You',
        isPlayer: true,
        laps: this.timer.laps.length,
        distance: this.timer.laps.length * length + (playerQ?.s ?? 0),
        best: this.timer.bestLap,
      },
    ];
    for (const o of this.opponents) {
      cars.push({
        name: o.name,
        isPlayer: false,
        laps: o.timer.laps.length,
        distance: o.timer.laps.length * length + (o.q?.s ?? 0),
        best: o.timer.bestLap,
      });
    }
    return cars;
  }

  /** Brings the flag out the moment somebody completes the distance. */
  #checkFlag(playerQ) {
    if (!this.race.laps || this.race.finished) return;
    if (!this.race.check(this.#order(playerQ))) return;
    this.audio?.impact?.(0.25);
    this.onFinish?.(this.race.classification);
  }

  #racePosition() {
    if (!this.opponents.length) return 1;
    const score = (timer, q) => timer.lap * this.track.length + (q ?? 0);
    const mine = score(this.timer, this.playerQuery?.s);
    let pos = 1;
    for (const o of this.opponents) {
      const q = this.track.query(o.vehicle.position.x, o.vehicle.position.z, {});
      if (score(o.timer, q.s) > mine) pos++;
    }
    return pos;
  }

  dispose() {
    this.stop();
    this.#teardown();
    window.removeEventListener('resize', this._onResize);
    this.input.dispose();
    this.audio.dispose();
    this.assets.dispose();
    this.renderer.dispose();
  }
}

/** Minimal replacement for the deprecated THREE.Clock. */
class FrameClock {
  constructor() {
    this.last = performance.now() / 1000;
  }

  getDelta() {
    const now = performance.now() / 1000;
    const dt = now - this.last;
    this.last = now;
    return dt;
  }
}

/** What the pacing profile needs to know about a car. */
/**
 * The car as the pacing model sees it: a cornering and braking limit, a mass
 * and a peak power. Exported because the braking assist and its tests have
 * to read the same profile the arrows are drawn from.
 */
export function pacingCar(spec) {
  let kw = 0;
  for (const [rpm, nm] of spec.engine?.torqueCurve ?? []) {
    kw = Math.max(kw, (nm * rpm * Math.PI * 2) / 60 / 1000);
  }
  return {
    lateralG: 11.2,
    brakingG: 11.5,
    mass: spec.mass ?? 1440,
    powerKw: kw || 340,
    topSpeed: 95,
  };
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== '0';
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose();
  });
}
