import { CIRCUITS } from '../track/Layout.js';
import { CARS } from '../physics/Vehicle.js';
import { QUALITY } from '../render/Renderer.js';
import { formatLap } from '../game/Timing.js';

/**
 * Front end: the start screen, the loading screen, the pause menu and the
 * end-of-session results. All plain DOM rendered into one overlay element.
 */
export class Menu {
  constructor(root) {
    this.root = root;
    this.selection = {
      circuitId: CIRCUITS[0].id,
      carId: CARS[0].id,
      mode: 'time-trial',
      quality: guessQuality(),
      opponents: 5,
    };
  }

  clear() {
    this.root.innerHTML = '';
  }

  /* ------------------------------------------------------------- main menu */

  /** @param {(selection: object) => void} onStart */
  showStart(onStart) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card');

    card.innerHTML = `
      <h1 class="wordmark">APEX</h1>
      <p class="tagline">
        A physically-based racing simulator. Pacejka tyre model, raycast suspension,
        a limited-slip differential and real aerodynamics — driving downloaded
        supercar models under captured HDRI lighting.
      </p>
      <div class="field" data-field="car"><label>CAR</label><div class="choices"></div></div>
      <div class="field" data-field="circuit"><label>CIRCUIT</label><div class="choices"></div></div>
      <div class="field" data-field="mode"><label>SESSION</label><div class="choices"></div></div>
      <div class="field" data-field="quality"><label>GRAPHICS</label><div class="choices"></div></div>
      <div class="actions">
        <button class="btn" data-start>Go racing</button>
        <span class="loading-note" data-hint>Keyboard or gamepad · W A S D to drive</span>
      </div>
      <div class="keys">
        <div><b>W / S</b> throttle · brake</div>
        <div><b>A / D</b> steer</div>
        <div><b>Space</b> handbrake</div>
        <div><b>Q / E</b> manual shift</div>
        <div><b>V</b> change camera</div>
        <div><b>C</b> look behind</div>
        <div><b>R</b> rejoin the circuit</div>
        <div><b>L</b> headlights</div>
        <div><b>Esc</b> pause</div>
      </div>
    `;

    this.#choices(card, 'car', CARS.map((c) => ({
      id: c.id,
      label: c.name,
      note: c.badge,
    })), (v) => (this.selection.carId = v), this.selection.carId);

    this.#choices(card, 'circuit', CIRCUITS.map((c) => ({
      id: c.id,
      label: c.name,
      note: c.country,
    })), (v) => (this.selection.circuitId = v), this.selection.circuitId);

    this.#choices(card, 'mode', [
      { id: 'time-trial', label: 'Time trial', note: 'Empty circuit, chase the clock' },
      { id: 'race', label: 'Race', note: 'Five AI drivers, rolling start' },
    ], (v) => (this.selection.mode = v), this.selection.mode);

    this.#choices(card, 'quality', Object.entries(QUALITY).map(([id, q]) => ({
      id,
      label: q.label,
      note: qualityNote(id),
    })), (v) => (this.selection.quality = v), this.selection.quality);

    card.querySelector('[data-start]').addEventListener('click', () => {
      onStart({ ...this.selection });
    });

    screen.append(card);
    this.root.append(screen);
  }

  #choices(card, field, items, onPick, initial) {
    const host = card.querySelector(`[data-field="${field}"] .choices`);
    for (const item of items) {
      const b = el('button', 'choice');
      b.type = 'button';
      b.innerHTML = `${item.label}${item.note ? `<small>${item.note}</small>` : ''}`;
      b.setAttribute('aria-pressed', String(item.id === initial));
      b.addEventListener('click', () => {
        for (const sib of host.children) sib.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        onPick(item.id);
      });
      host.append(b);
    }
  }

  /* --------------------------------------------------------------- loading */

  showLoading() {
    this.clear();
    const screen = el('div', 'screen');
    screen.innerHTML = `
      <div class="loading">
        <h1 class="wordmark">APEX</h1>
        <div class="bar"><i data-bar></i></div>
        <div class="loading-note" data-note>Preparing…</div>
      </div>`;
    this.root.append(screen);
    this.bar = screen.querySelector('[data-bar]');
    this.note = screen.querySelector('[data-note]');
  }

  setProgress(fraction, label) {
    if (this.bar) this.bar.style.width = `${Math.round(fraction * 100)}%`;
    if (this.note && label) this.note.textContent = label;
  }

  /* ----------------------------------------------------------------- pause */

  showPause({ onResume, onRestart, onQuit, state, assists, onToggleAssist }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card');
    card.style.width = 'min(560px, 92vw)';
    card.innerHTML = `
      <h1 class="wordmark" style="font-size:38px">Paused</h1>
      <p class="tagline">${state.carName} · ${state.trackName}</p>
      <div class="field" data-field="assists"><label>DRIVER AIDS</label><div class="choices"></div></div>
      <div class="actions">
        <button class="btn" data-resume>Resume</button>
        <button class="btn ghost" data-restart>Restart session</button>
        <button class="btn ghost" data-quit>Change car / circuit</button>
      </div>`;

    const host = card.querySelector('.choices');
    const toggles = [
      ['abs', 'ABS'],
      ['tractionControl', 'Traction control'],
      ['autoShift', 'Automatic gearbox'],
    ];
    for (const [key, label] of toggles) {
      const b = el('button', 'choice');
      b.type = 'button';
      b.textContent = label;
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
      <h1 class="wordmark" style="font-size:38px">Session</h1>
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
function guessQuality() {
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (mobile || mem <= 4 || cores <= 4) return 'low';
  if (mem <= 8 || cores <= 8) return 'medium';
  return 'high';
}

function qualityNote(id) {
  return {
    low: 'No AO, fewer trees',
    medium: 'AO, motion blur, SMAA',
    high: '4K shadows, full scenery',
  }[id];
}
