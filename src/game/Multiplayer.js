import { Room, makeRoomCode, normaliseCode } from '../net/Room.js';

export { makeRoomCode, normaliseCode };

/**
 * A race between people, on top of the transport in src/net.
 *
 * Nobody is in charge of the simulation. Every player's machine is the only
 * authority on where that player's car is, and simply says so twenty times a
 * second; everyone else draws it slightly in the past so the motion is
 * continuous. There is no server to arbitrate, which means there is nothing to
 * be laggy *about* — you can never be pulled backwards by a correction from a
 * machine that disagreed with you, because no such machine exists. It also
 * means nothing stops somebody cheating, which for racing your friends is the
 * correct trade.
 *
 * The one thing that does need agreeing is the session: the circuit, the
 * weather, the distance, and the moment the lights go out. That falls to
 * whoever has the lowest peer id — an arbitrary but identical choice on every
 * machine, so it needs no election and survives the host leaving.
 */

/** How often each car tells everyone else where it is. */
export const STATE_HZ = 20;

/** Protocol version. Peers that disagree are shown as incompatible. */
export const PROTOCOL = 1;

/** Nobody should be racing more than this many people over a mesh. */
export const MAX_DRIVERS = 8;

export class Multiplayer {
  /**
   * @param {object} opts
   * @param {string} opts.code
   * @param {() => object} opts.identity `{name, carId}` — read when it changes
   * @param {(roster: object[]) => void} [opts.onRoster]
   * @param {(session: object) => void} [opts.onSession] host chose a session
   * @param {(at: number) => void} [opts.onGo] lights out, at a local time
   * @param {(peerId, lap) => void} [opts.onLap]
   * @param {(circuit, rows) => void} [opts.onRecords]
   */
  constructor({
    code, identity, onRoster, onSession, onGo, onLap, onRecords, onStatus, transports,
  } = {}) {
    this.code = normaliseCode(code);
    this.identity = identity;
    this.onRoster = onRoster;
    this.onSession = onSession;
    this.onGo = onGo;
    this.onLap = onLap;
    this.onRecords = onRecords;
    this.onStatus = onStatus;

    /** peerId -> {id, name, carId, ready, protocol, lap, best, ping} */
    this.drivers = new Map();
    this.session = null;
    this.states = new Map();
    this.sendAccumulator = 0;

    this.room = new Room({
      code: this.code,
      transports,
      onJoin: (peerId) => this.#joined(peerId),
      onLeave: (peerId) => this.#left(peerId),
      onState: (peerId, state, offset) => {
        this.states.set(peerId, { state, offset, at: this.room.now() });
        this.onPeerState?.(peerId, state, offset);
      },
      onStatus: (status) => this.onStatus?.(status),
    });

    this.selfId = this.room.selfId;
    this.#actions();
  }

  #actions() {
    const r = this.room;
    // Short names: Trystero puts the action name in every packet's header.
    this.sendWho = r.action('who', (payload, peerId) => this.#who(peerId, payload));
    this.sendSess = r.action('sess', (payload, peerId) => {
      // Only the host gets to say what the session is. Ignoring it from
      // anyone else is not a security measure — it stops two people who both
      // briefly believed they were host from fighting over the circuit.
      if (peerId !== this.hostId) return;
      this.session = payload;
      this.onSession?.(payload);
    });
    this.sendGo = r.action('go', (payload, peerId) => {
      if (peerId !== this.hostId) return;
      // The hold — the random pause between the last lamp and lights out —
      // comes with it, or the countdown would be the same length on every
      // machine but the drama would not.
      this.onGo?.(this.#toLocal(peerId, payload.at), payload.hold);
    });
    this.sendLap = r.action('lap', (payload, peerId) => {
      const d = this.drivers.get(peerId);
      if (d) {
        d.lap = payload.n;
        if (payload.best) d.best = payload.time;
        this.#roster();
      }
      this.onLap?.(peerId, payload);
    });
    this.sendPb = r.action('pb', (payload) => {
      this.onRecords?.(payload.circuit, payload.rows ?? []);
    });
  }

  /** Converts a stamp on a peer's clock to one on ours. */
  #toLocal(peerId, at) {
    const sync = this.room.syncFor(peerId);
    return sync?.settled ? at + sync.offset : this.room.now();
  }

  join() {
    this.room.join();
    this.#announce();
    this.#roster();
  }

  leave() {
    this.room.leave();
    this.drivers.clear();
    this.states.clear();
  }

  /**
   * Whoever has the lowest id, counting ourselves.
   *
   * Every machine sorts the same list of ids the same way and arrives at the
   * same answer without exchanging a word about it. When the host leaves, the
   * next-lowest id becomes host on every machine at once, for the same reason.
   */
  get hostId() {
    let low = this.selfId;
    for (const id of this.drivers.keys()) if (id < low) low = id;
    return low;
  }

  get isHost() {
    return this.hostId === this.selfId;
  }

  get full() {
    return this.drivers.size + 1 >= MAX_DRIVERS;
  }

  /** Everyone in the room, us included, in grid order. */
  roster() {
    const me = this.identity?.() ?? {};
    const rows = [
      {
        id: this.selfId,
        name: me.name || 'You',
        carId: me.carId,
        self: true,
        protocol: PROTOCOL,
        ping: 0,
        lap: this.myLap ?? 0,
        best: this.myBest ?? null,
      },
      ...[...this.drivers.values()].map((d) => ({ ...d, ping: this.room.pingTo(d.id) })),
    ];
    // The grid is peer id order, which is the same on every machine, so
    // nobody has to be told which slot they are in.
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    return rows.map((row, i) => ({ ...row, slot: i, host: row.id === this.hostId }));
  }

  #roster() {
    this.onRoster?.(this.roster());
  }

  #announce(target) {
    const me = this.identity?.() ?? {};
    this.sendWho({ name: me.name || 'Driver', carId: me.carId, protocol: PROTOCOL }, target);
  }

  /** How the introduction is going, in words a player can act on. */
  describe() {
    const s = this.room.status();
    if (s.connected) {
      const n = s.connected;
      return `Connected to ${n} ${n === 1 ? 'driver' : 'drivers'}.`;
    }
    if (s.peers) return 'Found somebody — opening the connection…';
    if (!s.networks) {
      return 'Could not reach any of the matchmaking networks. Some office, ' +
        'school and mobile networks block them.';
    }
    const via = s.failed.length ? ` (${s.failed.join(' and ')} unreachable)` : '';
    return `Listening on ${s.networks} of ${s.total} networks${via}. ` +
      'Give your friends the code.';
  }

  #joined(peerId) {
    this.drivers.set(peerId, {
      id: peerId,
      name: '…',
      carId: null,
      protocol: null,
      lap: 0,
      best: null,
    });
    // Tell the newcomer who we are, and — if we are the host — what we are
    // all doing. They joined after the decision was made.
    this.#announce(peerId);
    if (this.isHost && this.session) this.sendSess(this.session, peerId);
    this.#roster();
  }

  #left(peerId) {
    this.drivers.delete(peerId);
    this.states.delete(peerId);
    this.onPeerGone?.(peerId);
    // The host may have just left, in which case somebody has quietly become
    // host and the lobby needs to say so.
    this.#roster();
  }

  #who(peerId, payload) {
    const d = this.drivers.get(peerId) ?? { id: peerId, lap: 0, best: null };
    d.name = String(payload?.name ?? 'Driver').slice(0, 18);
    d.carId = payload?.carId ?? null;
    d.protocol = payload?.protocol ?? 0;
    this.drivers.set(peerId, d);
    this.#roster();
  }

  /** Host only: settles what everyone is about to race. */
  setSession(session) {
    if (!this.isHost) return;
    this.session = { ...session, host: this.selfId };
    this.sendSess(this.session);
    this.onSession?.(this.session);
  }

  /** Host only: starts the grid procedure, now. */
  start(hold = 0.25 + Math.random() * 0.95) {
    if (!this.isHost) return;
    const at = this.room.now();
    this.sendGo({ at, hold });
    this.onGo?.(at, hold);
  }

  /** Tells the room our car changed, so the lobby stays honest. */
  refreshIdentity() {
    this.#announce();
    this.#roster();
  }

  /** Announces a completed lap. */
  reportLap(lap) {
    this.myLap = lap.n;
    if (lap.best) this.myBest = lap.time;
    this.sendLap(lap);
    this.#roster();
  }

  /** Offers our record board for this circuit to everyone in the room. */
  shareRecords(circuit, rows) {
    if (!rows?.length) return;
    this.sendPb({ circuit, rows });
  }

  /**
   * Sends our car, at most STATE_HZ times a second.
   *
   * Called every frame; it decides for itself whether this frame is one that
   * goes out. Rendering at 120 fps does not mean sending at 120 Hz — the
   * receiver interpolates between snapshots and gains nothing from more of
   * them, while every extra packet is another chance for one to be late.
   */
  send(dt, vehicle) {
    if (!this.room.peerCount) return;
    this.sendAccumulator += dt;
    const period = 1 / STATE_HZ;
    if (this.sendAccumulator < period) return;
    // Never send a burst to catch up after a stall: the newest state is the
    // only one anybody wants.
    this.sendAccumulator = Math.min(this.sendAccumulator - period, period);

    const w = vehicle.wheels;
    const q = vehicle.quaternion;
    this.room.broadcastState({
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: vehicle.velocity.x,
      vy: vehicle.velocity.y,
      vz: vehicle.velocity.z,
      steer: w[0].steer,
      omega: w[2].omega,
      throttle: vehicle.controls.throttle,
      brake: Math.max(vehicle.controls.brake, vehicle.controls.handbrake),
      slip: Math.max(w[2].slipSpeed, w[3].slipSpeed),
      surface: w[0].surface,
      grounded: vehicle.groundedCount > 0,
    });
  }
}
