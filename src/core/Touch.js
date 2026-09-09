import { clamp } from './MathUtils.js';

/**
 * On-screen controls for phones and tablets.
 *
 * Left thumb: an analogue steering slider — touch anywhere on it and the
 * steer angle follows the finger's offset from the centre, so a tap on the far
 * left is full lock and a small drag is a small correction. Right thumb:
 * brake and throttle pads, with a handbrake above them. A row of small
 * buttons handles camera, rejoin and pause.
 *
 * Every widget tracks its own pointer id, so steering with one thumb while
 * braking with the other works, and lifting one never releases the other.
 *
 * Tilt steering is optional: it reads the gravity vector from `devicemotion`
 * rather than the Euler angles from `deviceorientation`, which go singular
 * exactly when a phone is held upright in front of you.
 */
export class TouchControls {
  constructor(root, { onCamera, onReset, onPause, onLookBack } = {}) {
    this.root = root;
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, steering: false };
    // iOS reports accelerationIncludingGravity with the opposite sign to the
    // spec (and to Android). Best-effort default; the invert toggle in the
    // pause menu is the backstop.
    const ios =
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.tilt = { enabled: false, sign: ios ? -1 : 1, maxAngle: 22, value: 0, live: false };
    this.callbacks = { onCamera, onReset, onPause, onLookBack };

    root.innerHTML = TEMPLATE;
    root.classList.add('touch');

    this.steerEl = root.querySelector('[data-steer]');
    this.knobEl = root.querySelector('[data-knob]');
    this.wheelEl = root.querySelector('[data-wheel]');

    this.#bindSlider();
    this.#bindPad(root.querySelector('[data-throttle]'), 'throttle');
    this.#bindPad(root.querySelector('[data-brake]'), 'brake');
    this.#bindPad(root.querySelector('[data-handbrake]'), 'handbrake');
    this.#bindButton(root.querySelector('[data-cam]'), onCamera);
    this.#bindButton(root.querySelector('[data-reset]'), onReset);
    this.#bindButton(root.querySelector('[data-pause]'), onPause);
    this.#bindHold(root.querySelector('[data-look]'), onLookBack);

    // Nothing here should ever scroll, zoom or select.
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    this._onMotion = (e) => this.#onMotion(e);
  }

  /* ------------------------------------------------------------- steering */

  #bindSlider() {
    const el = this.steerEl;
    let pointer = null;

    const apply = (clientX) => {
      const r = el.getBoundingClientRect();
      const half = r.width * 0.5 - 22;
      const x = clientX - (r.left + r.width * 0.5);
      this.state.steer = clamp(x / half, -1, 1);
      this.state.steering = true;
      this.#drawSteer(this.state.steer);
    };

    el.addEventListener('pointerdown', (e) => {
      if (pointer !== null) return;
      pointer = e.pointerId;
      capture(el, pointer);
      apply(e.clientX);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer) return;
      apply(e.clientX);
    });
    const release = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.state.steer = 0;
      this.state.steering = false;
      this.#drawSteer(0);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }

  #drawSteer(v) {
    const r = this.steerEl.getBoundingClientRect();
    const half = r.width * 0.5 - 22;
    this.knobEl.style.transform = `translateX(${(v * half).toFixed(1)}px)`;
    this.wheelEl.style.transform = `rotate(${(v * 110).toFixed(1)}deg)`;
  }

  /* --------------------------------------------------------------- pedals */

  #bindPad(el, key) {
    let pointer = null;
    const down = (e) => {
      if (pointer !== null) return;
      pointer = e.pointerId;
      capture(el, pointer);
      this.state[key] = 1;
      el.classList.add('down');
      e.preventDefault();
    };
    const up = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.state[key] = 0;
      el.classList.remove('down');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  #bindButton(el, fn) {
    el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      fn?.();
    });
  }

  #bindHold(el, fn) {
    let pointer = null;
    el.addEventListener('pointerdown', (e) => {
      pointer = e.pointerId;
      capture(el, pointer);
      el.classList.add('down');
      fn?.(true);
    });
    const up = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      el.classList.remove('down');
      fn?.(false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /* ----------------------------------------------------------------- tilt */

  /**
   * Switches on tilt steering. Must be called from a user gesture on iOS,
   * which gates motion sensors behind a permission prompt.
   */
  async enableTilt() {
    try {
      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        const result = await DeviceMotionEvent.requestPermission();
        if (result !== 'granted') return false;
      }
    } catch {
      return false;
    }
    window.addEventListener('devicemotion', this._onMotion);
    this.tilt.enabled = true;
    this.root.classList.add('tilt');
    return true;
  }

  disableTilt() {
    window.removeEventListener('devicemotion', this._onMotion);
    this.tilt.enabled = false;
    this.tilt.live = false;
    this.root.classList.remove('tilt');
  }

  #onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null) return;

    // In landscape the phone's long axis is horizontal, so "tilting the
    // wheel" puts gravity into the device's y axis. Which landscape decides
    // the sign.
    const type = screen.orientation?.type ?? '';
    const sign = type === 'landscape-secondary' ? -1 : 1;
    const angle = (Math.atan2(g.y, Math.hypot(g.x, g.z)) * 180) / Math.PI;
    const raw = clamp((angle * sign * this.tilt.sign) / this.tilt.maxAngle, -1, 1);

    // Dead zone in the middle so the car tracks straight when held roughly level.
    const dead = 0.06;
    const shaped = Math.abs(raw) < dead ? 0 : (raw - Math.sign(raw) * dead) / (1 - dead);
    this.tilt.value = Math.sign(shaped) * Math.abs(shaped) ** 1.35;
    this.tilt.live = true;
    this.#drawSteer(this.tilt.value);
  }

  /** Steering as the Input layer should read it. */
  get steer() {
    if (this.tilt.enabled && this.tilt.live) return this.tilt.value;
    return this.state.steer;
  }

  get steering() {
    return (this.tilt.enabled && this.tilt.live) || this.state.steering;
  }

  setVisible(v) {
    this.root.classList.toggle('hidden', !v);
  }

  dispose() {
    this.disableTilt();
    this.root.innerHTML = '';
  }
}

/** Pointer capture throws for pointers the browser no longer tracks. */
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* fine — we still track the id ourselves */
  }
}

const TEMPLATE = /* html */ `
<div class="touch-aux">
  <button type="button" class="tbtn" data-cam aria-label="Change camera">CAM</button>
  <button type="button" class="tbtn" data-look aria-label="Look behind">REAR</button>
  <button type="button" class="tbtn" data-reset aria-label="Rejoin circuit">↺</button>
  <button type="button" class="tbtn" data-pause aria-label="Pause">❚❚</button>
</div>

<div class="touch-steer" data-steer>
  <div class="steer-track">
    <div class="steer-knob" data-knob>
      <svg viewBox="0 0 40 40" data-wheel aria-hidden="true">
        <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="3.5"/>
        <circle cx="20" cy="20" r="4" fill="currentColor"/>
        <path d="M20 8v9M9 26l8-4M31 26l-8-4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
      </svg>
    </div>
  </div>
</div>

<div class="touch-pedals">
  <button type="button" class="tpad handbrake" data-handbrake aria-label="Handbrake">HB</button>
  <button type="button" class="tpad brake" data-brake aria-label="Brake">BRAKE</button>
  <button type="button" class="tpad throttle" data-throttle aria-label="Throttle">GAS</button>
</div>
`;
