import { clamp, lerp } from './MathUtils.js';

/**
 * Procedural engine audio.
 *
 * There are no CC0 recordings of a naturally aspirated V8 available to ship
 * with this, so the engine is synthesised instead: a stack of sawtooth
 * oscillators tuned to the firing orders of the engine, a filtered noise bed
 * for induction and exhaust, and a resonant filter sweep that opens with
 * throttle. It is driven entirely from the simulation — rpm, load, gear
 * changes and the limiter all come straight out of the drivetrain.
 */
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.5;
    this.started = false;
    // Weather, remembered so a preset chosen before the first tap still plays.
    this.rain = 0;
    this.weatherWind = 0.5;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;

    this.ctx = new Ctx();
    const ctx = this.ctx;
    this.started = true;
    this.enabled = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Gentle limiting so the mix never clips when everything is loud at once.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;
    this.compressor.connect(this.master);

    /* -- engine ----------------------------------------------------------- */
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    // Bandpass sweep: the "opening up" you hear as an engine comes on cam.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 1.1;

    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.compressor);

    // Harmonics of the firing frequency. A cross-plane V8 fires 4× per
    // revolution, so the fundamental is 2× engine order; the rest are the
    // overtones that give it its character.
    this.oscillators = [];
    const partials = [
      { ratio: 0.5, gain: 0.5, type: 'sawtooth' },
      { ratio: 1, gain: 1.0, type: 'sawtooth' },
      { ratio: 2, gain: 0.55, type: 'sawtooth' },
      { ratio: 3, gain: 0.3, type: 'square' },
      { ratio: 4.02, gain: 0.18, type: 'sawtooth' },
      { ratio: 6.01, gain: 0.1, type: 'sawtooth' },
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      const gain = ctx.createGain();
      gain.gain.value = p.gain;
      osc.connect(gain);
      gain.connect(this.engineGain);
      osc.start();
      this.oscillators.push({ osc, gain, ratio: p.ratio, base: p.gain });
    }

    /* -- induction / exhaust noise ---------------------------------------- */
    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = makeNoiseBuffer(ctx, 2);
    this.noiseSource.loop = true;

    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = 0.7;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.compressor);
    this.noiseSource.start();

    /* -- tyre squeal ------------------------------------------------------ */
    this.squealSource = ctx.createBufferSource();
    this.squealSource.buffer = makeNoiseBuffer(ctx, 2);
    this.squealSource.loop = true;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1650;
    this.squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSource.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.compressor);
    this.squealSource.start();

    /* -- wind ------------------------------------------------------------- */
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = makeNoiseBuffer(ctx, 2);
    this.windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.compressor);
    this.windSource.start();

    /* -- rain ------------------------------------------------------------- */
    // Two beds: the hiss of drops on the bodywork and the road, and the low
    // rumble a storm puts under everything. Both are shaped noise, so they
    // cost nothing to ship.
    this.rainSource = ctx.createBufferSource();
    this.rainSource.buffer = makeNoiseBuffer(ctx, 3);
    this.rainSource.loop = true;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 2600;
    this.rainFilter.Q.value = 0.45;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainSource.connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.compressor);
    this.rainSource.start();

    this.rumbleSource = ctx.createBufferSource();
    this.rumbleSource.buffer = makeNoiseBuffer(ctx, 3);
    this.rumbleSource.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 140;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSource.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.compressor);
    this.rumbleSource.start();

    this.lastGear = 1;
    this.setWeather(this.rain, this.weatherWind);
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  /**
   * @param {number} rain 0 dry, 1 rain, 2 storm
   * @param {number} wind 0..2, how hard it is blowing
   */
  setWeather(rain, wind = 0.5) {
    this.rain = rain;
    this.weatherWind = wind;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(clamp(rain, 0, 2) * 0.055, t, 0.8);
    this.rainFilter.frequency.setTargetAtTime(lerp(3000, 1900, clamp(rain - 1, 0, 1)), t, 0.8);
    this.rumbleGain.gain.setTargetAtTime(clamp(rain - 0.6, 0, 1.4) * 0.16, t, 1.2);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  /**
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   */
  update(vehicle, dt) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const smooth = 0.045;

    const dt_ = vehicle.drivetrain;
    const rpm = dt_.rpm;
    const load = clamp(vehicle.controls.throttle, 0, 1);
    const speed = vehicle.speed;

    // Fundamental: engine order 2 (a V8's firing frequency).
    const fundamental = clamp((rpm / 60) * 2, 20, 900);

    for (const o of this.oscillators) {
      o.osc.frequency.setTargetAtTime(fundamental * o.ratio, t, smooth);
      // Higher harmonics come in with load — an engine on the overrun is
      // much softer than the same rpm under power.
      const emphasis = o.ratio > 1 ? lerp(0.35, 1.15, load) : 1;
      o.gain.gain.setTargetAtTime(o.base * emphasis, t, smooth);
    }

    // Cut on the limiter, so it audibly bounces off the rev limit.
    const limiting = dt_.limiterCut > 0 ? 0.25 : 1;
    const shifting = dt_.shiftTimer > 0 ? 0.35 : 1;

    const engineLevel = lerp(0.1, 0.34, load) * limiting * shifting;
    this.engineGain.gain.setTargetAtTime(engineLevel, t, smooth);

    // The filter opens with revs and throttle: closed and muffled at idle,
    // wide open and hard at 9 000 rpm.
    const cutoff = lerp(700, 5200, clamp(rpm / dt_.spec.limiterRpm, 0, 1)) * lerp(0.55, 1, load);
    this.engineFilter.frequency.setTargetAtTime(cutoff, t, smooth);

    // Induction roar.
    this.noiseFilter.frequency.setTargetAtTime(
      lerp(300, 2200, clamp(rpm / dt_.spec.limiterRpm, 0, 1)),
      t,
      smooth,
    );
    this.noiseGain.gain.setTargetAtTime(load * 0.11 * limiting, t, smooth);

    // Tyre squeal follows the worst-sliding tyre that is still on tarmac.
    let squeal = 0;
    let squealPitch = 1500;
    for (const w of vehicle.wheels) {
      if (!w.grounded || w.surface > 2) continue;
      const s = clamp((w.slipSpeed - 2.2) / 9, 0, 1);
      if (s > squeal) {
        squeal = s;
        squealPitch = lerp(1250, 2100, clamp(w.slipSpeed / 16, 0, 1));
      }
    }
    this.squealGain.gain.setTargetAtTime(squeal * 0.13, t, 0.06);
    this.squealFilter.frequency.setTargetAtTime(squealPitch, t, 0.08);

    // Wind rises steeply with speed, and a gale adds a floor to it.
    const gust = clamp(this.weatherWind - 0.6, 0, 1.4) * 0.05;
    const windLevel = clamp((speed - 12) / 90, 0, 1) ** 1.6 * 0.12 + gust;
    this.windGain.gain.setTargetAtTime(windLevel, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(lerp(400, 1500, clamp(speed / 90, 0, 1)), t, 0.12);

    // Spray off the tyres on a wet road: a hiss that grows with speed.
    const wet = vehicle.track?.wetness ?? 0;
    if (wet > 0.05 && this.rainGain) {
      const spray = clamp((speed - 6) / 60, 0, 1) * wet * 0.06;
      this.rainGain.gain.setTargetAtTime(clamp(this.rain, 0, 2) * 0.055 + spray, t, 0.2);
    }

    // Shift blip.
    if (dt_.gear !== this.lastGear) {
      this.#click(dt_.gear > this.lastGear ? 0.7 : 1.0);
      this.lastGear = dt_.gear;
    }
  }

  /** Short percussive transient for gearshifts. */
  #click(pitch) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(70 * pitch, t + 0.06);
    gain.gain.setValueAtTime(0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain);
    gain.connect(this.compressor);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** Impact thump when the car hits something. */
  impact(strength) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx, 0.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(clamp(strength, 0, 1) * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);
    src.start(t);
    src.stop(t + 0.4);
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

function makeNoiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    // Slightly pink-tinted noise sounds more like air than white noise does.
    const white = Math.random() * 2 - 1;
    last = (last + 0.028 * white) / 1.028;
    data[i] = last * 3.2;
  }
  return buffer;
}
