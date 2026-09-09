import './ui/style.css';

import { TouchControls } from './core/Touch.js';
import { Game } from './game/Game.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';

const canvas = document.getElementById('viewport');
const hudRoot = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const touchRoot = document.getElementById('touch');

// Coarse pointer = finger. This is what decides on-screen controls, not the
// user agent string, so a tablet with a keyboard attached still gets them.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
document.documentElement.classList.toggle('is-touch', IS_TOUCH);

const menu = new Menu(overlay, { touch: IS_TOUCH });
let game = null;
let hud = null;
let touch = null;
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
  // Everything that needs a user gesture happens right here, on the tap.
  if (IS_TOUCH) await enterImmersive();

  menu.showLoading();

  try {
    if (game) {
      game.dispose();
      game = null;
    }
    if (touch) {
      touch.dispose();
      touch = null;
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

    if (IS_TOUCH) {
      touch = new TouchControls(touchRoot, {
        onCamera: () => game?.camera.cycle(),
        onReset: () => game?.respawn(),
        onPause: () => (paused ? resume() : pause()),
        onLookBack: (held) => {
          if (game) game.touchLookBack = held;
        },
      });
      if (selection.steering === 'tilt') {
        const ok = await touch.enableTilt();
        if (!ok) console.warn('Tilt steering unavailable; using the touch slider.');
      }
      game.setTouch(touch);
    }

    await game.load(selection);

    hud = new HUD(hudRoot, game.track);
    hudRoot.classList.remove('hidden');
    touch?.setVisible(true);
    document.body.classList.add('playing');
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
  touch?.setVisible(false);
  menu.showPause({
    state: game.state(),
    assists: {
      ...game.player.assists,
      invertSteer: game.input.invertSteer,
      racingLine: game.showRacingLine,
    },
    onToggleAssist: (key, value) => {
      if (key === 'invertSteer') game.input.setInvertSteer(value);
      else if (key === 'racingLine') game.setRacingLine(value);
      else game.player.assists[key] = value;
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
          touch?.dispose();
          touch = null;
          hudRoot.innerHTML = '';
          hudRoot.classList.add('hidden');
          document.body.classList.remove('playing');
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
  touch?.setVisible(true);
  game.setPaused(false);
}

/* -------------------------------------------------------------- immersive -- */

/**
 * Fullscreen and a landscape lock, where the platform allows it. iPhones
 * allow neither from a web page, which is what the rotate overlay is for.
 */
async function enterImmersive() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    /* not available — fine */
  }
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    /* not available — fine */
  }
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
