import './ui/style.css';

import { TouchControls } from './core/Touch.js';
import { Game, availableCars } from './game/Game.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { Lobby } from './ui/Lobby.js';
import { NameTags } from './ui/NameTags.js';
import { Multiplayer, makeRoomCode } from './game/Multiplayer.js';
import { peek } from './net/Direct.js';
import { Records, aidCode } from './game/Records.js';

const canvas = document.getElementById('viewport');
const hudRoot = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const touchRoot = document.getElementById('touch');

// Coarse pointer = finger. This is what decides on-screen controls, not the
// user agent string, so a tablet with a keyboard attached still gets them.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
document.documentElement.classList.toggle('is-touch', IS_TOUCH);

const menu = new Menu(overlay, { touch: IS_TOUCH, cars: availableCars() });
const lobby = new Lobby(overlay, { cars: availableCars() });
const records = new Records();
let game = null;
let hud = null;
let touch = null;
let paused = false;

/** The room, while there is one. Null the rest of the time. */
let net = null;
let roster = [];
let lastSelection = null;
let tags = null;

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
} else if (inviteInUrl()) {
  followInvite(inviteInUrl());
} else {
  menu.showStart(start, { records, onMultiplayer: openLobby });
}

/** An invite somebody sent as a link, if this page was opened from one. */
function inviteInUrl() {
  const match = /[#&?]i=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  return match?.[1] ? `APEX1-${match[1].replace(/^APEX1-/, '')}` : null;
}

/**
 * Opening an invite link.
 *
 * It carries the room it belongs to and one half of a connection, so all that
 * is missing is a name. The link is taken out of the address bar on the way
 * past: a handshake is good once, and a reloaded page would try to use it
 * again and quietly fail.
 */
async function followInvite(code) {
  const payload = await peek(code).catch(() => null);
  history.replaceState(null, '', location.pathname + location.search);

  if (!payload) {
    menu.showStart(start, { records, onMultiplayer: openLobby });
    return;
  }
  lobby.showEntry({
    name: records.driver,
    code: payload.room ?? '',
    notice:
      'You have been invited to a race. Put your name in and join — this ' +
      'connects straight to their machine, with no matchmaking network in ' +
      'between, so it works on networks that block the ordinary way in.',
    onBack: () => {
      lobby.clear();
      menu.showStart(start, { records, onMultiplayer: openLobby });
    },
    onHost: (name) => enterRoom(name, makeRoomCode()),
    onJoin: (name, room) => enterRoom(name, room, { invite: code }),
  });
}

// Installable, and playable offline once everything has been fetched once.
// Only for a served build: the dev server rewrites modules on the fly, and a
// single-file page has nothing to cache.
// The single-file build carries everything already and has no sw.js to fetch.
if (import.meta.env.PROD && !globalThis.APEX_ASSETS && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered:', err));
  });
}

/* ------------------------------------------------------------ the room -- */

/**
 * Opens the multiplayer flow: name yourself, then host or join.
 *
 * Everything about a room is deliberately reversible. Leaving one drops the
 * connections and puts the ordinary start screen back; nothing is stored
 * anywhere but in this tab.
 */
function openLobby() {
  lobby.showEntry({
    name: records.driver,
    onBack: () => {
      lobby.clear();
      menu.showStart(start, { records, onMultiplayer: openLobby });
    },
    onHost: (name) => enterRoom(name, makeRoomCode()),
    onJoin: (name, code) => enterRoom(name, code),
  });
}

/**
 * The handles the room screen needs for the relay-free handshake, and for
 * saying what the connection is actually doing.
 */
function roomTools() {
  return {
    direct: {
      invite: () => net.invite(),
      accept: (code) => net.acceptInvite(code),
    },
    diagnostics: () => net.diagnostics(),
  };
}

function enterRoom(name, code, { invite = null } = {}) {
  records.driver = name;
  let carId = lastSelection?.carId ?? availableCars()[0].id;

  const refreshRoom = () => {
    if (!net) return;
    lobby.update({
      roster: net.roster(),
      isHost: net.isHost,
      session: net.session,
      status: net.describe(),
      suggestDirect: net.stalled,
    });
  };

  net = new Multiplayer({
    code,
    identity: () => ({ name: records.driver, carId }),
    onRoster: (rows) => {
      roster = rows;
      refreshRoom();
    },
    onSession: refreshRoom,
    onStatus: refreshRoom,
    onGo: (at, hold) => beginRace(at, hold),
    onRecords: (circuit, rows) => {
      // A friend's board arrives when they join, and is kept: the point of a
      // record is that it stands there afterwards with their name on it.
      if (records.merge(circuit, rows)) {
        lobby.update({ roster, isHost: net.isHost, session: net.session });
      }
    },
  });

  // The room is drawn first and connected second, so that a network which
  // cannot reach the relays leaves the player looking at a room with a
  // message in it rather than at nothing at all.
  if (net.isHost && !net.session) {
    net.setSession({
      circuitId: lastSelection?.circuitId ?? 'apex',
      weather: lastSelection?.weather ?? 'clear',
      laps: 5,
      quality: lastSelection?.quality,
    });
  }

  lobby.showRoom({
    code,
    roster: net.roster(),
    isHost: net.isHost,
    session: net.session,
    carId,
    ...roomTools(),
    onCar: (id) => {
      carId = id;
      net.refreshIdentity();
    },
    onSession: (patch) => net.setSession({ ...net.session, ...patch }),
    onStart: () => net.start(),
    onLeave: leaveRoom,
  });

  // Someone followed an invite link. The handshake it carries is independent
  // of the relays, so this runs whether or not they are reachable.
  if (invite) lobby.useInvite?.(invite);

  try {
    net.join();
  } catch (err) {
    console.warn('Could not reach the matchmaking relays:', err);
    lobby.setStatus('Could not open the room: ' + (err?.message ?? err));
  }

  // The board for whatever circuit we are on goes out once, so everybody's
  // records are on everybody's screen.
  const shareBoard = () => {
    const circuit = net.session?.circuitId;
    if (circuit) net.shareRecords(circuit, records.mine(circuit, records.driver));
  };
  shareBoard();
  net.onPeerJoined = shareBoard;

  // Ping figures move on their own; nothing else in the room does.
  clearInterval(lobby.timer);
  lobby.timer = setInterval(refreshRoom, 1500);
}

function leaveRoom() {
  clearInterval(lobby.timer);
  net?.leave();
  net = null;
  roster = [];
  lobby.clear();
  menu.showStart(start, { records, onMultiplayer: openLobby });
}

/** The host dropped the lights: load the session, then run it in step. */
async function beginRace(at, hold) {
  const session = net?.session;
  if (!session) return;
  const me = net.roster().find((r) => r.self);
  const others = net.roster().filter((r) => !r.self);

  await start({
    carId: me?.carId ?? availableCars()[0].id,
    circuitId: session.circuitId,
    weather: session.weather,
    quality: session.quality ?? lastSelection?.quality ?? 'high',
    assist: lastSelection?.assist ?? 'high',
    mode: 'race',
    laps: session.laps,
    opponents: 0,
    steering: lastSelection?.steering,
    net,
    remotes: others,
    slot: me?.slot ?? 0,
  });

  if (game) {
    game.raceStart = at;
    game.raceHold = hold;
    // A remote car's lap counter comes over the wire, not from a timer that
    // is watching it — without this the running order would have everyone
    // still on lap one.
    net.onLap = (peerId, lap) => {
      const o = game.opponents.find((car) => car.remote?.id === peerId);
      if (o) o.timer.lap = lap.n;
    };
  }
}

/* ----------------------------------------------------------------- start -- */

async function start(selection) {
  lastSelection = selection;
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
      // The graphics driver reset the GPU. Say so, remember a preset that
      // asks less of it, and offer the one thing that can recover: a reload,
      // since a lost context takes every texture and shader with it.
      onContextLost: () => {
        const safer = selection.quality === 'ultra' ? 'high' : 'medium';
        try {
          localStorage.setItem('apex.quality.fallback', safer);
        } catch {
          /* private browsing; the message still stands */
        }
        hudRoot.classList.add('hidden');
        touch?.setVisible(false);
        game?.setPaused(true);
        menu.showError({
          title: 'Graphics reset',
          body: 'Your graphics driver gave up on this preset and reset the GPU, which leaves the picture black. Reloading will start you on a setting it can hold.',
          actionLabel: 'Reload',
          onAction: () => location.reload(),
        });
      },
      // The simulation threw, three frames running. Without this the page
      // just goes black and stays there: the HUD is still on screen, frozen
      // at its opening values, and nothing says why.
      onFault: (error) => {
        hudRoot.classList.add('hidden');
        touch?.setVisible(false);
        menu.showError({
          title: 'The session stopped',
          body: `Something in the simulation went wrong and the frame could not be finished: ${
            error?.message ?? error
          }. Reloading will start a fresh session.`,
          actionLabel: 'Reload',
          onAction: () => location.reload(),
        });
      },
      onState: (state) => {
        if (!hud) return;
        state.playerPosition = game.player.position;
        hud.update(
          state,
          game.opponents.map((o) => o.vehicle.position),
        );
        // Names over the people, so you know whose mirrors you are in.
        if (tags) {
          tags.update(
            game.opponents
              .filter((o) => o.remote)
              .map((o) => ({
                id: o.remote.id,
                name: o.name,
                vehicle: o.vehicle,
                visible: o.remote.visible,
              })),
            game.renderer.camera,
            { width: canvas.clientWidth, height: canvas.clientHeight },
          );
        }
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

    // Every clean lap goes on the board, under the name the driver gave, with
    // the aids they used written next to it.
    game.onLapDone = (lap) => {
      if (!lap.valid) return;
      const filed = records.submit({
        circuit: selection.circuitId,
        car: selection.carId,
        weather: selection.weather,
        driver: records.driver || 'Driver',
        aids: aidCode({
          assist: selection.assist,
          stability: game.player.assists.stability,
          abs: game.player.assists.abs,
        }),
        lap: lap.time,
        sectors: lap.sectors,
      });
      // A quicker lap replaces the one you were racing against, so the ghost
      // you meet next session is the best you have ever done here.
      if (filed.improved && lap.trace) {
        records.saveGhost(selection.circuitId, selection.carId, lap.trace);
      }
      // A new personal best is worth the room knowing about immediately.
      if (filed.improved && net) {
        net.shareRecords(selection.circuitId, records.mine(selection.circuitId, records.driver));
      }
    };

    await game.load({
      ...selection,
      // Your own best lap of this circuit in this car, if there is one to race.
      myGhost:
        selection.ghost === 'mine'
          ? records.loadGhost(selection.circuitId, selection.carId)
          : null,
    });

    hud = new HUD(hudRoot, game.track);
    tags?.dispose();
    tags = selection.remotes?.length ? new NameTags(hudRoot) : null;
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
    onAssistLevel: (level) => game.setAssist(level),
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
          tags?.dispose();
          tags = null;
          // Back to the room if there still is one, so a race can be run
          // again without everybody rejoining.
          if (net) {
            lobby.showRoom({
              code: net.code,
              roster: net.roster(),
              isHost: net.isHost,
              session: net.session,
              carId: lastSelection?.carId,
              ...roomTools(),
              onCar: (id) => {
                lastSelection = { ...lastSelection, carId: id };
                net.refreshIdentity();
              },
              onSession: (patch) => net.setSession({ ...net.session, ...patch }),
              onStart: () => net.start(),
              onLeave: leaveRoom,
            });
          } else {
            menu.showStart(start, { records, onMultiplayer: openLobby });
          }
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
