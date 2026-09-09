import './ui/style.css';

import { Game } from './game/Game.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';

const canvas = document.getElementById('viewport');
const hudRoot = document.getElementById('hud');
const overlay = document.getElementById('overlay');

const menu = new Menu(overlay);
let game = null;
let hud = null;
let paused = false;

/* ------------------------------------------------------------------ boot -- */

function fail(message, detail) {
  overlay.innerHTML = `
    <div class="screen"><div class="card" style="width:min(560px,92vw)">
      <h1 class="wordmark" style="font-size:34px">Can't start</h1>
      <p class="tagline">${message}</p>
      ${detail ? `<pre class="loading-note" style="white-space:pre-wrap">${detail}</pre>` : ''}
    </div></div>`;
}

if (!supportsWebGL2()) {
  fail('APEX needs WebGL2. Try a current version of Chrome, Edge, Firefox or Safari.');
} else {
  menu.showStart(start);
}

/* ----------------------------------------------------------------- start -- */

async function start(selection) {
  menu.showLoading();

  try {
    if (game) {
      game.dispose();
      game = null;
    }

    game = new Game(canvas, {
      quality: selection.quality,
      onProgress: (p, label) => menu.setProgress(p, label),
      onState: (state) => {
        if (!hud) return;
        state.playerPosition = game.player.position;
        hud.update(
          state,
          game.opponents.map((o) => o.vehicle.position),
        );
      },
    });

    await game.load(selection);

    hud = new HUD(hudRoot, game.track);
    hudRoot.classList.remove('hidden');
    menu.clear();

    game.start();
    resumeAudioOnGesture();
  } catch (err) {
    console.error(err);
    fail('Something went wrong while building the session.', String(err?.stack ?? err));
  }
}

/* ----------------------------------------------------------------- pause -- */

window.addEventListener('keydown', (e) => {
  if (!game || !game.running) return;
  if (e.code !== 'Escape' && e.code !== 'KeyP') return;
  e.preventDefault();
  paused ? resume() : pause();
});

function pause() {
  paused = true;
  game.setPaused(true);
  hudRoot.classList.add('hidden');
  menu.showPause({
    state: game.state(),
    assists: game.player.assists,
    onToggleAssist: (key, value) => {
      game.player.assists[key] = value;
    },
    onResume: resume,
    onRestart: () => {
      game.restart();
      resume();
    },
    onQuit: () => {
      const { laps, bestLap } = game.timer;
      const s = game.state();
      game.stop();
      game.setPaused(true);
      menu.showResults({
        laps,
        bestLap,
        trackName: s.trackName,
        carName: s.carName,
        onClose: () => {
          game.dispose();
          game = null;
          hud = null;
          hudRoot.innerHTML = '';
          hudRoot.classList.add('hidden');
          paused = false;
          menu.showStart(start);
        },
      });
    },
  });
}

function resume() {
  paused = false;
  menu.clear();
  hudRoot.classList.remove('hidden');
  game.setPaused(false);
}

/* ----------------------------------------------------------------- audio -- */

function resumeAudioOnGesture() {
  const kick = () => {
    game?.audio.start();
    game?.audio.resume();
    window.removeEventListener('pointerdown', kick);
    window.removeEventListener('keydown', kick);
  };
  window.addEventListener('pointerdown', kick, { once: false });
  window.addEventListener('keydown', kick, { once: false });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game?.running && !paused) pause();
});

function supportsWebGL2() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch {
    return false;
  }
}

// Handy for debugging from the console.
window.APEX = { get game() { return game; } };
