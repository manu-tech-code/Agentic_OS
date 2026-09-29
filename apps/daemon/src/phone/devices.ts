import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One paired iPhone. Its public key (P-256, SPKI DER in base64) is how it proves who it is. */
export interface PairedDevice {
  id: string;
  name: string;
  model?: string;
  key: string;
  pairedAt: number;
  lastSeen?: number;
}

interface Stored {
  /** This Mac's id for phones: made once, kept for good, so a phone knows it has found its Mac again. */
  mac: string;
  devices: PairedDevice[];
}

const isDevice = (d: unknown): d is PairedDevice => {
  const v = d as PairedDevice;
  return Boolean(v) && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.key === 'string' && typeof v.pairedAt === 'number';
};

/** The iPhones paired with this Mac, in `~/.nova/phone/devices.json` (readable by the user alone). */
export class DeviceStore {
  private stored: Stored = { mac: '', devices: [] };
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.stored = { mac: typeof raw?.mac === 'string' ? raw.mac : '', devices: Array.isArray(raw?.devices) ? raw.devices.filter(isDevice) : [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`  [iphone] couldn't read ${this.file}, so no iPhone is paired: ${(e as Error).message}`);
    }
    if (!this.stored.mac) {
      this.stored.mac = randomBytes(16).toString('base64url');
      await this.write();
    }
    return this;
  }

  get mac() {
    return this.stored.mac;
  }

  /** The newest first. */
  list(): readonly PairedDevice[] {
    return [...this.stored.devices].sort((a, b) => b.pairedAt - a.pairedAt);
  }

  find(id: string) {
    return this.stored.devices.find((d) => d.id === id);
  }

  async add(device: Pick<PairedDevice, 'name' | 'model' | 'key'>): Promise<PairedDevice> {
    const paired: PairedDevice = { id: randomBytes(12).toString('base64url'), ...device, pairedAt: Date.now() };
    this.stored.devices.push(paired);
    await this.write();
    return paired;
  }

  /** This phone can no longer come in. */
  async forget(id: string) {
    const before = this.stored.devices.length;
    this.stored.devices = this.stored.devices.filter((d) => d.id !== id);
    if (this.stored.devices.length === before) return false;
    await this.write();
    return true;
  }

  /** It came in just now. */
  async seen(id: string, at = Date.now()) {
    const device = this.find(id);
    if (!device) return;
    device.lastSeen = at;
    await this.write();
  }

  /** What's kept goes to disk, one write after another. */
  private write() {
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
