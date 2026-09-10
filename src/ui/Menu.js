import { Assets } from '../core/Assets.js';
import { CIRCUITS, buildCentreline } from '../track/Layout.js';
import { CARS } from '../physics/Vehicle.js';
import { ASSIST_LEVELS } from '../game/Assist.js';
import { WEATHERS } from '../game/Weather.js';
import { QUALITY } from '../render/Renderer.js';
import { formatLap } from '../game/Timing.js';

/**
 * Front end: the start screen, the loading screen, the pause menu and the
 * end-of-session results. Plain DOM rendered into one overlay element, laid
 * out like a race programme: the wordmark and the vitals on the left, the
 * entry form on the right — cars as photographs, circuits as their own
 * outlines, the weather as a row of chips.
 */
export class Menu {
  constructor(root, { touch = false, cars = CARS } = {}) {
    this.root = root;
    this.touch = touch;
    this.cars = cars;
    this.selection = {
      circuitId: CIRCUITS[0].id,
      carId: cars[0].id,
      mode: 'time-trial',
      // Braking help starts on: knowing where to brake is the thing a
      // circuit teaches last, and the arrows plus a car that brakes for you
      // is how someone learns it without spending a session in the gravel.
      assist: 'high',
      quality: guessQuality(touch),
      // Three AI cars is plenty for a phone's CPU; five on a desktop.
      opponents: touch ? 3 : 5,
      steering: 'touch',
      weather: 'clear',
    };
    this.outlines = new Map();
  }

  clear() {
    this.root.innerHTML = '';
    if (this.tipTimer) clearInterval(this.tipTimer);
  }

  /* ------------------------------------------------------------- main menu */

  /** @param {(selection: object) => void} onStart */
  showStart(onStart) {
    this.clear();
    const screen = el('div', 'screen start');

    const ghost = el('div', 'backdrop');
    ghost.innerHTML = `<svg class="ghost-track" viewBox="0 0 120 72" preserveAspectRatio="xMidYMid meet"><path d=""/></svg>`;
    screen.append(ghost);

    const hero = el('aside', 'hero');
    hero.innerHTML = `
      <div class="mark">${MARK}</div>
      <h1 class="wordmark">AP<em>EX</em></h1>
      <p class="strap">Racing simulator</p>
      <p class="tagline">
        Real downloaded cars on a Pacejka tyre model, raycast suspension and
        honest aerodynamics. Five circuits, six weathers, and arrows on the
        road that show you the line.
      </p>
      <ul class="stats">
        <li><b>${this.cars.length}</b>cars</li>
        <li><b>${CIRCUITS.length}</b>circuits</li>
        <li><b>${WEATHERS.length}</b>weathers</li>
        <li><b>240<small>Hz</small></b>physics</li>
      </ul>
      <div class="keys" data-keys>
        <div><b>W S</b> throttle · brake</div>
        <div><b>A D</b> steer</div>
        <div><b>Space</b> handbrake</div>
        <div><b>Q E</b> shift</div>
        <div><b>V</b> camera</div>
        <div><b>C</b> look behind</div>
        <div><b>R</b> rejoin</div>
        <div><b>Esc</b> pause</div>
      </div>`;

    const picker = el('main', 'picker');
    picker.innerHTML = `
      <section class="field" data-field="car"><header><label>Car</label><span data-sub></span></header><div class="choices cards"></div></section>
      <section class="field" data-field="circuit"><header><label>Circuit</label><span data-sub></span></header><div class="choices outlines"></div></section>
      <section class="field" data-field="weather"><header><label>Weather</label><span data-sub></span></header><div class="choices chips"></div></section>
      <section class="field" data-field="assist"><header><label>Braking help</label><span data-sub></span></header><div class="choices seg"></div></section>
      <div class="row2">
        <section class="field" data-field="mode"><label>Session</label><div class="choices seg"></div></section>
        <section class="field" data-field="quality"><label>Graphics</label><div class="choices seg"></div></section>
        <section class="field" data-field="steering" hidden><label>Steering</label><div class="choices seg"></div></section>
      </div>
      <div class="actions">
        <button class="go" data-start><span>Go racing</span><i>›</i></button>
        <span class="hint" data-hint>Keyboard or gamepad · W A S D to drive</span>
      </div>`;

    screen.append(hero, picker);
    this.root.append(screen);

    const ghostPath = ghost.querySelector('path');
    const showGhost = (id) => {
      ghostPath.setAttribute('d', this.#outline(CIRCUITS.find((c) => c.id === id)).d);
    };

    this.#choices(picker, 'car', 'car', this.cars.map((c) => ({
      id: c.id,
      label: c.name,
      note: c.badge,
      image: Assets.urlFor(`thumbs/${c.id}.webp`),
    })), (v) => (this.selection.carId = v), this.selection.carId);

    this.#choices(picker, 'circuit', 'circuit', CIRCUITS.map((c) => ({
      id: c.id,
      label: c.name,
      note: c.country,
      svg: this.#outline(c).svg,
    })), (v) => {
      this.selection.circuitId = v;
      showGhost(v);
    }, this.selection.circuitId);
    showGhost(this.selection.circuitId);

    this.#choices(picker, 'weather', 'chip', WEATHERS.map((w) => ({
      id: w.id,
      label: w.label,
      note: w.note,
      svg: GLYPHS[w.id] ?? GLYPHS.clear,
    })), (v) => (this.selection.weather = v), this.selection.weather);

    this.#choices(picker, 'assist', 'seg', ASSIST_LEVELS.map((a) => ({
      id: a.id,
      label: a.label,
      note: a.note,
    })), (v) => (this.selection.assist = v), this.selection.assist);

    this.#choices(picker, 'mode', 'seg', [
      { id: 'time-trial', label: 'Time trial', note: 'Empty circuit, chase the clock' },
      { id: 'race', label: 'Race', note: `${this.selection.opponents} AI drivers` },
    ], (v) => (this.selection.mode = v), this.selection.mode);

    this.#choices(picker, 'quality', 'seg', Object.entries(QUALITY).map(([id, q]) => ({
      id,
      label: q.label,
      note: qualityNote(id),
    })), (v) => (this.selection.quality = v), this.selection.quality);

    if (this.touch) {
      // Phones: on-screen controls, and the keyboard legend is just noise.
      hero.querySelector('[data-keys]').hidden = true;
      picker.querySelector('[data-hint]').textContent = 'Turn your phone sideways · touch or tilt to steer';
      picker.querySelector('[data-field="steering"]').hidden = false;
      this.#choices(picker, 'steering', 'seg', [
        { id: 'touch', label: 'Thumb', note: 'Drag anywhere on the left' },
        { id: 'tilt', label: 'Tilt', note: 'Hold the phone like a wheel' },
      ], (v) => (this.selection.steering = v), this.selection.steering);
    }

    picker.querySelector('[data-start]').addEventListener('click', () => {
      onStart({ ...this.selection });
    });
  }

  /**
   * Renders one row of choices.
   * @param {'car'|'circuit'|'chip'|'seg'} kind
   */
  #choices(card, field, kind, items, onPick, initial) {
    const section = card.querySelector(`[data-field="${field}"]`);
    const host = section.querySelector('.choices');
    const sub = section.querySelector('[data-sub]');
    const describe = (item) => {
      if (sub) sub.textContent = item.note ?? '';
    };
    for (const item of items) {
      const b = el('button', `choice ${kind}`);
      b.type = 'button';
      if (kind === 'car') {
        b.innerHTML = `${item.image ? `<img src="${item.image}" alt="" loading="lazy" />` : ''}<div class="plate"><div class="name">${item.label}</div><small>${item.note ?? ''}</small></div>`;
      } else if (kind === 'circuit') {
        b.innerHTML = `${item.svg}<div class="name">${item.label}</div><small>${item.note ?? ''}</small>`;
      } else if (kind === 'chip') {
        b.innerHTML = `${item.svg}<span class="name">${item.label}</span><small>${item.note ?? ''}</small>`;
      } else {
        b.innerHTML = `<div class="name">${item.label}</div>${item.note ? `<small>${item.note}</small>` : ''}`;
      }
      b.setAttribute('aria-pressed', String(item.id === initial));
      if (item.id === initial) describe(item);
      b.addEventListener('click', () => {
        for (const sib of host.children) sib.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        describe(item);
        onPick(item.id);
      });
      host.append(b);
    }
  }

  /** The circuit drawn from its own layout, fitted to a 120×72 box. */
  #outline(circuit) {
    if (this.outlines.has(circuit.id)) return this.outlines.get(circuit.id);
    const pts = buildCentreline(circuit.segments, { step: 8 });
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of pts) {
      minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
      minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z);
    }
    const pad = 6;
    const sc = Math.min((120 - 2 * pad) / (maxx - minx + 1e-6), (72 - 2 * pad) / (maxz - minz + 1e-6));
    const ox = (120 - (maxx - minx) * sc) / 2;
    const oz = (72 - (maxz - minz) * sc) / 2;
    // +X is the driver's left when heading +Z: flip X so the map reads from above.
    const X = (x) => (ox + (maxx - x) * sc).toFixed(1);
    const Y = (z) => (72 - oz - (z - minz) * sc).toFixed(1);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)} ${Y(p.z)}`).join(' ') + ' Z';
    const start = pts[0];
    const out = {
      d,
      svg: `<svg viewBox="0 0 120 72" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${d}"/><circle cx="${X(start.x)}" cy="${Y(start.z)}" r="2.6"/></svg>`,
    };
    this.outlines.set(circuit.id, out);
    return out;
  }

  /* --------------------------------------------------------------- loading */

  showLoading() {
    this.clear();
    const screen = el('div', 'screen');
    screen.innerHTML = `
      <div class="loading">
        <h1 class="wordmark">AP<em>EX</em></h1>
        <div class="bar"><i data-bar></i></div>
        <div class="loading-note" data-note>Preparing…</div>
        <div class="tip" data-tip></div>
      </div>`;
    this.root.append(screen);
    this.bar = screen.querySelector('[data-bar]');
    this.note = screen.querySelector('[data-note]');
    const tip = screen.querySelector('[data-tip]');
    let i = Math.floor(Math.random() * TIPS.length);
    tip.innerHTML = TIPS[i];
    this.tipTimer = setInterval(() => {
      i = (i + 1) % TIPS.length;
      tip.innerHTML = TIPS[i];
    }, 3600);
  }

  setProgress(fraction, label) {
    if (this.bar) this.bar.style.width = `${Math.round(fraction * 100)}%`;
    if (this.note && label) this.note.textContent = label;
  }

  /* ----------------------------------------------------------------- pause */

  showPause({ onResume, onRestart, onQuit, state, assists, onToggleAssist, onAssistLevel }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card');
    card.innerHTML = `
      <h1 class="wordmark">Paused</h1>
      <p class="tagline">${state.carName} · ${state.trackName} · ${state.weather ?? ''}</p>
      <div class="field" data-field="assist"><header><label>Braking help</label><span data-sub></span></header><div class="choices seg"></div></div>
      <div class="field" data-field="assists"><label>Driver aids</label><div class="choices seg"></div></div>
      <p class="legend"><span><i style="background:#5ef08a"></i>accelerate</span><span><i style="background:#f4d43a"></i>ease off</span><span><i style="background:#ff5a4a"></i>brake</span></p>
      <div class="actions">
        <button class="btn" data-resume>Resume</button>
        <button class="btn ghost" data-restart>Restart session</button>
        <button class="btn ghost" data-quit>Change car / circuit</button>
      </div>`;

    this.#choices(card, 'assist', 'seg', ASSIST_LEVELS.map((a) => ({
      id: a.id,
      label: a.label,
      note: a.note,
    })), (v) => onAssistLevel?.(v), state.assist ?? 'high');

    const host = card.querySelector('[data-field="assists"] .choices');
    const toggles = [
      ['abs', 'ABS'],
      ['tractionControl', 'Traction control'],
      ['stability', 'Stability control'],
      ['autoShift', 'Automatic gearbox'],
      ['invertSteer', 'Invert steering'],
      ['racingLine', 'Pacing arrows'],
    ];
    for (const [key, label] of toggles) {
      const b = el('button', 'choice toggle');
      b.type = 'button';
      b.innerHTML = `<span class="sw"></span><span class="name">${label}</span>`;
      b.setAttribute('aria-pressed', String(Boolean(assists[key])));
      b.addEventListener('click', () => {
        const next = !(b.getAttribute('aria-pressed') === 'true');
        b.setAttribute('aria-pressed', String(next));
        onToggleAssist(key, next);
      });
      host.append(b);
    }

    card.querySelector('[data-resume]').addEventListener('click', onResume);
    card.querySelector('[data-restart]').addEventListener('click', onRestart);
    card.querySelector('[data-quit]').addEventListener('click', onQuit);
    screen.append(card);
    this.root.append(screen);
  }

  /* --------------------------------------------------------------- results */

  showResults({ laps, bestLap, trackName, carName, onClose }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card results');
    const rows = laps.length
      ? laps
          .map(
            (l, i) =>
              `<tr><td>Lap ${i + 1}</td><td class="${
                l.invalid ? 'invalid' : l.time === bestLap ? 'best' : ''
              }">${formatLap(l.time)}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="2">No completed laps</td></tr>';

    card.innerHTML = `
      <h1 class="wordmark">Session</h1>
      <p class="tagline">${carName} · ${trackName}</p>
      <table>${rows}</table>
      <div class="actions"><button class="btn" data-close>Back to the pits</button></div>`;
    card.querySelector('[data-close]').addEventListener('click', onClose);
    screen.append(card);
    this.root.append(screen);
  }
}

function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

/** Rough guess at what the machine can handle, so first load looks right. */
function guessQuality(touch) {
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = touch || /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (mobile) return 'mobile';
  if (mem <= 4 || cores <= 4) return 'low';
  if (mem <= 8 || cores <= 8) return 'medium';
  // Ultra is never guessed: it supersamples to 4K, which is a choice a
  // player makes, not one to spring on them. Dynamic resolution will hold
  // the frame rate either way.
  return 'high';
}

function qualityNote(id) {
  return {
    mobile: 'Phones and tablets',
    low: 'No AO, fewer trees',
    medium: 'AO, motion blur, SMAA',
    high: 'Ray-traced reflections',
    ultra: 'Renders at 4K, resolves down',
  }[id];
}

const TIPS = [
  '<b>Green</b> arrows: accelerate. <b>Yellow</b>: ease off. <b>Red</b>: brake.',
  'The arrows sit on the racing line — wide in, clip the apex, wide out.',
  'Trail-braking into a downhill corner loads the front and lightens the rear.',
  'Tyres have a working window: cold ones slide, overheated ones give up.',
  'In the rain the braking zones start earlier — the arrows already know.',
  'A tow down the straight is free speed; the turbulence into the braking zone is not.',
  'Press <b>R</b> if you end up in the gravel. Lap invalidated, dignity restored.',
  'Kerbs are raised and ridged. The inside ones are yours; the outside ones bite.',
];

/** The app mark, inline so the start screen needs no fetch. */
const MARK = `<svg viewBox="0 0 512 512" aria-hidden="true">
  <defs>
    <linearGradient id="mbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2f36"/><stop offset="1" stop-color="#0b0c0f"/></linearGradient>
    <linearGradient id="mch" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5a3c"/><stop offset="1" stop-color="#d81e1e"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#mbg)"/>
  <g transform="rotate(-32 256 256)"><rect x="-80" y="430" width="700" height="46" fill="#e8e6e1"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${-80 + i * 60}" y="430" width="30" height="46" fill="#c8271f"/>`).join('')}</g>
  <path d="M 256 118 L 396 296 L 342 296 L 256 190 L 170 296 L 116 296 Z" fill="url(#mch)"/>
  <path d="M 256 232 L 340 338 L 286 338 L 256 300 L 226 338 L 172 338 Z" fill="url(#mch)" opacity="0.92"/>
</svg>`;

/** Weather glyphs, stroked in the current colour. */
const GLYPHS = {
  clear: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>`,
  overcast: `<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.5A3.5 3.5 0 0 0 7 18z"/></svg>`,
  rain: `<svg viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.5A3.5 3.5 0 0 0 7 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>`,
  storm: `<svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.5A3.5 3.5 0 0 0 7 14z"/><path d="M13 14l-2.5 4h3L11 22"/></svg>`,
  fog: `<svg viewBox="0 0 24 24"><path d="M4 10h12M6 14h14M4 18h10"/></svg>`,
  night: `<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
};
