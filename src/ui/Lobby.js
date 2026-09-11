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
  showEntry({ name = '', code = '', notice = '', onHost, onJoin, onBack }) {
    this.clear();
    const screen = el('div', 'screen');
    const card = el('div', 'card lobby');
    card.innerHTML = `
      <h1 class="wordmark" style="font-size:32px">Race your friends</h1>
      <p class="tagline">
        Everyone's car is drawn from their own machine, straight to yours —
        there is no server in between to be slow. Up to ${MAX_DRIVERS} of you.
      </p>
      ${notice ? `<p class="hint invited">${notice}</p>` : ''}
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
  showRoom({ code, roster, isHost, session, carId, direct, diagnostics, onCar, onSession, onStart, onLeave }) {
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
      <details class="direct" data-direct>
        <summary>Not finding each other? Connect directly</summary>
        <p class="hint">
          No matchmaking network involved: you send each other one block of
          text, and the game connects straight across. This works on networks
          that block everything else. As with any direct connection, the two
          machines see each other's addresses — only send an invite to someone
          you would race anyway.
        </p>
        <div class="direct-actions">
          <button class="btn small" data-invite>Create an invite</button>
          <button class="btn small" data-have>I was sent an invite</button>
          <button class="btn ghost small" data-diag>Copy connection details</button>
        </div>
        <div class="direct-step" data-step hidden></div>
      </details>
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
    if (direct) this.#direct(card, direct, diagnostics);

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

  /**
   * The relay-free handshake, as two buttons and some copying.
   *
   * Deliberately blunt about the order of things: whoever starts it sends one
   * block of text and gets one back. Everything a person has to do is a
   * numbered step with its own box, because the failure this exists to rescue
   * — nothing happening, no explanation — is exactly what an unclear flow
   * produces more of.
   */
  #direct(card, direct, diagnostics) {
    const step = card.querySelector('[data-step]');
    const invite = card.querySelector('[data-invite]');
    const have = card.querySelector('[data-have]');
    const diag = card.querySelector('[data-diag]');

    const copy = (text, button) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      const was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = was), 1400);
    };

    diag?.addEventListener('click', () => copy(diagnostics?.() ?? '', diag));

    /** One numbered box, either something to send or something to paste. */
    const box = (n, label, { value = null, hint = '', action = null } = {}) => {
      const wrap = el('div', 'direct-box');
      wrap.innerHTML = `
        <header><span class="step-n">${n}</span><label>${label}</label></header>
        <textarea class="text-input handshake" rows="3" spellcheck="false"
                  ${value === null ? 'placeholder="Paste it here"' : 'readonly'}></textarea>
        ${hint ? `<p class="hint">${hint}</p>` : ''}
        <button class="btn small">${value === null ? action.label : 'Copy'}</button>`;
      const area = wrap.querySelector('textarea');
      const button = wrap.querySelector('button');
      if (value === null) {
        button.addEventListener('click', () => action.run(area.value, button));
      } else {
        area.value = value;
        button.addEventListener('click', () => copy(value, button));
        // Reading a thousand characters out loud is not the plan, so the
        // box selects itself for anyone whose browser refuses the clipboard.
        area.addEventListener('focus', () => area.select());
      }
      return wrap;
    };

    const show = (...nodes) => {
      step.innerHTML = '';
      step.hidden = false;
      step.append(...nodes);
    };

    const note = (text, kind = 'hint') => el('p', kind, text);

    const busy = (button, text) => {
      button.disabled = true;
      const was = button.textContent;
      button.textContent = text;
      return () => {
        button.disabled = false;
        button.textContent = was;
      };
    };

    invite.addEventListener('click', async () => {
      const done = busy(invite, 'Working…');
      try {
        const link = await direct.invite();
        show(
          box(1, 'Send this to your friend', {
            value: shareable(link.code),
            hint: 'Any message, chat or email will do — it is long, so send all ' +
              'of it. Opening it puts them straight in this room.',
          }),
          box(2, 'Paste the code they send back', {
            action: {
              label: 'Connect',
              run: async (text, button) => {
                const finish = busy(button, 'Connecting…');
                try {
                  await link.accept(text);
                  show(note('Connected. They will appear on the grid in a moment.', 'tagline'));
                } catch (err) {
                  finish();
                  step.append(note(message(err), 'hint warn'));
                }
              },
            },
          }),
        );
      } catch (err) {
        show(note(message(err), 'hint warn'));
      }
      done();
    });

    // Following an invite link lands here with the code already in hand, so
    // the first step is done for them and only the reply is left.
    this.useInvite = (code) => {
      card.querySelector('[data-direct]').open = true;
      have.click();
      const area = step.querySelector('textarea');
      area.value = code;
      step.querySelector('button').click();
    };

    have.addEventListener('click', () => {
      show(
        box(1, 'Paste the invite you were sent', {
          action: {
            label: 'Continue',
            run: async (text, button) => {
              const finish = busy(button, 'Working…');
              try {
                const reply = await direct.accept(text);
                show(
                  box(2, 'Send this back to them', {
                    value: reply,
                    hint: 'Then wait here. You will appear on each other’s grid.',
                  }),
                );
              } catch (err) {
                finish();
                step.append(note(message(err), 'hint warn'));
              }
            },
          },
        }),
      );
    });
  }

  /** Refreshes the parts of the room that change while you sit in it. */
  update({ roster = [], isHost = false, session = null, status = undefined, suggestDirect = false } = {}) {
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

    // A room that has found nobody opens the way out by itself, once. Left
    // folded away behind a heading, it is the thing a stuck player never
    // finds — and it is the thing that would have worked.
    const panel = this.node.querySelector('[data-direct]');
    if (panel && suggestDirect && !panel.dataset.nudged) {
      panel.dataset.nudged = '1';
      panel.open = true;
    }

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

/** An invite as something to send: a link where there is one, the code itself
 * where there is not — a page opened from a file has no address worth sharing. */
const shareable = (code) =>
  location.protocol.startsWith('http')
    ? `${location.origin}${location.pathname}#i=${code}`
    : code;

const message = (err) => err?.message || String(err) || 'That did not work.';
const nameOf = (id) => CIRCUITS.find((c) => c.id === id)?.name ?? '—';
const labelOf = (list, id) => list.find(([key]) => key === id)?.[1] ?? '—';
const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
