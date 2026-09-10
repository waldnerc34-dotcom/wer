import * as THREE from 'three';

import { GhostPlayer } from '../game/Ghost.js';

/**
 * The car a ghost is drawn as.
 *
 * Deliberately not a real car: it is translucent, it casts no shadow, it
 * throws nothing off its tyres and it cannot be hit. All of that is on
 * purpose — a ghost that looked solid would have you lifting for a car that
 * is not there, which is worse than no ghost at all. It reads as a marker
 * that happens to be car-shaped, which is exactly what it is.
 */

const TINT = 0x5ad1ff;

export class GhostCar {
  /**
   * @param {THREE.Object3D} model a cloned glTF scene, as the rig gets
   * @param {object} trace decoded by decodeGhost
   * @param {object} [opts]
   */
  constructor(model, trace, { spec, label = 'Ghost' } = {}) {
    this.player = new GhostPlayer(trace);
    this.label = label;
    this.lapTime = trace.lapTime;

    this.group = new THREE.Group();
    this.group.name = 'ghost';
    this.group.add(model);

    // One material for the whole car. Nothing about a ghost wants paint,
    // glass and rubber told apart, and one material is one draw call's worth
    // of state for a thing that is on screen the entire lap.
    this.material = new THREE.MeshBasicMaterial({
      color: TINT,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      // Both sides, because with no depth write you see straight through to
      // the far panels and a single-sided car reads as a hole.
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = this.material;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    // After the road and the scenery, so it never z-fights the surface it is
    // sitting on.
    this.group.renderOrder = 4;

    // Scale the model the way CarRig would, from the wheelbase it was built
    // for, so a ghost of a different car is still the right size.
    if (spec) this.#fit(model, spec);

    this.out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this.visible = false;
  }

  /**
   * The models come at different scales and facing different ways. The rig
   * works this out from the wheel nodes; here it is enough to match the
   * bounding box to the car the trace was driven in.
   */
  #fit(model, spec) {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const wanted = spec.wheelbase * 1.55; // overall length, near enough
    if (size.z > 0.1) {
      const scale = wanted / size.z;
      if (scale > 0.2 && scale < 5) model.scale.setScalar(scale);
    }
    // Sit it on the ground rather than wherever the artist left the origin.
    const after = new THREE.Box3().setFromObject(model);
    model.position.y -= after.min.y;
  }

  /**
   * @param {number} lapSeconds how far into the current lap the player is
   * @param {boolean} running false before the lap has started
   */
  update(lapSeconds, running = true) {
    if (!running) {
      this.group.visible = false;
      this.visible = false;
      return;
    }
    const ok = this.player.at(lapSeconds, this.out);
    this.group.visible = ok;
    this.visible = ok;
    if (!ok) return;
    this.group.position.copy(this.out.position);
    this.group.quaternion.copy(this.out.quaternion);
  }

  /** How far ahead (negative) or behind (positive) the ghost is, in seconds. */
  delta(lapSeconds) {
    return this.player.finished ? lapSeconds - this.lapTime : null;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
    });
    this.material.dispose();
  }
}
