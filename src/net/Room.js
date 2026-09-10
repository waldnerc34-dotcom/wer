import { joinRoom, selfId } from 'trystero';

import { KIND, SNAPSHOT_BYTES, readPing, readState, writePing, writeState } from './Snapshot.js';
import { Sync } from './Sync.js';

/**
 * Peer-to-peer plumbing for a race.
 *
 * There is no game server. Trystero finds the other players through public
 * relays — it passes nothing but the WebRTC handshake through them, encrypted
 * with a key derived from the room code — and after that every packet goes
 * straight from one player's machine to another's. Two friends on the same
 * street get the latency of the street rather than the latency of whichever
 * data centre a server would have been in.
 *
 * Two channels, because a race needs two different promises kept:
 *
 *   · Trystero's own channel is reliable and ordered. Who is here, what car
 *     they picked, when the lights go out, what they just lapped in. Losing
 *     any of that is unrecoverable, and none of it is urgent.
 *
 *   · A second channel, opened on the same connection, is neither. Car state
 *     goes down it twenty times a second and is never retransmitted. A
 *     reliable channel would hold every later packet behind a lost one until
 *     the retransmission arrived — one dropped datagram would freeze a car
 *     for a round trip and then teleport it. That is precisely the stutter
 *     people call lag, and it is the default behaviour you get for free if
 *     you do not think about it.
 */

/** Namespaces the relay traffic, so other Trystero apps never collide with us. */
const APP_ID = 'apex-racing-9f63';

/** Label of the unreliable channel. Both ends must agree. */
const RT_LABEL = 'apex-rt';

/** How often to re-measure the clock difference to each peer. */
const SYNC_INTERVAL = 1200;

/** Room codes people have to read out loud, so no O/0 or I/1. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < 5; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

/** A room code as typed, in the form the network uses. */
export function normaliseCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .slice(0, 8);
}

export class Room {
  /**
   * @param {object} opts
   * @param {string} opts.code room code, as typed
   * @param {(peerId: string) => void} [opts.onJoin]
   * @param {(peerId: string) => void} [opts.onLeave]
   * @param {(peerId: string, state: object, offset: number) => void} [opts.onState]
   */
  constructor({ code, onJoin, onLeave, onState, onError } = {}) {
    this.code = normaliseCode(code);
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.onState = onState;
    this.onError = onError;
    this.selfId = selfId;

    this.room = null;
    this.channels = new Map(); // peerId -> RTCDataChannel
    this.sync = new Map(); // peerId -> Sync
    this.actions = new Map();
    this.handlers = new Map();
    this.joined = false;

    // One timebase for everything sent. performance.now() counts from when
    // the page loaded, which is a different moment on every machine, so it is
    // shifted to when this room opened and the difference is measured.
    this.epoch = performance.now();
    this.seq = 0;
    this.pingId = 0;
    this.pending = new Map();

    this.out = new DataView(new ArrayBuffer(SNAPSHOT_BYTES));
    this.probe = new DataView(new ArrayBuffer(16));
  }

  /** Milliseconds since this room opened, the stamp on everything we send. */
  now() {
    return performance.now() - this.epoch;
  }

  join() {
    if (this.room) return this.room;
    // The code doubles as the encryption password, so the handshake passing
    // through a public relay is meaningless to anyone who does not have it.
    this.room = joinRoom({ appId: APP_ID, password: `apex:${this.code}` }, `race-${this.code}`);
    this.joined = true;

    for (const [name, handler] of this.handlers) this.#bind(name, handler);

    // Properties rather than methods: Trystero calls whatever is assigned
    // here, and assigning over them is the documented way to listen.
    this.room.onPeerJoin = (peerId) => {
      this.sync.set(peerId, new Sync());
      this.#openChannel(peerId);
      this.onJoin?.(peerId);
    };

    this.room.onPeerLeave = (peerId) => {
      this.channels.get(peerId)?.close();
      this.channels.delete(peerId);
      this.sync.delete(peerId);
      this.onLeave?.(peerId);
    };

    this.timer = setInterval(() => this.#syncAll(), SYNC_INTERVAL);
    return this.room;
  }

  leave() {
    clearInterval(this.timer);
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
    this.sync.clear();
    this.actions.clear();
    this.room?.leave().catch(() => {});
    this.room = null;
    this.joined = false;
  }

  get peerIds() {
    return this.room ? Object.keys(this.room.getPeers()) : [];
  }

  /** Round-trip time to a peer in milliseconds, or null before it is known. */
  pingTo(peerId) {
    const s = this.sync.get(peerId);
    return s?.settled ? Math.round(s.rtt) : null;
  }

  /* ------------------------------------------------------- reliable side */

  /**
   * Registers a handler for a reliable message, and returns a sender.
   *
   * Safe to call before joining: handlers are bound when the room opens.
   */
  action(name, handler) {
    this.handlers.set(name, handler);
    if (this.room) this.#bind(name, handler);
    return (payload, target) => {
      const action = this.actions.get(name);
      // `target` is a peer id, or undefined for everybody. Sending is a
      // promise; a peer that vanished mid-send is not worth an unhandled
      // rejection.
      action?.send(payload, target ? { target } : undefined).catch(() => {});
    };
  }

  #bind(name, handler) {
    if (this.actions.has(name)) return;
    const action = this.room.makeAction(name);
    this.actions.set(name, action);
    action.onMessage = (payload, context) => handler(payload, context?.peerId);
  }

  /* ----------------------------------------------------- unreliable side */

  /**
   * Opens the car-state channel to one peer.
   *
   * Both ends would otherwise open one and end up with two, so the peer with
   * the lower id offers and the other one listens. The connection's SCTP
   * association is already up by the time a peer counts as joined — Trystero
   * needed it for its own channel — so an extra channel needs no
   * renegotiation and is live almost immediately.
   */
  #openChannel(peerId) {
    const pc = this.room.getPeers()[peerId];
    if (!pc) return;

    // addEventListener rather than onchannel: Trystero is using the property
    // for its own channel and assigning over it would cut the room's legs off.
    pc.addEventListener('datachannel', (event) => {
      if (event.channel.label === RT_LABEL) this.#adopt(peerId, event.channel);
    });

    if (this.selfId < peerId) {
      const ch = pc.createDataChannel(RT_LABEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      this.#adopt(peerId, ch);
    }
  }

  #adopt(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', (event) => this.#receive(peerId, event.data));
    channel.addEventListener('close', () => {
      if (this.channels.get(peerId) === channel) this.channels.delete(peerId);
    });
    channel.addEventListener('error', () => this.channels.delete(peerId));
    this.channels.set(peerId, channel);
  }

  #receive(peerId, data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    const view = new DataView(data);
    const kind = view.getUint8(0);

    if (kind === KIND.STATE) {
      const sync = this.sync.get(peerId);
      // Before the clocks are compared there is no sensible place to put a
      // snapshot on our own timeline, so it is dropped. This lasts one round
      // trip at the start of a session.
      if (!sync?.settled) return;
      this.onState?.(peerId, readState(view, 0), sync.offset);
      return;
    }

    if (kind === KIND.PING) {
      const { id, t } = readPing(view);
      const n = writePing(this.probe, KIND.PONG, id, t);
      // Their stamp goes back untouched and ours rides in the tail, so they
      // can work out both the round trip and the midpoint from one reply.
      this.probe.setFloat64(n, this.now());
      this.#raw(peerId, this.probe.buffer.slice(0, n + 8));
      return;
    }

    if (kind === KIND.PONG) {
      const { id, t } = readPing(view);
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      const now = this.now();
      const theirs = view.getFloat64(13);
      const rtt = now - t;
      // Their clock read `theirs` when ours read `now - rtt/2`, so this is
      // what to add to one of their stamps to land it on our timeline.
      this.sync.get(peerId)?.add(now - rtt / 2 - theirs, rtt);
    }
  }

  #syncAll() {
    for (const peerId of this.channels.keys()) {
      const id = ++this.pingId;
      this.pending.set(id, peerId);
      // A probe nobody answered is not worth remembering.
      setTimeout(() => this.pending.delete(id), 4000);
      const n = writePing(this.probe, KIND.PING, id, this.now());
      this.#raw(peerId, this.probe.buffer.slice(0, n));
    }
  }

  #raw(peerId, buffer) {
    const ch = this.channels.get(peerId);
    if (ch?.readyState !== 'open') return;
    try {
      ch.send(buffer);
    } catch {
      /* a channel that closed mid-frame is not worth a stack trace */
    }
  }

  /**
   * Sends our car to everyone, once.
   *
   * @param {object} state everything but `seq` and `t`, which are added here
   */
  broadcastState(state) {
    if (!this.channels.size) return;
    state.seq = ++this.seq;
    state.t = Math.round(this.now());
    writeState(this.out, 0, state);
    for (const peerId of this.channels.keys()) this.#raw(peerId, this.out.buffer.slice(0));
  }
}
