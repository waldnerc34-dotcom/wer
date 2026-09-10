import { CIRCUITS } from '../track/Layout.js';
import { formatLap } from '../game/Timing.js';
import { MAX_DRIVERS } from '../game/Multiplayer.js';

/**
 * The room: getting people into one, and showing who is in it.
 *
 * Deliberately small. There is no account to make, no server to be down, and
 * nothing to configure — one person reads five letters out, everybody types
 * them in, and the machines find each other. The code is also the key the
 * handshake is encrypted with, so it is worth not shouting across an office.
 */

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

const LAPS = [3, 5, 8, 12];

const WEATHERS = [
  ['clear', 'Clear'],
  ['overcast', 'Overcast'],
  ['rain', 'Rain'],
  ['storm', 'Storm'],
  ['fog', 'Fog'],
  ['night', 'Night'],
];

export class Lobby {
  /**
   * @param {HTMLElement} root the overlay the menu also draws into
   * @param {object} opts
   * @param {object[]} opts.cars
   */
  constructor(root, { cars }) {
    this.root = root;
    this.cars = cars;
    this.node = null;
  }

  clear() {
    this.root.innerHTML = '';
    this.node = null;
  }

  /**
   * Name yourself, then either start a room or join one.
   *
   * @param {object} opts
   * @param {string} opts.name remembered from last time
   * @param {(name: string) => void} opts.onHost
   * @param {(name: string, code: string) => void} opts.onJoin
   * @param {() => void} opts.onBack
   */
  showEntry({ name = '', code = '', onHost, onJoin, onBack }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card lobby');
    card.innerHTML = `
      <h1 class="wordmark" style="font-size:32px">Race your friends</h1>
      <p class="tagline">
        Everyone's car is drawn from their own machine, straight to yours —
        there is no server in between to be slow. Up to ${MAX_DRIVERS} of you.
      </p>
      <div class="field">
        <header><label for="lobby-name">Your name</label></header>
        <input id="lobby-name" class="text-input" maxlength="18" placeholder="Driver"
               autocomplete="off" spellcheck="false">
      </div>
      <div class="lobby-split">
        <div class="field">
          <header><label>Start a room</label></header>
          <button class="btn primary" data-host>Create a room</button>
          <p class="hint">You pick the circuit and drop the lights.</p>
        </div>
        <div class="field">
          <header><label for="lobby-code">Join a room</label></header>
          <input id="lobby-code" class="text-input code" maxlength="8" placeholder="ABCDE"
                 autocomplete="off" spellcheck="false" autocapitalize="characters">
          <button class="btn" data-join disabled>Join</button>
        </div>
      </div>
      <button class="btn ghost" data-back>Back</button>`;

    const nameInput = card.querySelector('#lobby-name');
    const codeInput = card.querySelector('#lobby-code');
    const joinBtn = card.querySelector('[data-join]');
    nameInput.value = name;
    codeInput.value = code;

    const driver = () => nameInput.value.trim() || 'Driver';
    const refresh = () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      joinBtn.disabled = codeInput.value.length < 4;
    };
    codeInput.addEventListener('input', refresh);
    refresh();

    card.querySelector('[data-host]').addEventListener('click', () => onHost(driver()));
    joinBtn.addEventListener('click', () => onJoin(driver(), codeInput.value));
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !joinBtn.disabled) onJoin(driver(), codeInput.value);
    });
    card.querySelector('[data-back]').addEventListener('click', onBack);

    screen.append(card);
    this.root.append(screen);
    this.node = card;
    nameInput.focus();
  }

  /**
   * The room itself: who is here, what everyone is driving, and — for
   * whoever is host — what everyone is about to race.
   */
  showRoom({ code, roster, isHost, session, carId, onCar, onSession, onStart, onLeave }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card lobby room');
    card.innerHTML = `
      <header class="room-head">
        <div>
          <p class="strap">Room code</p>
          <h1 class="wordmark code-big">${code}</h1>
        </div>
        <button class="btn ghost small" data-copy>Copy</button>
      </header>
      <p class="tagline" data-status></p>
      <p class="hint" data-session></p>
      <div class="field">
        <header><label>On the grid</label><span data-count></span></header>
        <ol class="grid-list" data-roster></ol>
      </div>
      <section class="field" data-field="car">
        <header><label>Your car</label><span data-sub></span></header>
        <div class="choices cards" data-cars></div>
      </section>
      <div class="host-only" data-host-only hidden>
        <section class="field"><header><label>Circuit</label></header><div class="choices outlines" data-circuits></div></section>
        <section class="field"><header><label>Weather</label></header><div class="choices chips" data-weathers></div></section>
        <section class="field"><header><label>Distance</label></header><div class="choices seg" data-laps></div></section>
      </div>
      <div class="lobby-actions">
        <button class="btn primary" data-start>Start the race</button>
        <button class="btn ghost" data-leave>Leave</button>
      </div>`;

    card.querySelector('[data-copy]').addEventListener('click', () => {
      navigator.clipboard?.writeText(code).catch(() => {});
    });
    card.querySelector('[data-leave]').addEventListener('click', onLeave);
    card.querySelector('[data-start]').addEventListener('click', onStart);

    // Cars: everyone picks their own, and the room is told at once so the
    // grid on every screen shows what people are actually in.
    const cars = card.querySelector('[data-cars]');
    for (const car of this.cars) {
      const btn = el('button', 'choice card-choice', `<b>${car.name}</b><small>${car.badge}</small>`);
      btn.dataset.id = car.id;
      btn.addEventListener('click', () => {
        for (const other of cars.children) other.classList.toggle('on', other === btn);
        onCar(car.id);
      });
      btn.classList.toggle('on', car.id === carId);
      cars.append(btn);
    }

    const pick = (host, items, value, key) => {
      host.innerHTML = '';
      for (const [id, label] of items) {
        const btn = el('button', 'choice', label);
        btn.classList.toggle('on', id === value);
        btn.addEventListener('click', () => onSession({ [key]: id }));
        host.append(btn);
      }
    };
    pick(card.querySelector('[data-circuits]'), CIRCUITS.map((c) => [c.id, c.name]), session?.circuitId, 'circuitId');
    pick(card.querySelector('[data-weathers]'), WEATHERS, session?.weather, 'weather');
    pick(card.querySelector('[data-laps]'), LAPS.map((n) => [n, `${n} laps`]), session?.laps, 'laps');

    screen.append(card);
    this.root.append(screen);
    this.node = card;
    this.update({ roster, isHost, session, status: 'Opening the room…' });
  }

  /** Refreshes the parts of the room that change while you sit in it. */
  update({ roster = [], isHost = false, session = null, status = undefined } = {}) {
    if (!this.node) return;
    const list = this.node.querySelector('[data-roster]');
    if (!list) return;

    list.innerHTML = '';
    for (const d of roster) {
      const car = this.cars.find((c) => c.id === d.carId);
      const ping = d.self ? '' : d.ping === null ? '· · ·' : `${d.ping} ms`;
      const row = el(
        'li',
        `grid-row${d.self ? ' self' : ''}`,
        `<span class="pos">${d.slot + 1}</span>
         <span class="who">${escape(d.name)}${d.host ? ' <em>host</em>' : ''}</span>
         <span class="car">${car ? escape(car.name) : '—'}</span>
         <span class="ping">${ping}</span>`,
      );
      list.append(row);
    }

    const count = this.node.querySelector('[data-count]');
    if (count) count.textContent = `${roster.length} of ${MAX_DRIVERS}`;

    const hostOnly = this.node.querySelector('[data-host-only]');
    if (hostOnly) hostOnly.hidden = !isHost;

    const start = this.node.querySelector('[data-start]');
    if (start) {
      start.disabled = !isHost;
      start.textContent = isHost
        ? roster.length > 1
          ? 'Start the race'
          : 'Start (nobody else here yet)'
        : 'Waiting for the host';
    }

    // Two separate lines, because they answer two separate questions: is the
    // network working, and what are we about to race. A room that showed only
    // the second left a player with nobody in it and nothing to go on.
    const line = this.node.querySelector('[data-status]');
    if (line && status !== null) line.textContent = status;

    const sessionLine = this.node.querySelector('[data-session]');
    if (sessionLine) {
      sessionLine.textContent = session
        ? `${nameOf(session.circuitId)} · ${labelOf(WEATHERS, session.weather)} · ${session.laps} laps`
        : 'Waiting for the host to pick a circuit.';
    }
  }

  /** A short message in place of the session line — connecting, dropped, and so on. */
  setStatus(text) {
    const line = this.node?.querySelector('[data-status]');
    if (line) line.textContent = text;
  }

  /** The standings, once a race is over. */
  results({ rows, code, onAgain, onLeave }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card lobby');
    card.innerHTML = `
      <h1 class="wordmark" style="font-size:30px">Chequered flag</h1>
      <ol class="grid-list results">
        ${rows
          .map(
            (r, i) => `<li class="grid-row${r.self ? ' self' : ''}">
              <span class="pos">${i + 1}</span>
              <span class="who">${escape(r.name)}</span>
              <span class="car">${r.laps} laps</span>
              <span class="ping">${r.best ? formatLap(r.best) : '—'}</span>
            </li>`,
          )
          .join('')}
      </ol>
      <p class="tagline">Room <b>${code}</b> is still open.</p>
      <div class="lobby-actions">
        <button class="btn primary" data-again>Back to the room</button>
        <button class="btn ghost" data-leave>Leave</button>
      </div>`;
    card.querySelector('[data-again]').addEventListener('click', onAgain);
    card.querySelector('[data-leave]').addEventListener('click', onLeave);
    screen.append(card);
    this.root.append(screen);
    this.node = card;
  }
}

const nameOf = (id) => CIRCUITS.find((c) => c.id === id)?.name ?? '—';
const labelOf = (list, id) => list.find(([key]) => key === id)?.[1] ?? '—';
const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
