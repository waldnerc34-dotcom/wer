import { approach, clamp, lerp } from './MathUtils.js';

const KEY_MAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  shiftUp: ['KeyE', 'ShiftRight'],
  shiftDown: ['KeyQ', 'ShiftLeft'],
  look: ['KeyC'],
  camera: ['KeyV'],
  reset: ['KeyR'],
  headlights: ['KeyL'],
  pause: ['Escape', 'KeyP'],
};

/**
 * Turns held keys into the analogue axes the car wants.
 *
 * A key is all-or-nothing, so the ramps stand in for a driver's hands and
 * feet. The pedals come on over about a quarter of a second and — deliberately
 * — come off no faster, because lifting instantly mid-corner is how a
 * mid-engined car swaps ends.
 *
 * Steering follows how long the key has been down, and starts slow: the first
 * tenth of a second is a nudge, full lock takes a quarter of a second at
 * parking speeds and most of a second at 200 km/h. A tap is a correction, a hold is a
 * corner, and there is room between the two — which a linear ramp, where a
 * tap already gave half the lock, never had. Releasing centres quickly, as a
 * driver lets the wheel spin back through their hands.
 *
 * Shared with the handling tests, so the car is tested with the hands that
 * drive it.
 *
 * @param {object} state  {throttle, brake, steer, steerHeld, steerDir}, updated in place
 * @param {object} keys   {throttle, brake, left, right} booleans
 * @param {number} dt
 * @param {number} speedKph
 * @param {boolean} [steering=true] false leaves the steering to an analogue source
 */
export function rampKeys(state, keys, dt, speedKph, steering = true) {
  const throttleTarget = keys.throttle ? 1 : 0;
  const brakeTarget = keys.brake ? 1 : 0;
  state.throttle = approach(state.throttle, throttleTarget, dt * (throttleTarget ? 4.5 : 4));
  state.brake = approach(state.brake, brakeTarget, dt * (brakeTarget ? 7 : 12));
  if (!steering) return state;

  const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (dir !== 0) {
    state.steerHeld = dir === state.steerDir ? (state.steerHeld ?? 0) + dt : 0;
    state.steerDir = dir;
    const toFull = lerp(0.25, 0.6, clamp(speedKph / 220, 0, 1));
    const shaped = Math.min(1, state.steerHeld / toFull) ** 1.35;
    state.steer = approach(state.steer, dir * shaped, dt * 10);
  } else {
    state.steerHeld = 0;
    state.steerDir = 0;
    state.steer = approach(state.steer, 0, dt * 6);
  }
  return state;
}

/**
 * Keyboard and gamepad input, smoothed into the analogue axes the car wants.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = new Set();
    this.gamepadIndex = null;

    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, steerHeld: 0, steerDir: 0 };
    this.raw = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.usingGamepad = false;
    this.touch = null;

    // A preference, remembered: some people steer the other way, and tilt
    // steering on some phones reads gravity with the opposite sign.
    let inverted = false;
    try {
      inverted = localStorage.getItem('apex.invertSteer') === '1';
    } catch {
      /* storage unavailable — default */
    }
    this.invertSteer = inverted;

    this._onDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (Object.values(KEY_MAP).flat().includes(e.code)) e.preventDefault();
    };
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    target.addEventListener('keydown', this._onDown);
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.usingGamepad = false;
    });
  }

  /** Attaches on-screen controls; their state is merged with the keyboard. */
  setTouch(touch) {
    this.touch = touch;
  }

  setInvertSteer(on) {
    this.invertSteer = Boolean(on);
    try {
      localStorage.setItem('apex.invertSteer', on ? '1' : '0');
    } catch {
      /* fine */
    }
  }

  /** True on the frame a key goes down. */
  tapped(action) {
    const codes = KEY_MAP[action] ?? [];
    return codes.some((c) => this.pressed.has(c));
  }

  held(action) {
    const codes = KEY_MAP[action] ?? [];
    return codes.some((c) => this.keys.has(c));
  }

  endFrame() {
    this.pressed.clear();
    this.gamepadTapped = 0;
  }

  /**
   * @param {number} dt
   * @param {number} speedKph used to slow the steering ramp at speed
   */
  update(dt, speedKph = 0) {
    const pad = this.#readGamepad();

    const inv = this.invertSteer ? -1 : 1;

    if (pad) {
      this.usingGamepad = true;
      this.state.throttle = pad.throttle;
      this.state.brake = pad.brake;
      this.state.steer = pad.steer * inv;
      this.state.handbrake = pad.handbrake;
      this.padButtons = pad.buttons;
      return this.state;
    }

    const touch = this.touch;
    const keys = {
      throttle: this.held('throttle') || Boolean(touch?.state.throttle),
      brake: this.held('brake') || Boolean(touch?.state.brake),
      left: this.held(inv > 0 ? 'left' : 'right'),
      right: this.held(inv > 0 ? 'right' : 'left'),
    };
    this.state.handbrake = this.held('handbrake') || touch?.state.handbrake ? 1 : 0;

    if (touch?.steering) {
      // Analogue steering from the slider or tilt: follow it closely, but
      // through a short lag so a thumb twitch does not become a snap input.
      // The car's own speed-sensitive rack decides what full means.
      rampKeys(this.state, keys, dt, speedKph, false);
      const target = clamp(touch.steer, -1, 1) * inv;
      this.state.steer = approach(this.state.steer, target, dt * 9);
      return this.state;
    }

    rampKeys(this.state, keys, dt, speedKph);
    return this.state;
  }

  #readGamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return null;

    const dead = (v, d = 0.08) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

    // Standard mapping: RT = buttons[7], LT = buttons[6], left stick X = axes[0].
    const throttle = pad.buttons[7]?.value ?? 0;
    const brake = pad.buttons[6]?.value ?? 0;
    const steer = dead(pad.axes[0] ?? 0);
    const handbrake = pad.buttons[0]?.pressed ? 1 : 0;

    if (throttle < 0.01 && brake < 0.01 && steer === 0 && !handbrake && !this.usingGamepad) {
      return null; // no input yet — stay on the keyboard
    }

    return {
      throttle,
      brake,
      steer,
      handbrake,
      buttons: {
        shiftUp: pad.buttons[5]?.pressed,
        shiftDown: pad.buttons[4]?.pressed,
        camera: pad.buttons[3]?.pressed,
        reset: pad.buttons[1]?.pressed,
        pause: pad.buttons[9]?.pressed,
      },
    };
  }

  dispose(target = window) {
    target.removeEventListener('keydown', this._onDown);
    target.removeEventListener('keyup', this._onUp);
    target.removeEventListener('blur', this._onBlur);
  }
}
