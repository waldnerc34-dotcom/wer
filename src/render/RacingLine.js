import * as THREE from 'three';

import { PHASE } from '../track/Pacing.js';

const COLOURS = {
  [PHASE.ACCELERATE]: new THREE.Color(0.18, 1.25, 0.32),
  [PHASE.HOLD]: new THREE.Color(1.35, 1.05, 0.08),
  [PHASE.BRAKE]: new THREE.Color(1.5, 0.1, 0.08),
};

/**
 * Chevrons laid along the racing line, coloured by what the pacing profile
 * says to do there: green accelerate, yellow hold, red brake. One instanced
 * mesh for the whole lap; recoloured in place when the weather changes.
 */
export class RacingLineMesh {
  constructor(track, pacing, { spacing = 5 } = {}) {
    this.track = track;
    this.pacing = pacing;

    const step = Math.max(1, Math.round(spacing / track.spacing));
    this.indices = [];
    for (let i = 0; i < track.count; i += step) this.indices.push(i);

    this.mesh = new THREE.InstancedMesh(chevron(), material(), this.indices.length);
    this.mesh.name = 'racing-line';
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.#place();
    this.refresh();
  }

  #place() {
    const { track } = this;
    const pos = new THREE.Vector3();
    const next = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const m = new THREE.Matrix4();

    this.indices.forEach((i, k) => {
      const j = (i + 1) % track.count;
      pos.fromArray(track.linePos, i * 3);
      next.fromArray(track.linePos, j * 3);
      tangent.subVectors(next, pos).normalize();
      up.fromArray(track.normal, i * 3);
      right.crossVectors(up, tangent).normalize();
      up.crossVectors(tangent, right).normalize();
      pos.addScaledVector(up, 0.03);
      m.makeBasis(right, up, tangent).setPosition(pos);
      this.mesh.setMatrixAt(k, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Re-reads the pacing phases; call after the weather changes the grip. */
  refresh() {
    this.indices.forEach((i, k) => {
      this.mesh.setColorAt(k, COLOURS[this.pacing.phase[i]]);
    });
    this.mesh.instanceColor.needsUpdate = true;
  }

  set visible(v) {
    this.mesh.visible = v;
  }

  get visible() {
    return this.mesh.visible;
  }
}

/** A flat chevron pointing +Z, 1.7 m wide, in the XZ plane. */
function chevron() {
  const shape = new THREE.Shape();
  const w = 0.85;
  const l = 0.66;
  const t = 0.34;
  shape.moveTo(-w, -l);
  shape.lineTo(0, 0);
  shape.lineTo(w, -l);
  shape.lineTo(w, -l + t);
  shape.lineTo(0, t * 0.55);
  shape.lineTo(-w, -l + t);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  // Lie flat with the face up. Rotating about X alone leaves the tip
  // pointing -Z — against the direction of travel — so turn it round.
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(Math.PI);
  return geo;
}

function material() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });
}
