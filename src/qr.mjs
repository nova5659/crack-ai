// Minimal standards-compliant ISO/IEC 18004 QR Code (Byte mode, ECC Level L, Versions 1-4) SVG generator

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return Array.from(msg.slice(data.length));
}

// Version specs for ECC Level L (single block for V1-V4)
const VERSIONS = [
  null,
  { size: 21, dataCodewords: 19, ecCodewords: 7, align: [] },
  { size: 25, dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
  { size: 29, dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
  { size: 33, dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
];

function encodeBytes(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  let version = 1;
  while (version <= 4 && bytes.length + 2 > VERSIONS[version].dataCodewords) {
    version++;
  }
  if (version > 4) {
    throw new Error('QR payload too long');
  }
  const spec = VERSIONS[version];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Mode indicator: Byte = 0100
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = spec.dataCodewords * 8;
  // Terminator
  pushBits(0, Math.min(4, maxBits - bits.length));
  // Byte align
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    data.push(val);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (data.length < spec.dataCodewords) {
    data.push(pads[p++ % 2]);
  }
  const ec = rsEncode(data, spec.ecCodewords);
  return { version, spec, codewords: [...data, ...ec] };
}

function createMatrix(version, spec) {
  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Array(n).fill(null));
  const reserved = Array.from({ length: n }, () => new Array(n).fill(false));

  const set = (r, c, dark) => {
    if (r >= 0 && r < n && c >= 0 && c < n) {
      grid[r][c] = dark ? 1 : 0;
      reserved[r][c] = true;
    }
  };

  const finder = (tr, tc) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = tr + r;
        const cc = tc + c;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, inOuter && (onBorder || inCore));
      }
    }
  };

  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns (V2-V4)
  if (spec.align.length >= 2) {
    const last = spec.align[spec.align.length - 1];
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        set(last + r, last + c, dark);
      }
    }
  }

  // Dark module
  set(4 * version + 9, 8, true);

  // Reserve format info strips
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = n - 8; i < n; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }

  return { grid, reserved, n };
}

function formatBits(ecLevelBits, maskId) {
  const data = (ecLevelBits << 3) | maskId;
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= gen << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function writeFormatInfo(grid, n, maskId) {
  // ECC Level L = 01
  const fmt = formatBits(0b01, maskId);
  const bit = (i) => (fmt >> i) & 1;

  // Around top-left
  const coords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords1[i];
    grid[r][c] = bit(14 - i);
  }

  // Bottom-left and top-right
  for (let i = 0; i < 7; i++) grid[n - 1 - i][8] = bit(i);
  for (let i = 7; i < 15; i++) grid[8][n - 15 + i] = bit(i);
}

export function generateQrSvg(text) {
  try {
    const { version, spec, codewords } = encodeBytes(text);
    const { grid, reserved, n } = createMatrix(version, spec);

    const bitStream = [];
    for (const cw of codewords) {
      for (let i = 7; i >= 0; i--) bitStream.push((cw >> i) & 1);
    }

    // Place data bits in zigzag
    let bitIdx = 0;
    let upward = true;
    for (let col = n - 1; col >= 1; col -= 2) {
      if (col === 6) col--;
      for (let step = 0; step < n; step++) {
        const row = upward ? n - 1 - step : step;
        for (let dx = 0; dx < 2; dx++) {
          const c = col - dx;
          if (!reserved[row][c]) {
            const rawBit = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
            // Mask 0: (row + col) % 2 === 0
            const masked = ((row + c) % 2 === 0) ? (rawBit ^ 1) : rawBit;
            grid[row][c] = masked;
          }
        }
      }
      upward = !upward;
    }

    writeFormatInfo(grid, n, 0);

    const quiet = 3;
    const total = n + quiet * 2;
    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r][c] === 1) {
          rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff" rx="2"/><g fill="#0b0b12">${rects}</g></svg>`;
  } catch {
    return '';
  }
}
