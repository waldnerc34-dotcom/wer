import * as THREE from 'three';

import { clamp, damp, lerp } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Camera placements, cycled with V. */
export const VIEWS = ['chase', 'close', 'bonnet', 'cockpit', 'tv'];

/**
 * Follows the car.
 *
 * The chase camera is deliberately not rigidly bolted to the chassis: it lags
 * in position, aims slightly ahead of where the car is pointing, leans with
 * lateral load, and widens its field of view with speed. That lag is what
 * gives a sense of the car moving underneath you rather than the world sliding
 * past a fixed model.
 */
export class ChaseCamera {
  constructor(camera, track) {
    this.camera = camera;
    this.track = track;
    this.view = 0;
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0); // smoothed, never rolled
    this.cameraUp = new THREE.Vector3(0, 1, 0); // what the camera is given
    this.roll = 0;
    this.fov = 58;
    this.shake = 0;
    this.lookBack = false;
    this.tvNode = 0;
  }

  cycle() {
    this.view = (this.view + 1) % VIEWS.length;
  }

  get mode() {
    return VIEWS[this.view];
  }

  /** Camera-relative rig offsets for each view. */
  #rig(spec) {
    switch (this.mode) {
      case 'close':
        return { offset: new THREE.Vector3(0, 1.15, -4.4), lag: 9, fov: 60, look: 9 };
      case 'bonnet':
        return { offset: new THREE.Vector3(0, 0.92, 0.55), lag: 40, fov: 66, look: 26 };
      case 'cockpit':
        return { offset: new THREE.Vector3(-0.34, 0.78, -0.15), lag: 60, fov: 62, look: 34 };
      case 'tv':
        return { offset: null, lag: 4, fov: 40, look: 6 };
      default:
        return { offset: new THREE.Vector3(0, 1.85, -6.6), lag: 6.5, fov: 58, look: 7 };
    }
  }

  reset(vehicle) {
    const rig = this.#rig(vehicle.spec);
    if (rig.offset) {
      this.position.copy(rig.offset).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    } else {
      this.position.copy(vehicle.position).add(new THREE.Vector3(0, 12, 0));
    }
    this.lookAt.copy(vehicle.position);
    this.up.set(0, 1, 0);
    this.cameraUp.set(0, 1, 0);
    this.roll = 0;
  }

  update(vehicle, dt, impulse = 0) {
    const rig = this.#rig(vehicle.spec);
    const speed = vehicle.speed;
    const t = vehicle.telemetry;

    if (this.mode === 'tv') return this.#updateTV(vehicle, dt);

    // Desired eye point, in the car's frame.
    _v.copy(rig.offset);
    if (this.lookBack) _v.z *= -1;
    _v.applyQuaternion(vehicle.quaternion).add(vehicle.position);

    // Pull the chase camera back and down a little as speed rises.
    if (this.mode === 'chase' || this.mode === 'close') {
      const stretch = clamp(speed / 95, 0, 1);
      _v2.set(0, 0, -1).applyQuaternion(vehicle.quaternion).multiplyScalar(stretch * 1.5);
      _v.add(_v2);
      _v.y += stretch * 0.18;
    }

    this.position.copy(damp3(this.position, _v, rig.lag, dt));

    // Aim ahead of the car along its velocity, so the camera leads into
    // corners instead of chasing them.
    _v2.copy(vehicle.position);
    _v2.y += this.mode === 'cockpit' || this.mode === 'bonnet' ? 0.55 : 0.85;
    const lead = clamp(speed * 0.16, 0, 9);
    if (speed > 1.5) {
      _v.copy(vehicle.velocity).normalize().multiplyScalar(lead);
      _v.y *= 0.35;
      _v2.add(_v);
    } else {
      _v.set(0, 0, lead + 4).applyQuaternion(vehicle.quaternion);
      _v2.add(_v);
    }
    if (this.lookBack) {
      _v.set(0, 0, -14).applyQuaternion(vehicle.quaternion);
      _v2.copy(vehicle.position).add(_v);
    }
    this.lookAt.copy(damp3(this.lookAt, _v2, rig.look, dt));

    // Follow the chassis a little in the chase views and almost fully in the
    // cockpit views, so kerbs and camber are felt.
    _q.copy(vehicle.quaternion);
    const chassisUp = _v.set(0, 1, 0).applyQuaternion(_q);
    const blend = this.mode === 'cockpit' || this.mode === 'bonnet' ? 0.95 : 0.28;
    this.up.copy(damp3(this.up, chassisUp.lerp(WORLD_UP, 1 - blend).normalize(), 8, dt)).normalize();

    // A touch of lean into the corner — a couple of degrees, no more. It is
    // applied to a *copy* of the up vector: rolling the stored vector itself
    // compounds frame after frame (the smoothing starts from the rolled
    // result), and the whole view slowly turns over while cornering.
    const chase = this.mode === 'chase' || this.mode === 'close';
    const lean = chase ? clamp(-t.gForceLat * 0.012, -0.03, 0.03) : 0;
    this.roll = damp(this.roll, lean, 5, dt);
    this.cameraUp
      .copy(this.up)
      .applyAxisAngle(_v2.copy(this.lookAt).sub(this.position).normalize(), this.roll);

    // Camera shake: kerbs, bottoming out, and impacts.
    let rumble = 0;
    for (const w of vehicle.wheels) {
      if (!w.grounded) continue;
      rumble += SURFACE_SHAKE[w.surface] ?? 0;
    }
    rumble = (rumble / 4) * clamp(speed / 26, 0, 1);
    this.shake = damp(this.shake, rumble + impulse, 12, dt);

    if (this.shake > 0.001) {
      const a = performance.now() * 0.055;
      const amp = this.shake * (this.mode === 'cockpit' ? 0.055 : 0.03);
      this.position.x += Math.sin(a * 1.7) * amp;
      this.position.y += Math.sin(a * 2.3 + 1.1) * amp;
      this.position.z += Math.sin(a * 1.9 + 2.4) * amp;
    }

    // Field of view opens up with speed — the classic sense-of-speed trick,
    // kept subtle so it does not read as a fisheye.
    const target = rig.fov + clamp((speed * 3.6 - 60) / 300, 0, 1) * 13;
    this.fov = damp(this.fov, target, 3, dt);

    this.#apply();
  }

  /** Trackside broadcast camera: picks the nearest marshal post and pans. */
  #updateTV(vehicle, dt) {
    const track = this.track;
    const q = track.query(vehicle.position.x, vehicle.position.z, {});
    const i = q.index;

    // Sit outside the barrier, elevated, a little ahead of the car.
    const ahead = (i + 26) % track.count;
    _v.fromArray(track.pos, ahead * 3);
    _v2.fromArray(track.lateral, ahead * 3);
    const side = track.curvature[ahead] > 0 ? -1 : 1;
    _v.addScaledVector(_v2, side * (track.width[ahead] * 0.5 + 17));
    _v.y += 6.5;

    if (_v.distanceTo(this.position) > 55) this.position.copy(_v);
    else this.position.copy(damp3(this.position, _v, 1.6, dt));

    this.lookAt.copy(damp3(this.lookAt, vehicle.position, 7, dt));
    this.up.set(0, 1, 0);
    this.cameraUp.set(0, 1, 0);
    const dist = this.position.distanceTo(vehicle.position);
    this.fov = damp(this.fov, clamp(1400 / Math.max(dist, 12), 14, 46), 2.5, dt);
    this.#apply();
  }

  #apply() {
    this.camera.position.copy(this.position);
    this.camera.up.copy(this.cameraUp);
    this.camera.lookAt(this.lookAt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const SURFACE_SHAKE = [0.015, 0.85, 0.05, 0.55, 0.32];

const _tmp = new THREE.Vector3();
function damp3(current, target, lambda, dt) {
  const t = 1 - Math.exp(-lambda * dt);
  return _tmp.copy(current).lerp(target, clamp(t, 0, 1));
}
