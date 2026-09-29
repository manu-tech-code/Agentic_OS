import { createPublicKey, randomBytes, timingSafeEqual, verify, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { challengeText, DOOR_CLOSE, PHONE_PROTOCOL, type DoorMessage } from '@nova/core';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DeviceStore, PairedDevice } from './devices.ts';
import type { DoorIdentity } from './tls.ts';

/** How long a pairing code is good for, and how many wrong codes end it. */
export const PAIRING_MS = 10 * 60_000;
const PAIRING_TRIES = 5;
/** A phone says who it is at once, or the door closes. */
const HANDSHAKE_MS = 10_000;

/** Whether `signature` (ECDSA with SHA-256, DER in base64) of `text` checks out with `key` (P-256, SPKI DER in base64). */
export function signedBy(key: string, text: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verify('sha256', Buffer.from(text), { key: publicKey, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameCode = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
/** A name a phone gave itself, as Settings shows it: printable, and not too long. */
const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\p{C}]/gu, '').trim().slice(0, 60) : '') || 'iPhone';

/** The phone's answer to the challenge, if it's one the door understands. */
function answer(raw: string): Extract<DoorMessage, { type: 'phone-pair' | 'phone-auth' }> | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  const signature = text(m?.signature, 200);
  if (!signature) return null;
  if (m.type === 'phone-auth') {
    const device = text(m.device, 64);
    return device ? { type: 'phone-auth', device, signature } : null;
  }
  if (m.type === 'phone-pair') {
    const code = text(m.code, 64);
    const key = text(m.key, 200);
    const device = (m.device ?? {}) as Record<string, unknown>;
    if (!code || !key) return null;
    return { type: 'phone-pair', code, key, signature, device: { name: cleanName(device.name), ...(typeof device.model === 'string' ? { model: cleanName(device.model) } : {}) } };
  }
  return null;
}

/**
 * Nova's door for iPhones: TLS on the network (the phone pins its certificate from the pairing QR
 * code), then a challenge each phone signs with its own key. Paired phones come in; a phone with a
 * pairing code from Settings pairs once. Nothing else gets past it.
 */
export class PhoneDoor {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private offer: { code: string; expires: number; tries: number } | null = null;
  private opened: DoorIdentity | null = null;

  constructor(
    private readonly opts: {
      devices: DeviceStore;
      /** What the phone calls this Mac: "Nova on Ama's MacBook Pro". */
      name: () => string;
      /** A phone is in: from here on it's one of Nova's clients. */
      welcome(ws: WebSocket, device: PairedDevice): void;
      /** A phone paired, or the pairing code stopped working: Settings shows the change. */
      changed(): void;
    },
  ) {}

  /** The port it listens on, or null while it's shut. */
  get port() {
    return this.server?.listening ? (this.server.address() as AddressInfo).port : null;
  }

  /** Open the door on `port` (0: any free one), on every network this Mac is on. */
  async open(port: number, identity: DoorIdentity): Promise<number> {
    if (this.server && this.opened === identity) return this.port!;
    this.close();
    const server = createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (_, res) => res.writeHead(404).end());
    // Any path: a phone that found the Mac by Bonjour asks for the service, not an address.
    const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
    wss.on('connection', (ws) => this.handshake(ws));
    wss.on('error', () => {}); // the server's own errors come just below
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(port, () => (server.off('error', fail), ok()));
    });
    server.on('error', (e) => console.warn(`  [iphone] the door: ${e.message}`));
    server.on('tlsClientError', () => {}); // a phone that didn't trust the certificate, or a stray scan: nothing to do
    this.server = server;
    this.wss = wss;
    this.opened = identity;
    return this.port!;
  }

  close() {
    for (const ws of this.wss?.clients ?? []) ws.close(1001, 'Nova closed the door for iPhones');
    this.wss?.close();
    this.server?.close();
    this.server = this.wss = this.opened = null;
    this.offer = null;
  }

  /** One phone may pair in the next ten minutes, with this code (the QR code carries it). A new one replaces the last. */
  startPairing(ms = PAIRING_MS) {
    this.offer = { code: randomBytes(16).toString('base64url'), expires: Date.now() + ms, tries: 0 };
    return this.offer;
  }

  stopPairing() {
    this.offer = null;
  }

  /** The pairing under way, if its code still works. */
  get pairing() {
    return this.offer && this.offer.expires > Date.now() ? { code: this.offer.code, expires: this.offer.expires } : null;
  }

  private handshake(ws: WebSocket) {
    const nonce = randomBytes(32).toString('base64url');
    const mac = this.opts.devices.mac;
    const challenge: DoorMessage = { type: 'phone-challenge', v: PHONE_PROTOCOL, nonce, mac, name: this.opts.name() };
    ws.send(JSON.stringify(challenge));
    const timer = setTimeout(() => ws.close(DOOR_CLOSE.unknown, 'Say who you are first'), HANDSHAKE_MS);
    ws.on('error', () => {});
    ws.once('message', (raw, binary) => {
      clearTimeout(timer);
      const m = binary ? null : answer(String(raw));
      if (!m) return ws.close(DOOR_CLOSE.unknown, 'Say who you are first');
      if (m.type === 'phone-auth') {
        const device = this.opts.devices.find(m.device);
        if (!device || !signedBy(device.key, challengeText('auth', mac, nonce), m.signature)) return ws.close(DOOR_CLOSE.unknown, 'Pair this iPhone again, in Settings → iPhone');
        void this.opts.devices.seen(device.id).catch(() => {});
        return this.welcome(ws, device);
      }
      void this.pair(ws, m, mac, nonce).catch((e) => {
        console.warn(`  [iphone] pairing: ${(e as Error).message}`);
        ws.close(1011, "Couldn't pair");
      });
    });
  }

  private async pair(ws: WebSocket, m: Extract<DoorMessage, { type: 'phone-pair' }>, mac: string, nonce: string) {
    const offer = this.offer && this.offer.expires > Date.now() ? this.offer : null;
    if (!offer) return ws.close(DOOR_CLOSE.refused, 'That code has run out - show a new one in Settings → iPhone');
    if (!sameCode(m.code, offer.code)) {
      // Guessing is no use: a few wrong codes, and this one stops working.
      if (++offer.tries >= PAIRING_TRIES) {
        this.offer = null;
        this.opts.changed();
        return ws.close(DOOR_CLOSE.busy, 'Too many wrong codes - show a new one in Settings → iPhone');
      }
      return ws.close(DOOR_CLOSE.refused, "That code isn't the one on the Mac");
    }
    if (!signedBy(m.key, challengeText('pair', mac, nonce), m.signature)) return ws.close(DOOR_CLOSE.refused, "The iPhone's key doesn't check out");
    this.offer = null; // one phone for each code
    const device = await this.opts.devices.add({ name: m.device.name, model: m.device.model, key: m.key });
    console.log(`  [iphone] paired ${device.name}`);
    this.opts.changed();
    this.welcome(ws, device);
  }

  private welcome(ws: WebSocket, device: PairedDevice) {
    if (ws.readyState !== ws.OPEN) return;
    const welcome: DoorMessage = { type: 'phone-welcome', device: device.id, name: this.opts.name() };
    ws.send(JSON.stringify(welcome));
    this.opts.welcome(ws, device);
  }
}
