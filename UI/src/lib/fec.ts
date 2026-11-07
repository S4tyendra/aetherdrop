// Systematic Cauchy Reed-Solomon erasure coding over GF(2^8).
// Wire-compatible with the original dist/index.html implementation.

export const SHARD_SIZE = 32768; // 32 KB per packet
export const K = 16; // data shards per block
export const M = 4; // parity shards per block (25% redundancy)
export const N = K + M;
export const BLOCK_SIZE = K * SHARD_SIZE; // 512 KB per coding block

const gfExp = new Uint8Array(512);
const gfLog = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
})();

function gfMul(a: number, b: number) {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}

function gfDiv(a: number, b: number) {
  if (a === 0) return 0;
  if (b === 0) throw new Error("GF division by zero");
  return gfExp[gfLog[a] - gfLog[b] + 255];
}

function makeCauchyMatrix(k: number, m: number) {
  const matrix = new Uint8Array(m * k);
  for (let i = 0; i < m; i++) {
    const x = i + k;
    for (let j = 0; j < k; j++) matrix[i * k + j] = gfDiv(1, x ^ j);
  }
  return matrix;
}

const CAUCHY = makeCauchyMatrix(K, M);

function invertMatrix(matrix: Uint8Array, n: number) {
  const w = 2 * n;
  const aug = new Uint8Array(n * w);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * w + j] = matrix[i * n + j];
    aug[i * w + n + i] = 1;
  }

  for (let c = 0; c < n; c++) {
    let pivot = -1;
    for (let r = c; r < n; r++) {
      if (aug[r * w + c] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) throw new Error("Matrix is singular (erasure recovery failed)");

    if (pivot !== c) {
      for (let j = 0; j < w; j++) {
        const t = aug[c * w + j];
        aug[c * w + j] = aug[pivot * w + j];
        aug[pivot * w + j] = t;
      }
    }

    const pv = aug[c * w + c];
    if (pv !== 1) {
      const inv = gfDiv(1, pv);
      for (let j = 0; j < w; j++) aug[c * w + j] = gfMul(aug[c * w + j], inv);
    }

    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = aug[r * w + c];
      if (f === 0) continue;
      for (let j = 0; j < w; j++) aug[r * w + j] ^= gfMul(aug[c * w + j], f);
    }
  }

  const out = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = aug[i * w + n + j];
  return out;
}

export function encodeBlock(dataShards: Uint8Array[]) {
  const parity: Uint8Array[] = [];
  for (let i = 0; i < M; i++) parity.push(new Uint8Array(SHARD_SIZE));
  for (let b = 0; b < SHARD_SIZE; b++) {
    for (let i = 0; i < M; i++) {
      let sum = 0;
      for (let j = 0; j < K; j++) sum ^= gfMul(CAUCHY[i * K + j], dataShards[j][b]);
      parity[i][b] = sum;
    }
  }
  return parity;
}

export type Shard = { idx: number; data: Uint8Array };

export function reconstructBlock(received: Shard[]): Uint8Array[] {
  const data = received.filter((s) => s.idx < K);
  if (data.length === K) return data.sort((a, b) => a.idx - b.idx).map((s) => s.data);

  received.sort((a, b) => a.idx - b.idx);
  const G = new Uint8Array(K * K);
  for (let i = 0; i < K; i++) {
    const idx = received[i].idx;
    if (idx < K) G[i * K + idx] = 1;
    else for (let j = 0; j < K; j++) G[i * K + j] = CAUCHY[(idx - K) * K + j];
  }

  const Ginv = invertMatrix(G, K);
  const out: Uint8Array[] = [];
  for (let j = 0; j < K; j++) out.push(new Uint8Array(SHARD_SIZE));
  for (let b = 0; b < SHARD_SIZE; b++) {
    for (let r = 0; r < K; r++) {
      let sum = 0;
      for (let c = 0; c < K; c++) sum ^= gfMul(Ginv[r * K + c], received[c].data[b]);
      out[r][b] = sum;
    }
  }
  return out;
}
