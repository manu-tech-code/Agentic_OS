/**
 * Nova on the iPhone: how a phone reaches the Mac. The daemon opens a door on the network for paired
 * phones alone - TLS, with a certificate the phone pins from the pairing QR code - and each phone
 * proves who it is by signing a challenge with a key its Secure Enclave holds (it never leaves the
 * phone). Past the door, a phone speaks Nova's own protocol (protocol.ts), limited to what a phone needs.
 * The iPhone app (apps/ios) mirrors what's here.
 */

/** The door's version: a phone and a Mac that disagree on it say so, rather than misread each other. */
export const PHONE_PROTOCOL = 1;

/** Where a phone's speech is turned into text: on the Mac, on the iPhone, or the Mac unless the connection is weak. */
export type PhoneHearing = 'auto' | 'mac' | 'iphone';

/** What the pairing QR code - and the same link, for a simulator or AirDrop - carries. */
export interface PairingOffer {
  /** The Mac's id: random, and the same for good - how a phone knows it has found its Mac again. */
  mac: string;
  /** What the phone calls it: "Nova on Emmanuel's MacBook Pro". */
  name: string;
  /** Where to reach it: its addresses on the Wi-Fi (and on a tailnet), in the order to try. */
  hosts: string[];
  port: number;
  /** SHA-256 of the door's TLS certificate (DER), base64url: the phone accepts no other. */
  pin: string;
  /** Good once, for minutes: it lets one phone pair. */
  code: string;
}

export const PAIRING_LINK = 'nova://pair';

export function pairingLink(offer: PairingOffer): string {
  const q = new URLSearchParams({ v: String(PHONE_PROTOCOL), m: offer.mac, n: offer.name, h: offer.hosts.join(','), p: String(offer.port), k: offer.pin, c: offer.code });
  return `${PAIRING_LINK}?${q}`;
}

const B64URL = /^[A-Za-z0-9_-]{16,64}$/;
const HOST = /^[A-Za-z0-9.:%_-]{1,64}$/;

/** The offer in a pairing link, or null when it isn't one (or is for another version of the door). */
export function readPairingLink(link: string): PairingOffer | null {
  if (!link.startsWith(`${PAIRING_LINK}?`)) return null;
  const q = new URLSearchParams(link.slice(PAIRING_LINK.length + 1));
  const [mac, name, pin, code] = ['m', 'n', 'k', 'c'].map((k) => q.get(k) ?? '');
  const port = Number(q.get('p'));
  const hosts = (q.get('h') ?? '').split(',').filter((h) => HOST.test(h));
  if (q.get('v') !== String(PHONE_PROTOCOL) || ![mac, pin, code].every((s) => B64URL.test(s!)) || !name || !hosts.length) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { mac: mac!, name: name!.slice(0, 80), hosts, port, pin: pin!, code: code! };
}

/** The door's handshake: a challenge, the phone's answer, and - once it's in - Nova's own events. */
export type DoorMessage =
  /** Door → phone, first: sign this nonce. */
  | { type: 'phone-challenge'; v: number; nonce: string; mac: string; name: string }
  /**
   * Phone → door: pair, with the code from the QR code, the phone's public key (P-256, SPKI DER in
   * base64) and its signature of the challenge (ECDSA SHA-256, DER in base64).
   */
  | { type: 'phone-pair'; code: string; device: { name: string; model?: string }; key: string; signature: string }
  /** Phone → door: a paired phone, back again - its id, and its signature of the challenge. */
  | { type: 'phone-auth'; device: string; signature: string }
  /** Door → phone: it's in. What follows is Nova's own protocol. */
  | { type: 'phone-welcome'; device: string; name: string };

/** What a phone signs to show it holds its key: this challenge, from this Mac, for this purpose. */
export const challengeText = (purpose: 'pair' | 'auth', mac: string, nonce: string) => `nova-phone:${purpose}:${PHONE_PROTOCOL}:${mac}:${nonce}`;

/** Why the door closed a connection: WebSocket close codes a phone can act on. */
export const DOOR_CLOSE = {
  /** An unknown or forgotten phone, or a signature that doesn't check out: pair it again. */
  unknown: 4401,
  /** A pairing code that's wrong, used or expired: scan a new one. */
  refused: 4403,
  /** Another version of the door: update the app, or Nova. */
  version: 4426,
  /** Too many tries: wait, and scan a new code. */
  busy: 4429,
} as const;

/** A reminder or timer coming up, for the iPhone to ring for itself - even with Nova closed there. */
export interface PhoneReminder {
  id: string;
  title: string;
  /** What Nova says when it's due. */
  body: string;
  /** What it's for, in the user's words ("call mum", "the tea"): what the phone's widgets show. */
  what?: string;
  /** Epoch ms. */
  due: number;
  timer: boolean;
}

/**
 * News Nova held for the user while they were away from the Mac - a reminder that came up, an agent finishing - for
 * the iPhone to show as notifications when iOS lets it check in by itself (Background App Refresh: a free Apple
 * account has no push). Each stays held at the Mac until the phone says it showed it.
 */
export interface PhoneNews {
  id: string;
  kind: 'timer' | 'reminder' | 'task' | 'briefing';
  /** Short: the notification's title. */
  title: string;
  /** What Nova would have said. */
  text: string;
  /** When it came up (epoch ms). */
  at: number;
  /** The reminder or task it's about. */
  ref?: string;
}

/** Nova on the iPhone, for Settings. */
export interface PhoneStatus {
  /** The door is open for paired phones: its port, and the addresses a phone can reach it on. */
  door: { port: number; addresses: string[] } | null;
  /** Why it isn't open when it should be, or what's wrong. */
  message?: string;
  /** Paired phones, the newest first. */
  devices: { id: string; name: string; model?: string; pairedAt: number; lastSeen?: number; connected: boolean }[];
  /** A pairing under way: the link its QR code holds, and when that stops working. */
  pairing: { link: string; expires: number } | null;
}
