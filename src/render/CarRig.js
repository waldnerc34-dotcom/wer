import * as THREE from 'three';

import { clamp, damp, lerp } from '../core/MathUtils.js';

const WHEEL_RE = /^wheel[_ ]?(front|rear|f|r)?[_ ]?(l|r|left|right)/i;
const GLASS_RE = /\b(glass|window|windshield|windscreen|rearwindow)\b/i;
const TYRE_RE = /\b(tire|tyre|tiretread|tireside)\b/i;
// `\brim\b` deliberately does not match "trim" — the Ferrari's trim material
// would otherwise be turned into polished wheel metal, which washes out the
// whole interior.
const RIM_RE = /\brim\d?\b|\bwheel_(fl|fr|rl|rr)\b/i;
const TRIM_RE = /\btrim\b|\bhardware\b|\bmirror\b/i;
const PAINT_RE = /\bpaint\b|\bbody\b|\bcarrosserie\b|paint\s*\d/i;
const BRAKE_LIGHT_RE = /brakelight|taillight|tail_light|rearlight/i;
const HEAD_LIGHT_RE = /headlight|head_light|frontlight/i;
const DISC_RE = /\bdisc\b|\brotor\b/i;
const CALIPER_RE = /brakepad|caliper|\bbrake\b/i;

/**
 * The material a named wheel part should wear, or null if the name says
 * nothing. Order matters: "brake disc" is a disc, not a caliper.
 */
function wheelPart(mats, name) {
  if (!name) return null;
  if (/disc|rotor/i.test(name)) return mats.brakeDisc;
  if (/brake|caliper|pad/i.test(name)) return mats.caliper;
  if (/\btyre\b|\btire\b|rubber/i.test(name)) return mats.tyre;
  if (/rim|spoke|alloy|wheel_(fl|fr|rl|rr)/i.test(name)) return mats.rim;
  if (/nut|bolt|centre|center|hub|cap|logo|emblem/i.test(name)) return mats.trim;
  return null;
}

/**
 * Binds a downloaded glTF car to the simulation.
 *
 * The models come from different sources with different scales, orientations
 * and naming conventions, so the rig works out the car's geometry from the
 * wheel nodes themselves: it measures the model's wheelbase, scales it to the
 * physics chassis, works out which way the car faces, and re-parents each
 * wheel onto a hub it can steer and spin.
 */
export class CarRig {
  /**
   * @param {THREE.Object3D} source cloned glTF scene
   * @param {object} spec chassis spec from the vehicle
   * @param {import('./Materials.js').Materials} mats
   * @param {object} options
   */
  constructor(source, spec, mats, { paint = 0x9d0208, isPlayer = false } = {}) {
    this.spec = spec;
    this.mats = mats;
    this.group = new THREE.Group();
    this.group.name = 'car';

    this.body = new THREE.Group();
    this.group.add(this.body);

    this.wheels = [];
    this.brakeLights = [];
    this.headLights = [];
    this.headLampObjects = [];
    this.brakeGlow = 0;

    this.paintMaterial = mats.carPaint(paint);
    this.#build(source);
    if (isPlayer) this.#addHeadlights();
  }

  /* ----------------------------------------------------------------- build */

  #build(source) {
    source.updateMatrixWorld(true);

    // --- locate the wheels ------------------------------------------------
    const found = [];
    source.traverse((o) => {
      if (!o.isMesh && !o.isGroup && !o.isObject3D) return;
      const name = o.name || '';
      if (!WHEEL_RE.test(name)) return;
      if (/steering|pedal/i.test(name)) return;
      // Skip sub-parts (rims, discs) — we want the outermost wheel node.
      if (o.parent && WHEEL_RE.test(o.parent.name || '')) return;
      found.push(o);
    });

    if (found.length < 4) {
      // Fall back to clustering any mesh that sits low and outboard.
      found.length = 0;
      const box = new THREE.Box3().setFromObject(source);
      const size = new THREE.Vector3();
      box.getSize(size);
      source.traverse((o) => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        const c = b.getCenter(new THREE.Vector3());
        if (c.y < box.min.y + size.y * 0.42 && Math.abs(c.x - box.getCenter(new THREE.Vector3()).x) > size.x * 0.22) {
          found.push(o);
        }
      });
    }

    const centre = new THREE.Vector3();
    new THREE.Box3().setFromObject(source).getCenter(centre);

    const corners = found.slice(0, 8).map((o) => {
      const p = new THREE.Vector3();
      o.getWorldPosition(p);
      // Some models put the node origin at the model root; use the mesh
      // bounds instead when that happens.
      if (p.distanceTo(centre) < 0.05) new THREE.Box3().setFromObject(o).getCenter(p);
      return { object: o, position: p };
    });

    // --- measure and orient ----------------------------------------------
    let modelWheelbase = 2.6;
    let axisSign = 1;

    if (corners.length >= 4) {
      const zs = corners.map((c) => c.position.z);
      const front = corners.filter((c) => /front|_f/i.test(c.object.name));
      const rear = corners.filter((c) => /rear|_r(?!.*front)/i.test(c.object.name));
      const zFront = front.length ? avg(front.map((c) => c.position.z)) : Math.max(...zs);
      const zRear = rear.length ? avg(rear.map((c) => c.position.z)) : Math.min(...zs);
      modelWheelbase = Math.abs(zFront - zRear) || 2.6;
      axisSign = zFront >= zRear ? 1 : -1;
    }

    const scale = this.spec.wheelbase / modelWheelbase;
    source.scale.multiplyScalar(scale);
    if (axisSign < 0) source.rotation.y += Math.PI;
    source.updateMatrixWorld(true);

    // Align the model to the simulation.
    //
    // The rig's origin is the car's centre of gravity, which sits ~0.37 m off
    // the ground — so putting the model's lowest point at local zero would
    // leave the whole car hovering. Instead the model is shifted so that its
    // wheel centres land exactly where the physics puts the hubs, both
    // vertically and fore/aft.
    const hubY = this.spec.front.radius - this.spec.cogHeight;
    const wheelYs = [];
    const wheelZs = [];
    for (const c of corners) {
      const p = new THREE.Vector3();
      c.object.getWorldPosition(p);
      if (p.distanceTo(centre) < 0.05) new THREE.Box3().setFromObject(c.object).getCenter(p);
      wheelYs.push(p.y);
      wheelZs.push(p.z);
    }
    if (wheelYs.length) {
      source.position.y += hubY - avg(wheelYs);
      // Centre the wheelbase on the physics axle midpoint.
      const axleMid = (this.spec.cogToFrontAxle - this.spec.cogToRearAxle) / 2;
      source.position.z += axleMid - avg(wheelZs);
    } else {
      const box = new THREE.Box3().setFromObject(source);
      source.position.y -= box.min.y + this.spec.cogHeight;
    }
    source.updateMatrixWorld(true);

    // --- re-parent the wheels onto drivable hubs --------------------------
    const order = ['fl', 'fr', 'rl', 'rr'];
    const slots = { fl: null, fr: null, rl: null, rr: null };

    for (const c of corners) {
      const p = new THREE.Vector3();
      c.object.getWorldPosition(p); // re-read: the model has since been shifted
      if (p.distanceTo(centre) < 0.05) new THREE.Box3().setFromObject(c.object).getCenter(p);
      const isFront = /front|_f/i.test(c.object.name)
        ? true
        : /rear|_r/i.test(c.object.name)
          ? false
          : p.z > 0;
      // The car's left is +X (forward is +Z in a right-handed frame).
      const key = `${isFront ? 'f' : 'r'}${p.x > 0 ? 'l' : 'r'}`;
      if (slots[key]) continue;
      slots[key] = { object: c.object, position: p.clone() };
    }

    this.body.add(source);
    this.modelRoot = source;

    for (const key of order) {
      const slot = slots[key];
      if (!slot) {
        this.wheels.push(null);
        continue;
      }
      const hub = new THREE.Group();
      hub.name = `hub_${key}`;
      hub.position.copy(slot.position);
      this.group.add(hub);

      // Keep the wheel's own orientation, but recentre it on the hub.
      const wheel = slot.object;
      const worldQuat = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      wheel.getWorldQuaternion(worldQuat);
      wheel.getWorldScale(worldScale);
      wheel.removeFromParent();
      hub.add(wheel);
      wheel.position.set(0, 0, 0);
      wheel.quaternion.copy(worldQuat);
      wheel.scale.copy(worldScale);

      this.wheels.push({
        hub,
        mesh: wheel,
        // Rest pose taken from the model, so the wheels stay in their arches
        // even when the model's track width differs from the physics chassis.
        base: slot.position.clone(),
      });
    }

    this.#applyMaterials();
    this.#applyWheelMaterials();
  }

  /**
   * Anything mounted on a hub is a wheel part, so it can be classified by role
   * rather than by hoping its name matches a global pattern. Source models
   * name these inconsistently ("tire", "tire_1", "wheel_3"), and getting it
   * wrong leaves a supercar sitting on white tyres.
   */
  #applyWheelMaterials() {
    const mats = this.mats;
    for (const rig of this.wheels) {
      if (!rig) continue;
      rig.hub.traverse((o) => {
        if (!o.isMesh) return;
        // The material name first, and only then the node name.
        //
        // prepare-cars.mjs names the material of every part exactly — tyre,
        // rim, disc, hub — but puts all four primitives on one mesh called
        // wheel_fl, and three names each of them after that mesh. Testing the
        // two together let `wheel_fl` match the rim pattern for every part on
        // the hub, so all three prepared cars were driving around on chrome
        // tyres. The node name is still worth consulting for models that were
        // never prepared, where it is all there is.
        o.material = wheelPart(mats, o.material?.name) ?? wheelPart(mats, o.name) ?? mats.tyre;
        o.castShadow = true;
        o.receiveShadow = true;
      });
    }
  }

  /* ------------------------------------------------------------- materials */

  #applyMaterials() {
    const mats = this.mats;
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const matName = o.material?.name ?? '';
      const nodeName = o.name ?? '';
      const both = `${matName} ${nodeName}`;

      if (BRAKE_LIGHT_RE.test(both)) {
        const m = new THREE.MeshStandardMaterial({
          color: 0x4a0703,
          emissive: new THREE.Color(0xff1405),
          emissiveIntensity: 0.35,
          roughness: 0.3,
          metalness: 0,
        });
        o.material = m;
        this.brakeLights.push(m);
        return;
      }
      if (HEAD_LIGHT_RE.test(both)) {
        const m = new THREE.MeshStandardMaterial({
          color: 0xdfe6ee,
          emissive: new THREE.Color(0xdfe8ff),
          emissiveIntensity: 0.2,
          roughness: 0.12,
          metalness: 0.2,
        });
        o.material = m;
        this.headLights.push(m);
        return;
      }
      if (GLASS_RE.test(both)) {
        o.material = mats.glass;
        o.castShadow = false;
        return;
      }
      if (TYRE_RE.test(both)) {
        o.material = mats.tyre;
        return;
      }
      if (DISC_RE.test(both)) {
        o.material = mats.brakeDisc;
        return;
      }
      if (CALIPER_RE.test(both)) {
        o.material = mats.caliper;
        return;
      }
      if (TRIM_RE.test(both)) {
        o.material = mats.trim;
        return;
      }
      if (RIM_RE.test(both)) {
        o.material = mats.rim;
        return;
      }
      if (PAINT_RE.test(both)) {
        o.material = this.paintMaterial;
        return;
      }
      // Anything left keeps its authored material, but gets sensible
      // environment response so it does not read as flat plastic.
      if (o.material && 'envMapIntensity' in o.material) {
        o.material = o.material.clone();
        o.material.envMapIntensity = 1.1;
      }
    });
  }

  /** Working headlamps for the player's car. */
  #addHeadlights() {
    const half = this.spec.front.track / 2 - 0.16;
    for (const side of [-1, 1]) {
      const lamp = new THREE.SpotLight(0xeaf0ff, 0, 90, 0.42, 0.45, 1.4);
      lamp.position.set(side * half, 0.62, this.spec.cogToFrontAxle - 0.05);
      lamp.target.position.set(side * half * 1.6, 0.05, this.spec.cogToFrontAxle + 34);
      lamp.castShadow = false;
      this.group.add(lamp, lamp.target);
      this.headLampObjects.push(lamp);
    }
  }

  setHeadlights(on) {
    for (const l of this.headLampObjects) l.intensity = on ? 260 : 0;
    for (const m of this.headLights) m.emissiveIntensity = on ? 3.4 : 0.2;
  }

  setPaint(color) {
    this.paintMaterial.color.set(color);
    this.paintMaterial.sheenColor.set(new THREE.Color(color).offsetHSL(0, 0, 0.25));
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Pushes one frame of simulation state onto the visual rig.
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   */
  update(vehicle, dt) {
    this.group.position.copy(vehicle.position);
    this.group.quaternion.copy(vehicle.quaternion);

    for (let i = 0; i < 4; i++) {
      const rig = this.wheels[i];
      const w = vehicle.wheels[i];
      if (!rig || !w) continue;

      // Suspension travel relative to the model's own rest pose: positive
      // when the strut is compressed, which lifts the wheel into the arch.
      rig.hub.position.set(
        rig.base.x,
        rig.base.y + (w.restLength - w.length),
        rig.base.z,
      );
      rig.hub.rotation.set(-w.spin, w.steer, 0, 'YXZ');
    }

    // Brake lights ride the brake input, with a little bloom-friendly punch.
    const braking = Math.max(vehicle.controls.brake, vehicle.controls.handbrake);
    this.brakeGlow = damp(this.brakeGlow, braking > 0.02 ? 1 : 0, 22, dt);
    for (const m of this.brakeLights) {
      m.emissiveIntensity = lerp(0.35, 7.5, this.brakeGlow);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
    });
    this.paintMaterial.dispose();
  }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
