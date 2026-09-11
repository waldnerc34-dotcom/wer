/**
 * Racing somebody without a matchmaking relay at all.
 *
 * The room in Room.js needs an introduction service — some public machine
 * both players can reach, which passes one browser's connection details to
 * the other. That is the only part of multiplayer that depends on anything
 * outside the two players' machines, and it is the part that breaks: the
 * relays are volunteer infrastructure, and plenty of home routers, school
 * networks, corporate proxies and mobile carriers block WebSockets to
 * unfamiliar hosts outright.
 *
 * So here is the same introduction done by hand. The details a browser would
 * have sent through a relay are compressed into a block of text instead. One
 * player sends it to the other however they already talk — a message, a chat,
 * a read-out-loud link — the other pastes it in and sends a shorter block
 * back, and the two browsers are connected. Slower to set up, but it cannot
 * be blocked by anything, because nothing but the two players is involved.
 *
 * Everything after the handshake is identical: the same two data channels on
 * the same peer connection, driven by the same Room.
 */

/**
 * Public STUN servers, used to discover what the outside world sees as your
 * address. STUN is a couple of UDP packets to a well-known port and is very
 * rarely blocked — unlike the WebSocket relays this exists to replace. Three
 * unrelated operators, because any one of them can be having a bad day.
 *
 * No TURN: relaying every packet of a race through a third machine would
 * undo the point of the whole thing. Two players behind symmetric NATs will
 * fail to connect, which is uncommon on home broadband.
 */
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/** Bumped if the contents of a code ever change shape. */
const VERSION = 1;

/** How long to collect network routes before giving up on the slow ones. */
const GATHER_MS = 3500;

/** Enough of a prefix to recognise one of these pasted into the wrong box. */
const PREFIX = 'APEX1-';

/* ------------------------------------------------------------- the text -- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** base64url: survives being pasted into a URL, a chat box or a QR code. */
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function squeeze(bytes, format) {
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(
    format === 'deflate-raw' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw'),
  ));
  return new Uint8Array(await stream.arrayBuffer());
}

/**
 * Packs a handshake into something a person can send to a person.
 *
 * A session description is around two and a half kilobytes of extremely
 * repetitive text — the same attribute names, the same address, over and
 * over — so deflate takes about three quarters of it away before it is
 * turned into letters. Where the browser is too old for CompressionStream
 * the text goes in uncompressed; it still works, it is just longer.
 */
export async function pack(payload) {
  const raw = encoder.encode(JSON.stringify(payload));
  if (typeof CompressionStream === 'undefined') return `${PREFIX}0${toBase64(raw)}`;
  try {
    return `${PREFIX}1${toBase64(await squeeze(raw, 'deflate-raw'))}`;
  } catch {
    return `${PREFIX}0${toBase64(raw)}`;
  }
}

/** The inverse. Returns null for anything that is not one of our codes. */
export async function unpack(text) {
  const trimmed = String(text || '').trim().replace(/\s+/g, '');
  // Tolerates the whole invite link being pasted, not just the code in it.
  const body = trimmed.includes(PREFIX) ? trimmed.slice(trimmed.indexOf(PREFIX) + PREFIX.length) : null;
  if (!body) return null;
  try {
    const bytes = fromBase64(body.slice(1));
    const json = decoder.decode(body[0] === '1' ? await squeeze(bytes, 'inflate-raw') : bytes);
    const payload = JSON.parse(json);
    return payload?.v === VERSION ? payload : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- the handshake -- */

/**
 * Waits until the browser has finished working out how it can be reached.
 *
 * Normally a browser sends these routes to the other side one at a time as it
 * finds them, over the signalling connection. There is no signalling
 * connection here — the whole point — so they all have to be in the one block
 * of text, which means waiting for the last one. A STUN server that never
 * answers would otherwise hold that up for the full ICE timeout, so this
 * settles for what it has after a few seconds.
 */
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function connection(iceServers) {
  return new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
}

/**
 * The inviting side. Returns the code to send, and the connection it belongs
 * to, which is not usable until the reply comes back through `accept`.
 *
 * The data channels are opened here, before the offer is made, because they
 * have to be described in it: there is no signalling channel afterwards to
 * negotiate them over. This is why the two sides have fixed roles — the one
 * who invites creates the channels, the one who accepts receives them —
 * rather than the id comparison Room uses for a relayed introduction.
 */
export async function invite({ selfId, room = null, iceServers = ICE_SERVERS, channels }) {
  const pc = connection(iceServers);
  const made = channels(pc);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);

  return {
    pc,
    channels: made,
    code: await pack({ v: VERSION, t: 'o', id: selfId, room, sdp: pc.localDescription.sdp }),
    /** Feeds in the reply. Resolves to the other player's id. */
    async accept(reply) {
      const payload = await unpack(reply);
      if (!payload || payload.t !== 'a') throw new Error('That is not a reply code.');
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      return payload.id;
    },
  };
}

/**
 * The accepting side. Takes the code it was sent and produces the reply,
 * along with a connection that is live as soon as the other end has it.
 */
export async function accept({ code, selfId, iceServers = ICE_SERVERS, onChannel }) {
  const payload = await unpack(code);
  if (!payload || payload.t !== 'o') throw new Error('That is not an invite code.');

  const pc = connection(iceServers);
  pc.addEventListener('datachannel', (event) => onChannel(event.channel));
  await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);

  return {
    pc,
    peerId: payload.id,
    room: payload.room ?? null,
    code: await pack({ v: VERSION, t: 'a', id: selfId, sdp: pc.localDescription.sdp }),
  };
}

/**
 * What is in an invite, without acting on it.
 *
 * Opening an invite link has to know which room it belongs to before there is
 * a room object to ask, so that the person who follows it lands in the same
 * one as the person who sent it and not in a room of their own.
 */
export async function peek(code) {
  const payload = await unpack(code);
  return payload?.t === 'o' ? { id: payload.id, room: payload.room ?? null } : null;
}
