import { clamp, lerp } from '../core/MathUtils.js';
import { formatDelta, formatLap } from '../game/Timing.js';

const TYRE_LABELS = ['FL', 'FR', 'RL', 'RR'];

/**
 * The driving overlay.
 *
 * Plain DOM and one small canvas for the track map. Everything is written
 * through cached element references and only touched when the value it shows
 * actually changes, so the HUD costs nothing measurable per frame.
 */
export class HUD {
  constructor(root, track) {
    this.root = root;
    this.track = track;
    this.cache = new Map();
    this.needle = 0;
    root.innerHTML = TEMPLATE;

    this.el = {
      speed: root.querySelector('[data-speed]'),
      gear: root.querySelector('[data-gear]'),
      rpmFill: root.querySelector('[data-rpm-fill]'),
      rpmTicks: root.querySelector('[data-rpm-ticks]'),
      lap: root.querySelector('[data-lap]'),
      lapTime: root.querySelector('[data-lap-time]'),
      lastLap: root.querySelector('[data-last-lap]'),
      bestLap: root.querySelector('[data-best-lap]'),
      delta: root.querySelector('[data-delta]'),
      corner: root.querySelector('[data-corner]'),
      pace: root.querySelector('[data-pace]'),
      autobrake: root.querySelector('[data-autobrake]'),
      position: root.querySelector('[data-position]'),
      warn: root.querySelector('[data-warn]'),
      tyres: root.querySelector('[data-tyres]'),
      map: root.querySelector('[data-map]'),
      gauge: root.querySelector('[data-gauge]'),
      sectors: root.querySelector('[data-sectors]'),
      fps: root.querySelector('[data-fps]'),
      throttleBar: root.querySelector('[data-throttle]'),
      brakeBar: root.querySelector('[data-brake]'),
      gmeter: root.querySelector('[data-gmeter]'),
      callout: root.querySelector('[data-callout]'),
      result: root.querySelector('[data-result]'),
      resultRows: root.querySelector('[data-result-rows]'),
      resultNote: root.querySelector('[data-result-note]'),
    };

    this.#buildTicks();
    this.#buildTyres();
    this.#prepareMap();
  }

  /* ------------------------------------------------------------- one-time */

  #buildTicks() {
    const ticks = [];
    for (let i = 0; i <= 10; i++) {
      const a = lerp(-138, 138, i / 10);
      ticks.push(
        `<line x1="0" y1="-60" x2="0" y2="${i % 2 ? -54 : -50}" transform="rotate(${a})"
           stroke="${i >= 9 ? '#ff3b30' : 'rgba(255,255,255,.55)'}" stroke-width="${i % 2 ? 1.2 : 2}" />`,
      );
    }
    this.el.rpmTicks.innerHTML = ticks.join('');
  }

  #buildTyres() {
    this.el.tyres.innerHTML = TYRE_LABELS.map(
      (l) => `<div class="tyre"><span class="tyre-label">${l}</span>
        <div class="tyre-body"><i data-fill></i></div>
        <span class="tyre-temp">--</span></div>`,
    ).join('');
    this.tyreEls = [...this.el.tyres.querySelectorAll('.tyre')].map((n) => ({
      fill: n.querySelector('[data-fill]'),
      temp: n.querySelector('.tyre-temp'),
      body: n.querySelector('.tyre-body'),
    }));
  }

  /** Pre-renders the circuit outline; only the car dots move each frame. */
  #prepareMap() {
    const canvas = this.el.map;
    const size = 132;
    canvas.width = size * 2;
    canvas.height = size * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    this.mapCtx = ctx;
    this.mapSize = size;

    const t = this.track;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < t.count; i++) {
      minX = Math.min(minX, t.pos[i * 3]);
      maxX = Math.max(maxX, t.pos[i * 3]);
      minZ = Math.min(minZ, t.pos[i * 3 + 2]);
      maxZ = Math.max(maxZ, t.pos[i * 3 + 2]);
    }
    const pad = 12;
    const scale = Math.min((size - pad * 2) / (maxX - minX), (size - pad * 2) / (maxZ - minZ));
    const ox = (size - (maxX - minX) * scale) / 2;
    const oz = (size - (maxZ - minZ) * scale) / 2 - minZ * scale;
    // Seen from above with the car's right at −X, screen-right is −X: mirror
    // the map so a right-hander bends right on it too.
    this.mapProject = (x, z) => [(maxX - x) * scale + ox, z * scale + oz];

    // Bake the outline into an offscreen canvas.
    const base = document.createElement('canvas');
    base.width = size * 2;
    base.height = size * 2;
    const b = base.getContext('2d');
    b.scale(2, 2);
    b.lineJoin = 'round';
    b.lineCap = 'round';
    b.beginPath();
    for (let i = 0; i <= t.count; i++) {
      const j = i % t.count;
      const [x, y] = this.mapProject(t.pos[j * 3], t.pos[j * 3 + 2]);
      i === 0 ? b.moveTo(x, y) : b.lineTo(x, y);
    }
    b.strokeStyle = 'rgba(255,255,255,.14)';
    b.lineWidth = 6;
    b.stroke();
    b.strokeStyle = 'rgba(190,215,255,.65)';
    b.lineWidth = 2;
    b.stroke();

    // Start/finish tick.
    const [sx, sy] = this.mapProject(t.pos[0], t.pos[2]);
    b.fillStyle = '#fff';
    b.fillRect(sx - 2.5, sy - 2.5, 5, 5);

    this.mapBase = base;
  }

  /* ---------------------------------------------------------------- update */

  #set(key, el, value) {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    el.textContent = value;
  }

  update(state, opponents = []) {
    const e = this.el;

    this.#set('speed', e.speed, String(Math.round(state.speedKph)));
    this.#set(
      'gear',
      e.gear,
      state.gear === 0 ? 'N' : state.gear < 0 ? 'R' : String(state.gear),
    );

    // Tachometer sweep.
    const rev = clamp(state.rpm / state.limiterRpm, 0, 1);
    const angle = lerp(-138, 138, rev);
    e.rpmFill.style.transform = `rotate(${angle}deg)`;
    e.gauge.classList.toggle('redline', rev > 0.92);

    // Timing. In a race the lap counter reads against the distance, because
    // "lap 4" means nothing until you know whether there are five or twelve.
    this.#set(
      'lap',
      e.lap,
      state.raceLaps
        ? `LAP ${Math.min(Math.max(state.lap, 1), state.raceLaps)}/${state.raceLaps}`
        : `LAP ${Math.max(state.lap, 1)}`,
    );

    // The starter, and the flag.
    this.#callout(state);
    this.#result(state);
    this.#set('lapTime', e.lapTime, formatLap(state.lapTime));
    this.#set('last', e.lastLap, formatLap(state.lastLap));
    this.#set('best', e.bestLap, formatLap(state.bestLap));

    if (state.delta === null || state.delta === undefined) {
      this.#set('delta', e.delta, '');
      e.delta.className = 'delta';
    } else {
      this.#set('delta', e.delta, formatDelta(state.delta));
      e.delta.className = `delta ${state.delta <= 0 ? 'up' : 'down'}`;
    }

    this.#set(
      'sectors',
      e.sectors,
      state.sectors.map((s) => (s ? s.toFixed(2) : '—')).join('  ·  '),
    );
    this.#set('corner', e.corner, state.corner ?? '');

    // What the arrows on the road are saying right here, as words.
    const pace = state.racingLine === false ? -1 : state.pace ?? -1;
    this.#set('pace', e.pace, PACE_LABELS[pace] ?? '');
    e.pace.className = `pace p${pace}`;
    // Say so when the car is braking for the driver rather than with them,
    // otherwise the pedal moving on its own is a mystery.
    e.autobrake.classList.toggle('on', (state.assistBraking ?? 0) > 0.05);
    this.#set(
      'position',
      e.position,
      state.opponents ? `P${state.position} / ${state.opponents + 1}` : 'TIME TRIAL',
    );

    // Warnings.
    const warn = state.invalid ? 'LAP INVALIDATED' : state.offTrack ? 'OFF TRACK' : '';
    this.#set('warn', e.warn, warn);
    e.warn.classList.toggle('visible', Boolean(warn));

    // Pedals.
    e.throttleBar.style.transform = `scaleY(${state.throttle.toFixed(3)})`;
    e.brakeBar.style.transform = `scaleY(${state.brake.toFixed(3)})`;

    // G meter.
    const gx = clamp(state.gLat / 2.2, -1, 1) * 26;
    const gy = clamp(-state.gLong / 2.2, -1, 1) * 26;
    e.gmeter.style.transform = `translate(${gx.toFixed(1)}px, ${gy.toFixed(1)}px)`;

    // Tyres: colour by temperature, height by grip used.
    for (let i = 0; i < 4; i++) {
      const t = state.tyres[i];
      const el = this.tyreEls[i];
      el.fill.style.height = `${clamp(t.slip, 0, 1) * 100}%`;
      el.fill.style.background = tyreColour(t.temp);
      this.#set(`tt${i}`, el.temp, `${Math.round(t.temp)}°`);
      el.body.classList.toggle('locked', t.lockup > 0.4 || t.spin > 0.4);
    }

    // Own up to the resolution: the number of pixels being drawn is not the
    // size of the window, and on Ultra it is deliberately larger.
    // ...and to whatever it had to give up to draw them, on the same line.
    // As its own element it sat on top of this one, which is a diagnostic
    // obscuring the diagnostic it belongs with.
    const r = state.render;
    this.#set(
      'fps',
      e.fps,
      [
        `${Math.round(state.fps)} fps`,
        r ? `${Math.round(r.x)}×${Math.round(r.y)}` : null,
        state.detail,
      ]
        .filter(Boolean)
        .join(' · '),
    );

    // The minimap is a full canvas repaint. Twenty times a second is more
    // than enough for a dot crawling around a circuit, and it gives the rest
    // of the frame back.
    this.mapClock = (this.mapClock ?? 0) + 1;
    if (this.mapClock % 3 === 0) this.#drawMap(state, opponents);
  }

  /** The big number over the middle of the screen on the way to lights out. */
  #callout(state) {
    const e = this.el;
    const text = state.callout ?? '';
    if (this.cache.get('callout') === text) return;
    this.cache.set('callout', text);
    e.callout.textContent = text;
    e.callout.className = `callout${text ? ' on' : ''}${text === 'GO' ? ' go' : ''}`;
    // Restarting the animation needs the element out of the document flow for
    // a frame; toggling the class alone will not replay it.
    if (text) {
      e.callout.style.animation = 'none';
      void e.callout.offsetWidth;
      e.callout.style.animation = '';
    }
  }

  /** The classification, once somebody has completed the distance. */
  #result(state) {
    const e = this.el;
    const shown = Boolean(state.classification);
    if (this.cache.get('result') === shown) return;
    this.cache.set('result', shown);
    e.result.hidden = !shown;
    if (!shown) return;

    e.resultRows.innerHTML = state.classification
      .map(
        (c) => `<div class="result-row${c.isPlayer ? ' you' : ''}">
          <span class="result-pos">${c.position}</span>
          <span class="result-name">${c.name}</span>
          <span class="result-best">${formatLap(c.best ?? 0)}</span>
        </div>`,
      )
      .join('');
    const me = state.classification.find((c) => c.isPlayer);
    const ordinal = ['', '1st', '2nd', '3rd'][me?.position] ?? `${me?.position}th`;
    e.resultNote.textContent =
      (me?.position === 1 ? `Won it — ${ordinal}` : `Finished ${ordinal}`) +
      (state.reaction !== null && state.reaction !== undefined
        ? ` · ${state.reaction.toFixed(3)} s off the line`
        : '');
  }

  #drawMap(state, opponents) {
    const ctx = this.mapCtx;
    const size = this.mapSize;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.mapBase, 0, 0, size, size);

    for (const o of opponents) {
      const [x, y] = this.mapProject(o.x, o.z);
      ctx.fillStyle = 'rgba(255,190,90,.9)';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state.playerPosition) {
      const [x, y] = this.mapProject(state.playerPosition.x, state.playerPosition.z);
      ctx.fillStyle = '#4ade80';
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  setVisible(v) {
    this.root.classList.toggle('hidden', !v);
  }
}

/** Blue when cold, green in the window, red when overheating. */
function tyreColour(temp) {
  if (temp < 60) return '#3b82f6';
  if (temp < 78) return '#22d3ee';
  if (temp < 105) return '#4ade80';
  if (temp < 125) return '#facc15';
  return '#ef4444';
}

/** Indexed by the pacing phase: accelerate, hold, brake. */
const PACE_LABELS = ['ACCELERATE', 'EASE OFF', 'BRAKE'];

const TEMPLATE = /* html */ `
<div class="hud-top">
  <div class="panel timing">
    <div class="row"><span data-lap class="lap">LAP 1</span><span data-position class="pos"></span></div>
    <div data-lap-time class="lap-time">--:--.---</div>
    <div class="row small"><span>LAST</span><span data-last-lap>--:--.---</span></div>
    <div class="row small"><span>BEST</span><span data-best-lap>--:--.---</span></div>
    <div class="row small sectors"><span data-sectors>—  ·  —  ·  —</span></div>
  </div>
  <div class="centre">
    <div data-delta class="delta"></div>
    <div data-pace class="pace"></div>
    <div data-autobrake class="autobrake">AUTO BRAKE</div>
    <div data-corner class="corner"></div>
    <div data-warn class="warn"></div>
    <div data-callout class="callout"></div>
  </div>
  <div class="panel map-panel">
    <canvas data-map class="map"></canvas>
    <div data-fps class="fps"></div>
  </div>
</div>

<div class="hud-bottom">
  <div class="panel tyres-panel">
    <div class="panel-title">TYRES</div>
    <div data-tyres class="tyres"></div>
  </div>

  <div data-gauge class="gauge">
    <svg viewBox="-80 -80 160 160" class="dial">
      <circle r="66" class="dial-bg" />
      <g data-rpm-ticks></g>
      <path d="M -40.1 44.6 A 60 60 0 1 1 40.1 44.6" class="dial-arc" />
      <g data-rpm-fill class="needle-group">
        <polygon points="-2.2,-2 2.2,-2 1,-58 -1,-58" class="needle" />
      </g>
      <circle r="5" class="hub" />
    </svg>
    <div class="readout">
      <div data-speed class="speed">0</div>
      <div class="unit">KM/H</div>
    </div>
    <div data-gear class="gear">N</div>
  </div>

  <div class="panel inputs-panel">
    <div class="pedals">
      <div class="pedal"><i data-throttle class="fill throttle"></i><span>T</span></div>
      <div class="pedal"><i data-brake class="fill brake"></i><span>B</span></div>
    </div>
    <div class="gbox"><div class="gcross"></div><i data-gmeter class="gdot"></i></div>
  </div>
</div>

<div data-result class="result" hidden>
  <div class="result-card">
    <div class="result-title">Chequered flag</div>
    <div data-result-rows class="result-rows"></div>
    <div data-result-note class="result-note"></div>
    <div class="result-hint">Esc for the pause menu</div>
  </div>
</div>
`;
