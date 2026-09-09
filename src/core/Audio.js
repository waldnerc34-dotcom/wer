import { clamp, lerp } from './MathUtils.js';

/**
 * The car's sound, built on recordings.
 *
 * The engine is a real one — a V8 loop — played back at the rate that puts
 * its firing frequency where the simulated engine's is: rpm, cylinder count
 * and stroke set the pitch, so a flat-six and a V10 come out different
 * engines. A second copy an octave down puts weight under it at high revs, a
 * low-pass opens with the throttle so lifting off sounds like lifting off,
 * and the limiter and gearshifts cut it the way they cut the real thing.
 * Tyre squeal is a recording too, played by slip; impacts get a recorded
 * crash. Wind, rain and a storm's rumble are shaped noise, which is what
 * they are.
 *
 * If the recordings cannot be loaded, a simple synthesised engine stands in.
 */
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.5;
    this.started = false;
    this.samples = {}; // ArrayBuffers, decoded once the context exists
    this.buffers = {};
    // Weather, remembered so a preset chosen before the first tap still plays.
    this.rain = 0;
    this.weatherWind = 0.5;
  }

  /** Fetches the recordings. Safe before the context exists — nothing plays yet. */
  async load(assets) {
    const files = { engine: 'sounds/engine.mp3', tyres: 'sounds/tyres.mp3', crash: 'sounds/crash.mp3' };
    await Promise.all(
      Object.entries(files).map(async ([key, path]) => {
        try {
          this.samples[key] = await assets.audio(path);
        } catch (err) {
          console.warn(`Sound "${path}" unavailable:`, err?.message ?? err);
        }
      }),
    );
    if (this.ctx) await this.#decode();
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

    /* -- engine bus ------------------------------------------------------- */
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.9;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.compressor);

    /* -- induction noise -------------------------------------------------- */
    this.noiseSource = this.#loop(makeNoiseBuffer(ctx, 2));
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.compressor);

    /* -- wind ------------------------------------------------------------- */
    this.windSource = this.#loop(makeNoiseBuffer(ctx, 2));
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.compressor);

    /* -- rain and storm --------------------------------------------------- */
    this.rainSource = this.#loop(makeNoiseBuffer(ctx, 3));
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 2600;
    this.rainFilter.Q.value = 0.45;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainSource.connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.compressor);

    this.rumbleSource = this.#loop(makeNoiseBuffer(ctx, 3));
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 140;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSource.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.compressor);

    /* -- tyre squeal bus -------------------------------------------------- */
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.compressor);

    this.lastGear = 1;
    this.setWeather(this.rain, this.weatherWind);
    this.#decode();
  }

  /** Decodes whatever recordings have arrived and starts the loops. */
  async #decode() {
    const ctx = this.ctx;
    if (!ctx || this.decoding) return;
    this.decoding = true;
    for (const [key, bytes] of Object.entries(this.samples)) {
      if (this.buffers[key]) continue;
      try {
        const decoded = await ctx.decodeAudioData(bytes.slice(0));
        this.buffers[key] = key === 'crash' ? decoded : seamlessLoop(ctx, decoded, 0.12);
      } catch (err) {
        console.warn(`Could not decode "${key}":`, err?.message ?? err);
      }
    }
    this.decoding = false;
    if (this.buffers.engine && !this.engineSource) this.#startEngine();
    if (this.buffers.tyres && !this.squealSource) this.#startSqueal();
    if (!this.buffers.engine && !this.synth) this.#startSynth();
  }

  #loop(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  #startEngine() {
    // The recording's firing frequency: a V8 idling high, about 127 Hz.
    this.sampleFiringHz = 127;
    this.engineSource = this.#loop(this.buffers.engine);
    this.engineSource.connect(this.engineGain);
    // The same loop an octave down — weight under the top end.
    this.subGain = this.ctx.createGain();
    this.subGain.gain.value = 0;
    this.subSource = this.#loop(this.buffers.engine);
    this.subSource.connect(this.subGain);
    this.subGain.connect(this.engineGain);
    // Fade the synthesised stand-in out if it was running.
    if (this.synth) {
      this.synth.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    }
  }

  #startSqueal() {
    this.squealSource = this.#loop(this.buffers.tyres);
    this.squealSource.connect(this.squealGain);
  }

  /** A sawtooth stack, only if the recording never arrives. */
  #startSynth() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.engineGain);
    const partials = [
      { ratio: 0.5, gain: 0.5 },
      { ratio: 1, gain: 1.0 },
      { ratio: 2, gain: 0.55 },
      { ratio: 3, gain: 0.3 },
      { ratio: 4.02, gain: 0.18 },
    ];
    const oscillators = partials.map((p) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const g = ctx.createGain();
      g.gain.value = p.gain * 0.35;
      osc.connect(g);
      g.connect(gain);
      osc.start();
      return { osc, ratio: p.ratio };
    });
    this.synth = { gain, oscillators };
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

    const box = vehicle.drivetrain;
    const rpm = box.rpm;
    const spec = box.spec;
    const load = clamp(vehicle.controls.throttle, 0, 1);
    const speed = vehicle.speed;
    const revs = clamp(rpm / spec.limiterRpm, 0, 1);

    // Cut on the limiter, and through a shift, so both are audible.
    const limiting = box.limiterCut > 0 ? 0.25 : 1;
    const shifting = box.shiftTimer > 0 ? 0.35 : 1;

    /* -- engine ----------------------------------------------------------- */
    // Four-stroke: every cylinder fires once per two revolutions.
    const firingHz = (rpm / 60) * ((spec.cylinders ?? 8) / 2);

    if (this.engineSource) {
      const rate = clamp(firingHz / this.sampleFiringHz, 0.25, 6);
      this.engineSource.playbackRate.setTargetAtTime(rate, t, smooth);
      this.subSource.playbackRate.setTargetAtTime(rate * 0.5, t, smooth);
      // The octave-down copy comes in with revs and load.
      this.subGain.gain.setTargetAtTime(lerp(0.05, 0.45, revs) * lerp(0.5, 1, load), t, smooth);
      // The recording is quiet; bring it up, and let load carry the level
      // the way it does in the car.
      const level = lerp(0.9, 2.6, load) * lerp(0.75, 1, revs) * limiting * shifting;
      this.engineGain.gain.setTargetAtTime(level, t, smooth);
    } else if (this.synth) {
      for (const o of this.synth.oscillators) o.osc.frequency.setTargetAtTime(firingHz * o.ratio, t, smooth);
      this.engineGain.gain.setTargetAtTime(lerp(0.1, 0.34, load) * limiting * shifting, t, smooth);
    }

    // The filter opens with revs and throttle: closed and muffled on the
    // overrun, wide open and hard at the limiter.
    const cutoff = lerp(1100, 9000, revs) * lerp(0.55, 1, load);
    this.engineFilter.frequency.setTargetAtTime(cutoff, t, smooth);

    // Induction roar, under load only.
    this.noiseFilter.frequency.setTargetAtTime(lerp(300, 2200, revs), t, smooth);
    this.noiseGain.gain.setTargetAtTime(load * 0.06 * limiting, t, smooth);

    /* -- tyres ------------------------------------------------------------ */
    // Squeal follows the worst-sliding tyre that is still on tarmac; the
    // recording's pitch rises a little with how hard it is sliding.
    let squeal = 0;
    let slideSpeed = 0;
    for (const w of vehicle.wheels) {
      if (!w.grounded || w.surface > 2) continue;
      const s = clamp((w.slipSpeed - 2.2) / 9, 0, 1);
      if (s > squeal) {
        squeal = s;
        slideSpeed = w.slipSpeed;
      }
    }
    // Wet tarmac hisses rather than squeals.
    const wet = vehicle.track?.wetness ?? 0;
    this.squealGain.gain.setTargetAtTime(squeal * 0.55 * (1 - wet * 0.7), t, 0.06);
    if (this.squealSource) {
      this.squealSource.playbackRate.setTargetAtTime(lerp(0.9, 1.15, clamp(slideSpeed / 16, 0, 1)), t, 0.08);
    }

    /* -- wind and rain ---------------------------------------------------- */
    const gust = clamp(this.weatherWind - 0.6, 0, 1.4) * 0.05;
    const windLevel = clamp((speed - 12) / 90, 0, 1) ** 1.6 * 0.12 + gust;
    this.windGain.gain.setTargetAtTime(windLevel, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(lerp(400, 1500, clamp(speed / 90, 0, 1)), t, 0.12);

    if (wet > 0.05) {
      const spray = clamp((speed - 6) / 60, 0, 1) * wet * 0.06;
      this.rainGain.gain.setTargetAtTime(clamp(this.rain, 0, 2) * 0.055 + spray, t, 0.2);
    }

    /* -- shifts ----------------------------------------------------------- */
    if (box.gear !== this.lastGear) {
      this.#click(box.gear > this.lastGear ? 0.7 : 1.0);
      this.lastGear = box.gear;
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
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain);
    gain.connect(this.compressor);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** Impact: the recorded crash, scaled by how hard, over a low thump. */
  impact(strength) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const amount = clamp(strength, 0, 1);

    if (this.buffers.crash) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.crash;
      src.playbackRate.value = lerp(1.15, 0.85, amount);
      const gain = ctx.createGain();
      gain.gain.value = lerp(0.15, 0.9, amount);
      src.connect(gain);
      gain.connect(this.compressor);
      src.start(t);
    }

    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx, 0.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(amount * 0.4, t);
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
    this.engineSource = null;
    this.subSource = null;
    this.squealSource = null;
    this.synth = null;
    this.buffers = {};
  }
}

/**
 * Turns a recording into a loop with no click at the seam: its tail is
 * crossfaded into its head (equal power), and the tail then dropped.
 */
function seamlessLoop(ctx, buffer, seconds) {
  const fade = Math.min(Math.floor(seconds * buffer.sampleRate), Math.floor(buffer.length / 4));
  const length = buffer.length - fade;
  const out = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  // The recording is quiet; normalise so the mix has something to work with.
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const norm = peak > 0 ? Math.min(0.9 / peak, 4) : 1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < length; i++) {
      let v = src[i];
      if (i < fade) {
        const t = i / fade;
        v = src[i] * Math.sqrt(t) + src[length + i] * Math.sqrt(1 - t);
      }
      dst[i] = v * norm;
    }
  }
  return out;
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
