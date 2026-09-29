import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pairingLink, readPairingLink } from '../src/phone.ts';
import { qrCode, qrPath, type QrCode } from '../src/qr.ts';

/** The code as a greyscale PNG, 8 pixels a module, with the 4-module light margin readers expect. */
function png(code: QrCode) {
  const scale = 8;
  const side = (code.size + 8) * scale;
  const rows = Buffer.alloc(side * (side + 1), 255);
  for (let y = 0; y < side; y++) {
    rows[y * (side + 1)] = 0; // no filter
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - 4;
      const my = Math.floor(y / scale) - 4;
      if (code.modules[my]?.[mx]) rows[y * (side + 1) + 1 + x] = 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8 bits, greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** The format information as read back from the symbol: its level and mask, if its BCH code checks out. */
function formatOf(code: QrCode) {
  const m = code.modules;
  let bits = 0;
  const read = [...[0, 1, 2, 3, 4, 5, 7, 8].map((y) => m[y]![8]!), m[8]![7]!, ...[5, 4, 3, 2, 1, 0].map((x) => m[8]![x]!)];
  read.forEach((dark, i) => (bits |= (dark ? 1 : 0) << i));
  const value = bits ^ 0x5412;
  let rem = value >>> 10;
  const data = rem;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return { ok: (((data << 10) | rem) & 0x7fff) === value, level: ['M', 'L', 'H', 'Q'][data >>> 3], mask: data & 7 };
}

describe('QR codes', () => {
  it('picks the smallest version that holds the text', () => {
    expect(qrCode('HELLO WORLD').version).toBe(1);
    expect(qrCode('x'.repeat(14)).version).toBe(1); // 16 data codewords at M: 14 bytes and their header fill it
    expect(qrCode('x'.repeat(15)).version).toBe(2);
    expect(qrCode('x'.repeat(152)).version).toBe(8);
    expect(qrCode('x'.repeat(153)).version).toBe(9);
    expect(() => qrCode('x'.repeat(3000))).toThrow(/Too long/);
  });

  it('draws the finder, timing and dark modules where readers look for them', () => {
    const code = qrCode('https://example.com/nova');
    const { size, modules: m } = code;
    expect(size).toBe(17 + 4 * code.version);
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      for (let d = 0; d < 7; d++) {
        expect(m[y0]![x0 + d]).toBe(true); // the finder's outer ring
        expect(m[y0 + 3]![x0 + 3]).toBe(true); // its centre
      }
      expect(m[y0 + 1]![x0 + 1]).toBe(false); // the light ring inside it
    }
    for (let i = 8; i < size - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[size - 8]![8]).toBe(true);
    expect(qrPath(code)).toMatch(/^M\d+,\d+h1v1h-1z/);
  });

  it('writes format information that checks out, for each level', () => {
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const f = formatOf(qrCode('Nova on the iPhone', level));
      expect(f).toMatchObject({ ok: true, level });
      expect(f.mask).toBeGreaterThanOrEqual(0);
    }
  });

  // macOS reads QR codes itself (Core Image): what it reads back must be exactly what went in.
  const swift = process.platform === 'darwin' && !spawnSync('swift', ['--version']).error;
  it.skipIf(!swift)('reads back as the same text on macOS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-qr-'));
    try {
      const reader = join(dir, 'read.swift');
      writeFileSync(
        reader,
        `import CoreImage
import Foundation
for path in CommandLine.arguments.dropFirst() {
  let image = CIImage(contentsOf: URL(fileURLWithPath: path))!
  let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
  let text = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first ?? ""
  print(Data(text.utf8).base64EncodedString())
}
`,
      );
      const link = pairingLink({ mac: 'qmv0mS2lG9dvZr8pA1hXzw', name: 'Nova on Ama’s MacBook Pro', hosts: ['192.168.1.23', '100.101.102.103'], port: 7879, pin: 'n4bQgYhMLqWVNdzUbPrXxJ2mPZcDs6GwZ4IxVv0kC1c', code: 'm2ZrV0bq6FQ3n1pX8yT4dw' });
      const texts = ['HELLO WORLD', 'Nova on the iPhone - ä ö ü, ☀︎', link, 'y'.repeat(400)];
      const files = texts.map((text, i) => {
        const file = join(dir, `${i}.png`);
        writeFileSync(file, png(qrCode(text)));
        return file;
      });
      const read = execFileSync('swift', [reader, ...files], { encoding: 'utf8', timeout: 120_000 })
        .trim()
        .split('\n')
        .map((b) => Buffer.from(b, 'base64').toString('utf8'));
      expect(read).toEqual(texts);
      expect(readPairingLink(read[2]!)).toMatchObject({ port: 7879, hosts: ['192.168.1.23', '100.101.102.103'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('pairing links', () => {
  const offer = { mac: 'qmv0mS2lG9dvZr8pA1hXzw', name: 'Nova on the Mac', hosts: ['192.168.1.23'], port: 7879, pin: 'n4bQgYhMLqWVNdzUbPrXxJ2mPZcDs6GwZ4IxVv0kC1c', code: 'm2ZrV0bq6FQ3n1pX8yT4dw' };
  it('carry everything a phone needs to find and trust the Mac', () => {
    expect(readPairingLink(pairingLink(offer))).toEqual(offer);
  });
  it('are refused when anything is missing or off', () => {
    const link = pairingLink(offer);
    expect(readPairingLink(link.replace('v=1', 'v=2'))).toBeNull();
    expect(readPairingLink(link.replace(/&k=[^&]+/, ''))).toBeNull();
    expect(readPairingLink(link.replace('p=7879', 'p=99999'))).toBeNull();
    expect(readPairingLink('https://example.com/?v=1')).toBeNull();
  });
});
