import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { challengeText, DOOR_CLOSE, type DoorMessage } from '@nova/core';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DeviceStore, type PairedDevice } from '../src/phone/devices.ts';
import { PhoneDoor } from '../src/phone/door.ts';
import { reachableAddresses } from '../src/phone/index.ts';
import { doorIdentity, type DoorIdentity } from '../src/phone/tls.ts';
import { readClientEvent } from '../src/shell/events.ts';

const temp = () => mkdtemp(join(tmpdir(), 'nova-phone-'));
const openssl = !spawnSync('openssl', ['version']).error;

/** A phone's key, as the iPhone's Secure Enclave makes one: P-256, the public half as SPKI DER in base64. */
function phoneKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}
const signed = (privateKey: KeyObject, text: string) => sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'der' }).toString('base64');

/**
 * A phone at the door: it checks the certificate is the pinned one, as the iPhone app does, then
 * answers the challenge with `reply`. Resolves with how that went: welcomed, or closed with a code.
 */
function knock(port: number, pin: string, reply: (challenge: Extract<DoorMessage, { type: 'phone-challenge' }>) => object) {
  return new Promise<{ welcome?: Extract<DoorMessage, { type: 'phone-welcome' }>; closed?: number; pinned: boolean; ws: WebSocket }>((done) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/phone`, { rejectUnauthorized: false });
    let pinned = false;
    ws.on('upgrade', (res) => {
      const cert = (res.socket as TLSSocket).getPeerCertificate();
      pinned = createHash('sha256').update(cert.raw).digest('base64url') === pin;
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as DoorMessage;
      if (m.type === 'phone-challenge') ws.send(JSON.stringify(reply(m)));
      else if (m.type === 'phone-welcome') done({ welcome: m, pinned, ws });
    });
    ws.on('close', (code) => done({ closed: code, pinned, ws }));
    ws.on('error', () => {});
  });
}

async function door(identity: DoorIdentity) {
  const devices = await new DeviceStore(join(await temp(), 'devices.json')).load();
  const welcomed: PairedDevice[] = [];
  const d = new PhoneDoor({ devices, name: () => 'Nova on the test Mac', welcome: (_, device) => welcomed.push(device), changed: () => {} });
  const port = await d.open(0, identity);
  return { d, port, devices, welcomed };
}

describe('the paired iPhones', () => {
  it('are kept where only the user can read them, with an id for this Mac made once', async () => {
    const file = join(await temp(), 'phone', 'devices.json');
    const store = await new DeviceStore(file).load();
    const mac = store.mac;
    expect(mac).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const a = await store.add({ name: 'iPhone', model: 'iPhone 17', key: 'AAAA' });
    await store.add({ name: 'Work iPhone', key: 'BBBB' });
    await store.seen(a.id, 1234);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    const again = await new DeviceStore(file).load();
    expect(again.mac).toBe(mac);
    expect(again.list().map((d) => d.name)).toEqual(['Work iPhone', 'iPhone']);
    expect(again.find(a.id)).toMatchObject({ lastSeen: 1234, model: 'iPhone 17' });
    expect(await again.forget(a.id)).toBe(true);
    expect(await again.forget(a.id)).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8')).devices).toHaveLength(1);
  });

  it('reach the Mac on the Wi-Fi first, then a tailnet - never loopback or self-assigned addresses', () => {
    const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never;
    const found = reachableAddresses({
      lo0: [iface('127.0.0.1', 'IPv4', true)],
      utun4: [iface('100.101.102.103')],
      en0: [iface('fe80::1', 'IPv6'), iface('192.168.1.23')],
      en5: [iface('169.254.10.20')],
      bridge0: [iface('10.0.0.2')],
    });
    expect(found).toEqual(['192.168.1.23', '10.0.0.2', '100.101.102.103']);
  });

  it('change what a window may say: pairing, forgetting, and what was said into a phone', () => {
    expect(readClientEvent(JSON.stringify({ type: 'phone-pair', action: 'start' }))).not.toBeNull();
    expect(readClientEvent(JSON.stringify({ type: 'phone-pair', action: 'open-wide' }))).toBeNull();
    expect(readClientEvent(JSON.stringify({ type: 'phone-forget', id: 'abc' }))).not.toBeNull();
    expect(readClientEvent(JSON.stringify({ type: 'utterance', text: 'hi', source: 'phone' }))).not.toBeNull();
  });
});

describe.skipIf(!openssl)("the door for iPhones", () => {
  it('has a TLS identity made once, the key readable by the user alone', async () => {
    const dir = join(await temp(), 'phone');
    const identity = await doorIdentity(dir);
    expect(identity.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(((await stat(join(dir, 'door.key'))).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe('700');
    expect((await doorIdentity(dir)).pin).toBe(identity.pin); // kept: paired phones still trust it
  });

  it('pairs one phone with the code from Settings, and lets it back in when it signs the challenge', async () => {
    const identity = await doorIdentity(join(await temp(), 'phone'));
    const { d, port, devices, welcomed } = await door(identity);
    const phone = phoneKey();
    const pair = (code: string, privateKey = phone.privateKey) => (c: { mac: string; nonce: string }) => ({
      type: 'phone-pair',
      code,
      device: { name: 'Ama’s iPhone', model: 'iPhone 17' },
      key: phone.key,
      signature: signed(privateKey, challengeText('pair', c.mac, c.nonce)),
    });
    try {
      // Nothing to pair with until Settings shows a code.
      expect((await knock(port, identity.pin, pair('nope'))).closed).toBe(DOOR_CLOSE.refused);
      const { code } = d.startPairing();
      const wrong = await knock(port, identity.pin, pair('not-the-code'));
      expect(wrong).toMatchObject({ closed: DOOR_CLOSE.refused, pinned: true });
      // The right code, but signed with another key than the one it hands over.
      expect((await knock(port, identity.pin, pair(code, phoneKey().privateKey))).closed).toBe(DOOR_CLOSE.refused);

      const paired = await knock(port, identity.pin, pair(code));
      expect(paired.welcome).toMatchObject({ type: 'phone-welcome', name: 'Nova on the test Mac' });
      paired.ws.close();
      expect(welcomed).toHaveLength(1);
      expect(devices.list()).toEqual([expect.objectContaining({ id: paired.welcome!.device, name: 'Ama’s iPhone', key: phone.key })]);
      expect(d.pairing).toBeNull(); // one phone for each code
      expect((await knock(port, identity.pin, pair(code))).closed).toBe(DOOR_CLOSE.refused);

      // Back again: the same phone, its challenge signed with its key.
      const id = paired.welcome!.device;
      const auth = (privateKey: KeyObject, device = id) => (c: { mac: string; nonce: string }) => ({ type: 'phone-auth', device, signature: signed(privateKey, challengeText('auth', c.mac, c.nonce)) });
      const back = await knock(port, identity.pin, auth(phone.privateKey));
      expect(back.welcome?.device).toBe(id);
      back.ws.close();
      expect(devices.find(id)?.lastSeen).toBeGreaterThan(0);
      // Another key, a device it doesn't know, a signature of something else: not let in.
      expect((await knock(port, identity.pin, auth(phoneKey().privateKey))).closed).toBe(DOOR_CLOSE.unknown);
      expect((await knock(port, identity.pin, auth(phone.privateKey, 'someone-else'))).closed).toBe(DOOR_CLOSE.unknown);
      expect((await knock(port, identity.pin, (c) => ({ type: 'phone-auth', device: id, signature: signed(phone.privateKey, challengeText('pair', c.mac, c.nonce)) }))).closed).toBe(DOOR_CLOSE.unknown);
      expect((await knock(port, identity.pin, () => ({ hello: 'there' }))).closed).toBe(DOOR_CLOSE.unknown);
      // Forgotten on the Mac: not let in again.
      await devices.forget(id);
      expect((await knock(port, identity.pin, auth(phone.privateKey))).closed).toBe(DOOR_CLOSE.unknown);
    } finally {
      d.close();
    }
  });

  it('stops a pairing code working after a few wrong guesses', async () => {
    const identity = await doorIdentity(join(await temp(), 'phone'));
    const { d, port } = await door(identity);
    const phone = phoneKey();
    const guess = (code: string) => (c: { mac: string; nonce: string }) => ({ type: 'phone-pair', code, device: { name: 'x' }, key: phone.key, signature: signed(phone.privateKey, challengeText('pair', c.mac, c.nonce)) });
    try {
      const { code } = d.startPairing();
      const closes = [];
      for (let i = 0; i < 5; i++) closes.push((await knock(port, identity.pin, guess(`guess-${i}`))).closed);
      expect(closes).toEqual([DOOR_CLOSE.refused, DOOR_CLOSE.refused, DOOR_CLOSE.refused, DOOR_CLOSE.refused, DOOR_CLOSE.busy]);
      expect(d.pairing).toBeNull();
      expect((await knock(port, identity.pin, guess(code))).closed).toBe(DOOR_CLOSE.refused); // even the right one, now
    } finally {
      d.close();
    }
  });
});
