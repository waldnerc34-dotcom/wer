import { approach, clamp } from './MathUtils.js';

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
 * Keyboard and gamepad input, smoothed into the analogue axes the car wants.
 *
 * A keyboard can only give 0 or 1, so steering and pedals are ramped toward
 * their targets at rates that mimic how quickly a driver can actually move.
 * Steering ramps faster the slower the car is going, which is what makes a
 * keyboard car drivable at all without feeling numb at speed.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = new Set();
    this.gamepadIndex = null;

    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.raw = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.usingGamepad = false;

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

    if (pad) {
      this.usingGamepad = true;
      this.state.throttle = pad.throttle;
      this.state.brake = pad.brake;
      this.state.steer = pad.steer;
      this.state.handbrake = pad.handbrake;
      this.padButtons = pad.buttons;
      return this.state;
    }

    // Pedals: quick to apply, quicker to release.
    const throttleTarget = this.held('throttle') ? 1 : 0;
    const brakeTarget = this.held('brake') ? 1 : 0;
    this.state.throttle = approach(this.state.throttle, throttleTarget, dt * (throttleTarget ? 4.5 : 9));
    this.state.brake = approach(this.state.brake, brakeTarget, dt * (brakeTarget ? 7 : 12));
    this.state.handbrake = this.held('handbrake') ? 1 : 0;

    // Steering: a driver can wind on lock quickly at parking speeds but only
    // makes small, slow inputs at 250 km/h.
    const dir = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const speedScale = clamp(1 - speedKph / 260, 0.3, 1);
    const rate = 3.2 * speedScale + 0.7;
    const centring = 5.4;

    if (dir !== 0) {
      this.state.steer = approach(this.state.steer, dir * clamp(speedScale * 1.7, 0.45, 1), dt * rate);
    } else {
      this.state.steer = approach(this.state.steer, 0, dt * centring);
    }

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
