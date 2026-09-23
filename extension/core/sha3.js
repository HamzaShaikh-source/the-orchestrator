/* sha3.js — SHA3-512 (Keccak-f[1600]) in pure JS (BigInt lanes).
   Needed for the ChatGPT sentinel proof-of-work; Web Crypto has no SHA3. */

const RATE = 72; // SHA3-512: rate = 1600 - 2*512 = 576 bits = 72 bytes

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK = 0xffffffffffffffffn;

function rol(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = [];
    for (let x = 0; x < 5; x++) {
      c[x] = state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x][y] ^= d;
    }
    // rho + pi
    const b = Array.from({ length: 5 }, () => new Array(5));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y][(2 * x + 3 * y) % 5] = rol(state[x][y], ROT[x][y]);
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]);
      }
    }
    // iota
    state[0][0] ^= RC[round];
  }
}

function absorb(state, block) {
  for (let i = 0; i < RATE; i++) {
    const laneIdx = Math.floor(i / 8);
    const bytePos = i % 8;
    state[laneIdx % 5][Math.floor(laneIdx / 5)] ^= BigInt(block[i]) << BigInt(8 * bytePos);
  }
  keccakF(state);
}

function squeeze(state, out) {
  let idx = 0;
  let laneIdx = 0;
  while (idx < 64) {
    const lane = state[laneIdx % 5][Math.floor(laneIdx / 5)];
    for (let b = 0; b < 8 && idx < 64; b++) {
      out[idx++] = Number((lane >> BigInt(8 * b)) & 0xffn);
    }
    laneIdx++;
    // 64 output bytes < rate (72), so a single pass suffices; no re-permutation.
  }
}

/** sha3_512(bytes) -> Uint8Array (64 bytes) */
export function sha3_512(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const state = Array.from({ length: 5 }, () => new Array(5).fill(0n));

  // pad10*1 with domain 0x06 (SHA3)
  const paddedLen = Math.ceil((data.length + 1) / RATE) * RATE;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x06;
  padded[paddedLen - 1] |= 0x80;

  for (let off = 0; off < paddedLen; off += RATE) {
    absorb(state, padded.subarray(off, off + RATE));
  }

  const out = new Uint8Array(64);
  squeeze(state, out);
  return out;
}