import { joinRoom as joinNostr, selfId } from 'trystero';

import { KIND, SNAPSHOT_BYTES, readPing, readState, writePing, writeState } from './Snapshot.js';
import { Sync } from './Sync.js';

/**
 * Peer-to-peer plumbing for a race.
 *
 * There is no game server. Two people who type the same five letters have to
 * find each other somehow, and that introduction is the only thing the outside
 * world is used for: a public relay carries the WebRTC handshake — encrypted
 * with a key derived from the code, so it is meaningless to the relay — and
 * after that every packet goes straight from one machine to another. Two
 * friends on the same street get the latency of the street.
 *
 * The introduction is the fragile part, and it is fragile for reasons that
 * have nothing to do with this code: the relays are volunteer infrastructure,
 * and office networks, school networks and some mobile carriers block one kind
 * or another. So it is attempted over three unrelated kinds of network at
 * once — Nostr relays, MQTT brokers and BitTorrent trackers — and any one of
 * them working is enough. Trystero gives the same person the same peer id on
 * every strategy, so somebody who arrives down two of them at once is
 * recognisably one person rather than two.
 *
 * Once introduced, none of the traffic goes near a relay. Both channels below
 * are opened directly on the connection:
 *
 *   · `apex-rel` is reliable and ordered. Who is here, what car they picked,
 *     when the lights go out, what they just lapped in. Losing any of that is
 *     unrecoverable and none of it is urgent.
 *
 *   · `apex-rt` is neither. Car state goes down it twenty times a second and
 *     is never retransmitted. A reliable channel would hold every later packet
 *     behind a lost one until the retransmission arrived — freezing a car for
 *     a round trip and then teleporting it, which is precisely the stutter
 *     people call lag, and is the default you get for free if you do not think
 *     about it.
 */

/** Namespaces the relay traffic, so other Trystero apps never collide with us. */
const APP_ID = 'apex-racing-9f63';

const RT_LABEL = 'apex-rt';
const REL_LABEL = 'apex-rel';

/**
 * The ways two machines can be introduced.
 *
 * Unrelated on purpose: different protocols, on different ports, run by
 * different people. A network that blocks one rarely blocks all three.
 *
 * Only the first is part of the bundle. The other two carry a whole MQTT
 * client and a whole BitTorrent tracker client between them — around 370 KB
 * that somebody driving on their own would be paying for nothing — so they
 * are fetched at the moment a room is opened and not before.
 */
export const TRANSPORTS = [
  { id: 'nostr', label: 'Nostr', load: async () => joinNostr },
  {
    id: 'mqtt',
    label: 'MQTT',
    load: async () => (await import('@trystero-p2p/mqtt')).joinRoom,
  },
  {
    id: 'torrent',
    label: 'BitTorrent',
    load: async () => (await import('@trystero-p2p/torrent')).joinRoom,
  },
];

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
   * @param {(status: object) => void} [opts.onStatus]
   */
  constructor({ code, onJoin, onLeave, onState, onStatus, transports = TRANSPORTS } = {}) {
    this.code = normaliseCode(code);
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.onState = onState;
    this.onStatus = onStatus;
    this.selfId = selfId;
    // Injectable so that the whole of this file can be exercised against a
    // relay on localhost. The public ones cannot be reached from a test
    // machine behind a strict egress policy, and discovery is exactly the
    // part that most needs testing.
    this.transports = transports;

    /** transport id -> the Trystero room for it */
    this.rooms = new Map();
    /** peerId -> {transports:Set, channels:{rt:Set, rel:Set}, sync:Sync} */
    this.peers = new Map();
    this.handlers = new Map();
    this.joined = false;

    /** What each way of being introduced is doing, for the room to show. */
    this.transportState = new Map(this.transports.map((t) => [t.id, 'idle']));

    // One timebase for everything sent. performance.now() counts from when the
    // page loaded, which is a different moment on every machine, so it is
    // shifted to when this room opened and the difference is measured.
    this.epoch = performance.now();
    this.seq = 0;
    this.pingId = 0;
    this.pending = new Map();

    this.out = new DataView(new ArrayBuffer(SNAPSHOT_BYTES));
    this.probe = new DataView(new ArrayBuffer(24));
  }

  /** Milliseconds since this room opened, the stamp on everything we send. */
  now() {
    return performance.now() - this.epoch;
  }

  /** What to tell the player: how the introduction is going, and who is here. */
  status() {
    const joined = [];
    const failed = [];
    for (const t of this.transports) {
      const state = this.transportState.get(t.id);
      if (state === 'joined') joined.push(t.label);
      else if (state === 'failed') failed.push(t.label);
    }
    let connected = 0;
    for (const peer of this.peers.values()) if (this.#open(peer, 'rel')) connected++;
    return {
      networks: joined.length,
      total: this.transports.length,
      failed,
      peers: this.peers.size,
      connected,
    };
  }

  /**
   * Opens the room on every kind of network at once.
   *
   * Not awaited by the caller: the first strategy is already in the bundle
   * and joins immediately, and the other two arrive a moment later without
   * anybody waiting on a blank screen for them.
   */
  join() {
    if (this.joined) return;
    this.joined = true;
    this.timer = setInterval(() => this.#syncAll(), SYNC_INTERVAL);
    for (const transport of this.transports) this.#joinOne(transport);
    this.#status();
  }

  async #joinOne(transport) {
    // The code doubles as the encryption password, so the handshake passing
    // through a public relay is meaningless to anyone who does not have it.
    const config = { appId: APP_ID, password: `apex:${this.code}` };
    const roomId = `race-${this.code}`;

    try {
      const join = await transport.load();
      // Left the room while this was being fetched.
      if (!this.joined) return;
      const room = join(config, roomId, {
        onJoinError: (details) => {
          this.transportState.set(transport.id, 'failed');
          console.warn(`[apex] ${transport.label} refused the room:`, details?.error);
          this.#status();
        },
      });
      room.onPeerJoin = (peerId) => this.#peerUp(peerId, transport.id, room);
      room.onPeerLeave = (peerId) => this.#peerDown(peerId, transport.id);
      this.rooms.set(transport.id, room);
      this.transportState.set(transport.id, 'joined');
    } catch (err) {
      // One kind of network being unreachable is expected and survivable.
      // It is only fatal if every one of them is.
      this.transportState.set(transport.id, 'failed');
      console.warn(`[apex] could not reach ${transport.label}:`, err);
    }
    this.#status();
  }

  leave() {
    clearInterval(this.timer);
    for (const peer of this.peers.values()) this.#closePeer(peer);
    this.peers.clear();
    for (const room of this.rooms.values()) {
      try {
        room.leave()?.catch?.(() => {});
      } catch {
        /* already gone */
      }
    }
    this.rooms.clear();
    this.joined = false;
  }

  get peerIds() {
    return [...this.peers.keys()];
  }

  /** How many people are in the room, us not counted. */
  get peerCount() {
    return this.peers.size;
  }

  /** The clock comparison for one peer, or null if they are not here. */
  syncFor(peerId) {
    return this.peers.get(peerId)?.sync ?? null;
  }

  /** Round-trip time to a peer in milliseconds, or null before it is known. */
  pingTo(peerId) {
    const sync = this.peers.get(peerId)?.sync;
    return sync?.settled ? Math.round(sync.rtt) : null;
  }

  /* --------------------------------------------------------------- peers */

  #peerUp(peerId, transportId, room) {
    let peer = this.peers.get(peerId);
    const fresh = !peer;
    if (!peer) {
      peer = {
        id: peerId,
        transports: new Set(),
        channels: { rt: new Set(), rel: new Set() },
        sync: new Sync(),
        // A peer counts as joined the moment Trystero's own channel connects,
        // which is before ours have finished opening. Anything said in that
        // window — and the first thing said to a newcomer is who we are and
        // what we are driving — would otherwise go straight in the bin, and
        // they would sit in the room as an unnamed row forever.
        outbox: [],
      };
      this.peers.set(peerId, peer);
    }
    peer.transports.add(transportId);

    // Channels are opened on every connection to this person, not only the
    // first: the two machines need not agree on which introduction arrived
    // first, and a channel on a connection nobody uses costs nothing.
    const pc = room.getPeers()[peerId];
    if (pc) this.#openChannels(peerId, peer, pc);

    if (fresh) this.onJoin?.(peerId);
    this.#status();
  }

  #peerDown(peerId, transportId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.transports.delete(transportId);
    // Still here down another introduction: not a departure.
    if (peer.transports.size) return;

    this.#closePeer(peer);
    this.peers.delete(peerId);
    this.onLeave?.(peerId);
    this.#status();
  }

  #closePeer(peer) {
    for (const kind of ['rt', 'rel']) {
      for (const ch of peer.channels[kind]) {
        try {
          ch.close();
        } catch {
          /* already closed */
        }
      }
      peer.channels[kind].clear();
    }
  }

  /**
   * Opens our two channels on one connection to one person.
   *
   * Both ends would otherwise open a pair each and end up with four, so the
   * peer with the lower id offers and the other one listens. The connection's
   * SCTP association is already up by the time a peer counts as joined —
   * Trystero needed it for its own channel — so extra channels need no
   * renegotiation and are live almost immediately.
   */
  #openChannels(peerId, peer, pc) {
    // A connection reached through two introductions is still one connection.
    if (pc.__apexWired) return;
    pc.__apexWired = true;

    // addEventListener rather than the ondatachannel property: Trystero is
    // using that for its own channel, and assigning over it would cut the
    // room's legs off.
    pc.addEventListener('datachannel', (event) => {
      const { label } = event.channel;
      if (label === RT_LABEL) this.#adopt(peer, 'rt', event.channel);
      else if (label === REL_LABEL) this.#adopt(peer, 'rel', event.channel);
    });

    if (this.selfId < peerId) {
      this.#adopt(
        peer,
        'rt',
        pc.createDataChannel(RT_LABEL, { ordered: false, maxRetransmits: 0 }),
      );
      this.#adopt(peer, 'rel', pc.createDataChannel(REL_LABEL));
    }
  }

  #adopt(peer, kind, channel) {
    channel.binaryType = 'arraybuffer';
    peer.channels[kind].add(channel);
    channel.addEventListener('open', () => {
      if (kind === 'rel') this.#flush(peer);
      this.#status();
    });
    channel.addEventListener('message', (event) =>
      kind === 'rt' ? this.#binary(peer.id, peer, event.data) : this.#reliable(peer.id, event.data),
    );
    const drop = () => {
      peer.channels[kind].delete(channel);
      this.#status();
    };
    channel.addEventListener('close', drop);
    channel.addEventListener('error', drop);
  }

  /** Everything said to a peer before their channel was ready. */
  #flush(peer) {
    if (!peer.outbox.length) return;
    const ch = this.#open(peer, 'rel');
    if (!ch) return;
    for (const body of peer.outbox.splice(0, peer.outbox.length)) {
      try {
        ch.send(body);
      } catch {
        /* gone again */
      }
    }
  }

  /** The first open channel of a kind, or null. */
  #open(peer, kind) {
    for (const ch of peer.channels[kind]) if (ch.readyState === 'open') return ch;
    return null;
  }

  /* ------------------------------------------------------- reliable side */

  /**
   * Registers a handler for a reliable message, and returns a sender.
   *
   * Safe to call before joining.
   */
  action(name, handler) {
    this.handlers.set(name, handler);
    return (payload, target) => this.send(name, payload, target);
  }

  /** @param {string} [target] one peer, or everybody */
  send(kind, payload, target) {
    const body = JSON.stringify({ k: kind, d: payload });
    const to = target ? [target] : [...this.peers.keys()];
    for (const peerId of to) {
      const peer = this.peers.get(peerId);
      if (!peer) continue;
      // Exactly one channel per person, so nothing arrives twice however many
      // ways the two machines found each other.
      const ch = this.#open(peer, 'rel');
      if (!ch) {
        // Bounded: a peer whose channel never opens is a peer who left, and
        // the whole record goes with them.
        if (peer.outbox.length < 64) peer.outbox.push(body);
        continue;
      }
      try {
        ch.send(body);
      } catch {
        if (peer.outbox.length < 64) peer.outbox.push(body);
      }
    }
  }

  #reliable(peerId, data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (message?.k) this.handlers.get(message.k)?.(message.d, peerId);
  }

  /* ----------------------------------------------------- unreliable side */

  #binary(peerId, peer, data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    const view = new DataView(data);
    const kind = view.getUint8(0);

    if (kind === KIND.STATE) {
      // Before the clocks are compared there is no sensible place to put a
      // snapshot on our own timeline, so it is dropped. This lasts one round
      // trip at the start of a session.
      if (!peer.sync.settled) return;
      this.onState?.(peerId, readState(view, 0), peer.sync.offset);
      return;
    }

    if (kind === KIND.PING) {
      const { id, t } = readPing(view);
      const n = writePing(this.probe, KIND.PONG, id, t);
      // Their stamp goes back untouched and ours rides in the tail, so they
      // can work out both the round trip and the midpoint from one reply.
      this.probe.setFloat64(n, this.now());
      this.#raw(peer, this.probe.buffer.slice(0, n + 8));
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
      peer.sync.add(now - rtt / 2 - theirs, rtt);
    }
  }

  #syncAll() {
    for (const peer of this.peers.values()) {
      if (!this.#open(peer, 'rt')) continue;
      const id = ++this.pingId;
      this.pending.set(id, true);
      // A probe nobody answered is not worth remembering.
      setTimeout(() => this.pending.delete(id), 4000);
      const n = writePing(this.probe, KIND.PING, id, this.now());
      this.#raw(peer, this.probe.buffer.slice(0, n));
    }
  }

  #raw(peer, buffer) {
    const ch = this.#open(peer, 'rt');
    if (!ch) return;
    try {
      ch.send(buffer);
    } catch {
      /* the connection went while we were talking */
    }
  }

  /**
   * Sends our car to everyone, once.
   *
   * @param {object} state everything but `seq` and `t`, which are added here
   */
  broadcastState(state) {
    if (!this.peers.size) return;
    state.seq = ++this.seq;
    state.t = Math.round(this.now());
    writeState(this.out, 0, state);
    for (const peer of this.peers.values()) this.#raw(peer, this.out.buffer.slice(0));
  }

  #status() {
    this.onStatus?.(this.status());
  }
}
