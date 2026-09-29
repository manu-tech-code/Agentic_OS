import { execFile } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DOOR_CLOSE, pairingLink, PHONE_PROTOCOL, type PhoneStatus } from '@nova/core';
import type { WebSocket } from 'ws';
import { advertise } from './bonjour.ts';
import { DeviceStore, type PairedDevice } from './devices.ts';
import { PhoneDoor } from './door.ts';
import { doorIdentity, type DoorIdentity } from './tls.ts';

export type { PairedDevice } from './devices.ts';

/**
 * The Mac's addresses a phone can reach it on: the Wi-Fi's (or a wired network's) first, then a
 * tailnet's (Tailscale hands out 100.64.0.0/10). Loopback and self-assigned addresses are no use to a phone.
 */
export function reachableAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const local: string[] = [];
  const tailnet: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x = 0, y = 0] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y < 128) tailnet.push(a.address);
      else if (x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168)) local.push(a.address);
    }
  }
  return [...new Set([...local, ...tailnet])].slice(0, 4);
}

const run = promisify(execFile);

/** What this Mac is called (System Settings → General → Sharing): "Ama's MacBook Pro". */
async function computerName() {
  try {
    const { stdout } = await run('scutil', ['--get', 'ComputerName'], { timeout: 3000 });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // not a Mac, or no name: the host name will do
  }
  return hostname().replace(/\.local$/, '');
}

/**
 * Nova on the iPhone, as the daemon sees it: the door (open while Settings → iPhone lets phones
 * connect), Bonjour telling the Wi-Fi where it is, pairing, and the phones connected now.
 */
export class Phones {
  readonly devices: DeviceStore;
  private readonly door: PhoneDoor;
  private readonly live = new Map<WebSocket, PairedDevice>();
  private identity: DoorIdentity | null = null;
  private stopBonjour: (() => void) | null = null;
  private problem: string | undefined;
  private enabled = false;
  private computer = 'this Mac';
  private expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly opts: {
      /** Where the door's identity and the paired phones are kept: ~/.nova/phone. */
      dir: string;
      port: number;
      /** The assistant's name, for "Nova on Ama's MacBook Pro". */
      assistant: () => string;
      /** A phone is in: make it one of Nova's clients. */
      welcome(ws: WebSocket, device: PairedDevice): void;
      /** Something Settings shows changed. */
      changed(): void;
    },
  ) {
    this.devices = new DeviceStore(join(opts.dir, 'devices.json'));
    this.door = new PhoneDoor({
      devices: this.devices,
      name: () => this.name,
      welcome: (ws, device) => {
        this.live.set(ws, device);
        ws.once('close', () => {
          this.live.delete(ws);
          this.opts.changed();
        });
        this.opts.welcome(ws, device);
        this.opts.changed();
      },
      changed: () => this.opts.changed(),
    });
  }

  async load() {
    await this.devices.load();
    this.computer = await computerName();
    return this;
  }

  /** "Nova on Ama's MacBook Pro": what the phone calls this Mac. */
  get name() {
    return `${this.opts.assistant()} on ${this.computer}`;
  }

  /** Whether this connection is a paired phone's. */
  isPhone(ws: WebSocket) {
    return this.live.has(ws);
  }

  /** Open the door (Settings → iPhone → Let your iPhone connect), or shut it. */
  async configure(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) return this.shut();
    if (this.door.port !== null) return;
    try {
      this.identity ??= await doorIdentity(this.opts.dir);
      const port = await this.door.open(this.opts.port, this.identity);
      if (!this.enabled) return this.shut(); // switched off while it opened
      this.stopBonjour?.();
      this.stopBonjour = advertise(this.name, port, { id: this.devices.mac, v: String(PHONE_PROTOCOL) });
      this.problem = undefined;
      console.log(`  [iphone] the door is open for paired iPhones, on port ${port}`);
    } catch (e) {
      this.problem =
        (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${this.opts.port} is in use, so iPhones can't connect - set NOVA_PHONE_PORT in .env to another.`
          : `The door for iPhones couldn't open: ${(e as Error).message}`;
      console.warn(`  [iphone] ${this.problem}`);
    }
    this.opts.changed();
  }

  private shut() {
    const was = this.door.port !== null || this.problem !== undefined;
    this.stopBonjour?.();
    this.stopBonjour = null;
    this.door.close();
    clearTimeout(this.expiry);
    this.problem = undefined;
    if (was) this.opts.changed();
  }

  /** Show a pairing code in Settings: it works for one phone, for ten minutes. */
  startPairing() {
    if (this.door.port === null) throw new Error(this.problem ?? 'Turn on "Let your iPhone connect" first.');
    if (!reachableAddresses().length) throw new Error("This Mac isn't on a network an iPhone can reach - join the Wi-Fi your iPhone is on.");
    const offer = this.door.startPairing();
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.opts.changed(), offer.expires - Date.now() + 250); // the QR code goes when it stops working
    this.opts.changed();
  }

  stopPairing() {
    this.door.stopPairing();
    clearTimeout(this.expiry);
    this.opts.changed();
  }

  /** This phone can no longer connect; if it's connected now, it's let go. */
  async forget(id: string) {
    const gone = await this.devices.forget(id);
    for (const [ws, device] of this.live) if (device.id === id) ws.close(DOOR_CLOSE.unknown, 'Forgotten on the Mac - pair it again to connect');
    this.opts.changed();
    return gone;
  }

  status(): PhoneStatus {
    const port = this.door.port;
    const addresses = port === null ? [] : reachableAddresses();
    const connected = new Set([...this.live.values()].map((d) => d.id));
    const pairing = this.door.pairing;
    const message = this.problem ?? (port !== null && !addresses.length ? "This Mac isn't on a network an iPhone can reach - join the Wi-Fi your iPhone is on." : undefined);
    return {
      door: port === null ? null : { port, addresses },
      ...(message ? { message } : {}),
      devices: this.devices.list().map((d) => ({
        id: d.id,
        name: d.name,
        ...(d.model ? { model: d.model } : {}),
        pairedAt: d.pairedAt,
        ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}),
        connected: connected.has(d.id),
      })),
      pairing:
        port !== null && pairing && this.identity && addresses.length
          ? { link: pairingLink({ mac: this.devices.mac, name: this.name, hosts: addresses, port, pin: this.identity.pin, code: pairing.code }), expires: pairing.expires }
          : null,
    };
  }

  close() {
    this.enabled = false;
    this.shut();
  }
}
