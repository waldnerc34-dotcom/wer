import * as THREE from 'three';

import { Assets } from '../core/Assets.js';
import { EngineAudio } from '../core/Audio.js';
import { Input } from '../core/Input.js';
import { clamp, damp } from '../core/MathUtils.js';
import { CarRig } from '../render/CarRig.js';
import { TyreEffects } from '../render/Effects.js';
import { Materials } from '../render/Materials.js';
import { QUALITY, Renderer } from '../render/Renderer.js';
import { CIRCUITS } from '../track/Layout.js';
import { Scenery } from '../track/Scenery.js';
import { Track } from '../track/Track.js';
import { buildTrack } from '../track/TrackBuilder.js';
import { CARS, Vehicle } from '../physics/Vehicle.js';
import { Driver, makeField } from './AI.js';
import { ChaseCamera } from './Camera.js';
import { LapTimer } from './Timing.js';

const PAINTS = [0x9d0208, 0x0b3d91, 0xf2f2f0, 0x111214, 0xd6a419, 0x1f6f4a, 0x6d28d9, 0xc2410c];

/**
 * The session: one circuit, one player car, and a field of AI.
 *
 * Owns the fixed ordering of a frame — input, AI, physics, effects, camera,
 * render — and everything that has to be torn down when the player changes
 * car or track.
 */
export class Game {
  constructor(canvas, { quality = 'high', onProgress, onReady, onState } = {}) {
    this.canvas = canvas;
    this.onProgress = onProgress;
    this.onReady = onReady;
    this.onState = onState;

    this.renderer = new Renderer(canvas, quality);
    this.assets = new Assets(this.renderer.renderer);
    this.input = new Input();
    this.audio = new EngineAudio();
    this.materials = new Materials();

    this.opponents = [];
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
  async load({ circuitId = 'apex', carId = 'rosso', mode = 'time-trial', opponents = 5 } = {}) {
    this.running = false;
    this.#teardown();

    this.mode = mode;
    const circuit = CIRCUITS.find((c) => c.id === circuitId) ?? CIRCUITS[0];
    const carDef = CARS.find((c) => c.id === carId) ?? CARS[0];
    this.circuit = circuit;
    this.carDef = carDef;

    this.onProgress?.(0.02, 'Surveying the circuit');
    this.track = new Track(circuit);

    this.onProgress?.(0.08, 'Loading materials');
    await this.materials.load(this.assets);

    this.onProgress?.(0.24, 'Lighting the scene');
    const env = await this.assets.environment(circuit.hdri);
    this.renderer.setEnvironment(env, { groundRadius: 2100, groundHeight: 88 });
    this.renderer.skyboxY = this.track.pos[1] - 1.5;
    this.renderer.setSun(circuit.sunAzimuth, circuit.sunElevation);
    // Aerial perspective only: enough to soften the far treeline, not
    // enough to bleach the middle distance.
    this.renderer.setFog(new THREE.Color(0xa8bacd), 620, 3400);

    this.onProgress?.(0.38, 'Laying the tarmac');
    const built = buildTrack(this.track, this.materials);
    this.trackGroup = built.group;
    this.renderer.scene.add(this.trackGroup);

    this.onProgress?.(0.52, 'Planting the trees');
    this.scenery = new Scenery(this.track, {
      density: this.renderer.settings.sceneryDensity,
    });
    await this.scenery.build(this.assets);
    this.renderer.scene.add(this.scenery.group);

    this.onProgress?.(0.72, 'Warming the cars');
    await this.#spawnCars(carDef, mode === 'race' ? opponents : 0);

    this.onProgress?.(0.94, 'Final checks');
    this.effects = new TyreEffects(this.renderer.scene, this.materials);
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

  async #spawnCars(carDef, opponentCount) {
    // Player.
    const playerModel = await this.assets.instance(carDef.model);
    this.player = new Vehicle(carDef.spec, this.track);
    this.playerRig = new CarRig(playerModel, carDef.spec, this.materials, {
      paint: carDef.paint,
      isPlayer: true,
    });
    this.renderer.scene.add(this.playerRig.group);

    const grid = this.track.gridSlot(0);
    this.player.reset(grid.position, grid.heading);
    this.playerRig.update(this.player, 0.016);

    // Opponents.
    const field = makeField(opponentCount);
    for (let i = 0; i < opponentCount; i++) {
      const def = CARS[(i + 1) % CARS.length];
      const model = await this.assets.instance(def.model);
      const vehicle = new Vehicle(def.spec, this.track);
      const rig = new CarRig(model, def.spec, this.materials, {
        paint: PAINTS[(i + 1) % PAINTS.length],
      });
      this.renderer.scene.add(rig.group);

      const slot = this.track.gridSlot(i + 1);
      vehicle.reset(slot.position, slot.heading);
      vehicle.assists.stability = true;

      const driver = new Driver(vehicle, this.track, {
        skill: field[i].skill,
        aggression: field[i].aggression,
        name: field[i].name,
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
      this.renderer.scene.remove(this.effects.smoke.mesh);
      for (const m of this.effects.marks) this.renderer.scene.remove(m.mesh);
      this.effects = null;
    }
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

    if (!this.paused && dt > 0) {
      this.#step(dt);
      this.simTime += dt;
    }

    this.renderer.render(dt);
    this.input.endFrame();
  }

  #step(dt) {
    const player = this.player;

    /* -- input ------------------------------------------------------------ */
    const controls = this.input.update(dt, player.speedKph);
    this.#handleActions();

    /* -- simulate --------------------------------------------------------- */
    player.update(dt, controls);

    const all = [{ vehicle: player }, ...this.opponents];
    for (const o of this.opponents) {
      const c = o.driver.update(dt, all);
      o.vehicle.update(dt, c);
      o.rig.update(o.vehicle, dt);
      const q = this.track.query(o.vehicle.position.x, o.vehicle.position.z, {});
      o.timer.update(dt, q.s, false);
    }

    this.#resolveCarCollisions();

    /* -- timing ----------------------------------------------------------- */
    const q = this.track.query(player.position.x, player.position.z, {});
    this.playerQuery = q;
    const offTrack = player.telemetry.wheelsOnTrack < 3;
    this.timer.update(dt, q.s, offTrack);

    /* -- visuals ---------------------------------------------------------- */
    this.playerRig.update(player, dt);
    this.effects.update(player, dt, this.renderer.camera);
    this.scenery?.update(dt);

    const impact = player.lastImpact ? clamp(player.lastImpact / 14, 0, 1) : 0;
    if (player.lastImpact) {
      this.audio.impact(impact);
      player.lastImpact = 0;
    }
    this.renderer.setSkyboxCentre(player.position);
    this.camera.update(player, dt, impact);
    this.renderer.setSpeedBlur(player.speedKph);

    this.audio.update(player, dt);

    this.onState?.(this.state());
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
    this.camera.lookBack = input.held('look');
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
        const push = overlap * 0.5;
        a.position.addScaledVector(d, -push);
        b.position.addScaledVector(d, push);

        // Exchange the closing velocity, with a lot of it lost to the panels.
        const closing = b.velocity.clone().sub(a.velocity).dot(d);
        if (closing < 0) {
          const impulse = -closing * 0.45;
          a.velocity.addScaledVector(d, -impulse);
          b.velocity.addScaledVector(d, impulse);
          a.angularVelocity.multiplyScalar(0.9);
          b.angularVelocity.multiplyScalar(0.9);
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
      steer: p.steerAngle / p.spec.maxSteerAngle,
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
      position: this.#racePosition(),
      opponents: this.opponents.length,
      camera: this.camera.mode,
      assists: p.assists,
      headlights: this.headlightsOn,
      damage: p.damage,
      progress: this.playerQuery ? this.playerQuery.s / this.track.length : 0,
      trackName: this.circuit.name,
      carName: this.carDef.name,
    };
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

function disposeTree(root) {
  root.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose();
  });
}
