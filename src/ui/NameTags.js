import * as THREE from 'three';

const _v = new THREE.Vector3();

/**
 * Who is in the car in front.
 *
 * Racing people you know is different from racing the computer: the whole
 * point is knowing whose mirrors you are in. The names ride above the cars as
 * plain DOM rather than as sprites in the scene — there are at most a handful,
 * they must stay sharp at any resolution, and text in the scene would go
 * through the tone mapper and come out grey.
 *
 * Tags fade with distance and disappear behind the camera. Nothing here
 * allocates once the tags exist.
 */

/** Past this the name is unreadable anyway, and the car is a dot. */
const RANGE = 220;

/** Where the tag sits above the car's origin, in metres. */
const HEIGHT = 1.55;

export class NameTags {
  /** @param {HTMLElement} root an overlay the size of the viewport */
  constructor(root) {
    this.root = root;
    this.tags = new Map();
  }

  /**
   * @param {Array<{id: string, name: string, vehicle: object, visible: boolean}>} cars
   * @param {THREE.Camera} camera
   * @param {{width: number, height: number}} size the canvas, in CSS pixels
   */
  update(cars, camera, size) {
    for (const car of cars) {
      let tag = this.tags.get(car.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'name-tag';
        this.root.append(tag);
        this.tags.set(car.id, tag);
      }
      if (tag.textContent !== car.name) tag.textContent = car.name;

      if (!car.visible) {
        tag.style.opacity = '0';
        continue;
      }

      _v.copy(car.vehicle.position);
      _v.y += HEIGHT;
      const distance = _v.distanceTo(camera.position);
      _v.project(camera);

      // z past 1 is behind the camera, where projecting puts the tag back on
      // screen mirrored — which reads as a name floating over an empty track.
      if (_v.z > 1 || distance > RANGE) {
        tag.style.opacity = '0';
        continue;
      }

      const x = (_v.x * 0.5 + 0.5) * size.width;
      const y = (-_v.y * 0.5 + 0.5) * size.height;
      tag.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      // Fade out over the last third, and shrink a little with distance so a
      // far car's name does not shout louder than a near one's.
      const near = 1 - Math.max(0, (distance - RANGE * 0.6) / (RANGE * 0.4));
      tag.style.opacity = String(Math.max(0, near).toFixed(2));
      tag.style.fontSize = `${(15 - Math.min(5, distance / 30)).toFixed(1)}px`;
    }

    // Anything that left the race takes its name with it.
    for (const [id, tag] of this.tags) {
      if (!cars.some((c) => c.id === id)) {
        tag.remove();
        this.tags.delete(id);
      }
    }
  }

  dispose() {
    for (const tag of this.tags.values()) tag.remove();
    this.tags.clear();
  }
}
