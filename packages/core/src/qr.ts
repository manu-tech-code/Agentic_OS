/**
 * QR codes, made in code (ISO/IEC 18004): text in byte mode, the smallest version that holds it at the
 * error correction level asked for, and the mask the standard's penalty rules pick. It draws the
 * iPhone's pairing code (phone.ts) - nothing to download, nothing sent anywhere to be drawn.
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  version: number;
  /** Modules on a side: 17 + 4 × version. */
  size: number;
  /** Row by row, true for a dark module. */
  modules: boolean[][];
}

const LEVEL: Record<QrLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Each level's two bits in the format information (the standard orders them M, L, H, Q). */
const FORMAT_LEVEL: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// By level, then version (index 0 unused): error correction codewords in each block, and how many blocks.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules that carry codewords (data and error correction, with any remainder bits) in a version. */
function rawModules(version: number) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (version: number, level: number) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[level]![version]! * BLOCKS[level]![version]!;

/** Where the alignment patterns' centres go, on each axis. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let at = 17 + 4 * version - 7; positions.length < count; at -= step) positions.splice(1, 0, at);
  return positions;
}

// Reed-Solomon over GF(256), with the polynomial the standard uses (x⁸ + x⁴ + x³ + x² + 1).
function multiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number) {
  const result: number[] = new Array(degree - 1).fill(0).concat(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = multiply(root, 2);
  }
  return result;
}

function remainder(data: number[], by: number[]) {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    by.forEach((coefficient, i) => (result[i]! ^= multiply(coefficient, factor)));
  }
  return result;
}

/** The data split into blocks, each with its error correction, interleaved as the symbol holds them. */
function codewords(data: number[], version: number, level: number) {
  const blocks = BLOCKS[level]![version]!;
  const eccLength = ECC_PER_BLOCK[level]![version]!;
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const by = divisor(eccLength);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < short ? 0 : 1));
    k += block.length;
    const ecc = remainder(block, by);
    if (i < short) block.push(0); // a place holder, so every block lines up; skipped below
    all.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= short) result.push(block[i]!);
    });
  }
  return result;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** How hard a symbol is to read, by the standard's four rules: lower is better. */
function penalty(m: boolean[][]) {
  const size = m.length;
  let score = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]!))];
  // A run of five or more alike; and anything that looks like a finder pattern, with light space either side.
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i + 1 === size || line[i + 1] !== line[i]) {
        if (run >= 5) score += 3 + run - 5;
        run = 0;
      }
    }
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let i = 0; i + 7 <= padded.length; i++) {
      if (!finder.every((dark, j) => padded[i + j] === dark)) continue;
      const before = padded.slice(Math.max(0, i - 4), i);
      const after = padded.slice(i + 7, i + 11);
      if ((before.length === 4 && before.every((d) => !d)) || (after.length === 4 && after.every((d) => !d))) score += 40;
    }
  }
  // Blocks of two by two alike.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  // Dark and light out of balance.
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The QR code for `text`, or an error when it's too long for any version at that level. */
export function qrCode(text: string, level: QrLevel = 'M'): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  // Anything beyond ASCII says it's UTF-8 (an ECI), so no reader guesses another encoding.
  const utf8 = bytes.some((b) => b > 127);
  const l = LEVEL[level];
  let version = 1;
  const countBits = (v: number) => (v <= 9 ? 8 : 16);
  const needed = (v: number) => (utf8 ? 12 : 0) + 4 + countBits(v) + bytes.length * 8;
  while (version <= 40 && needed(version) > dataCodewords(version, l) * 8) version++;
  if (version > 40) throw new Error(`Too long for a QR code: ${bytes.length} bytes.`);

  // The bit stream: byte mode, the length, the bytes, a terminator, then padding to fill the capacity.
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  if (utf8) (put(0b0111, 4), put(26, 8));
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, l) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };

  // Timing patterns, then the finder patterns (with their separators) and the alignment patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  align.forEach((ay, i) =>
    align.forEach((ax, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );

  const format = (mask: number) => {
    const value = (FORMAT_LEVEL[level] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((value << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // always dark
  };
  format(0); // reserves its modules; drawn for real once the mask is chosen
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // The codewords, in the zigzag the standard lays them out in: two columns at a time, up then down.
  const all = codewords(data, version, l);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y]![x] && i < all.length * 8) {
          modules[y]![x] = ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  // The mask that reads best.
  const masked = (mask: number) =>
    modules.map((row, y) => row.map((dark, x) => (!fixed[y]![x] && MASKS[mask]!(x, y) ? !dark : dark)));
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    format(mask);
    const score = penalty(masked(mask));
    if (score < bestScore) (best = mask), (bestScore = score);
  }
  format(best);
  return { version, size, modules: masked(best) };
}

/** An SVG path of the dark modules - one unit each - with a light margin of `margin` units left around it. */
export function qrPath(code: QrCode, margin = 4): string {
  let d = '';
  code.modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + margin},${y + margin}h1v1h-1z`)));
  return d;
}
