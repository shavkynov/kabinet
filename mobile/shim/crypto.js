'use strict';
// createHash('md5' | 'sha1' | 'sha256').update().digest(), randomBytes и timingSafeEqual без зависимостей, синхронно.
// Нужны общему коду из src/: PKCE входа в Яндекс (SHA-256) и проверка загруженных файлов Яндекс Диска (MD5).

function utf8(str) { return new TextEncoder().encode(String(str)); }

function toBytes(data) {
  if (typeof data === 'string') return utf8(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** Дополняет сообщение до целого числа 64-байтных блоков; длина в битах записана в конце. */
function pad(bytes, littleEndian) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const hi = Math.floor(len / 0x20000000);
  const lo = (len << 3) >>> 0;
  if (littleEndian) {
    dv.setUint32(padded.length - 8, lo, true);
    dv.setUint32(padded.length - 4, hi, true);
  } else {
    dv.setUint32(padded.length - 8, hi, false);
    dv.setUint32(padded.length - 4, lo, false);
  }
  return { padded, dv };
}

function wordsToBytes(words, littleEndian) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < words.length; i += 1) dv.setUint32(i * 4, words[i] >>> 0, littleEndian);
  return out;
}

function sha1(bytes) {
  const { padded, dv } = pad(bytes, false);
  const h = Uint32Array.from([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j += 1) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let j = 0; j < 80; j += 1) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  return wordsToBytes(h, false);
}

// Константы SHA-256 — дробные части корней первых простых чисел (проверяется тестом против Node).
const PRIMES = (() => {
  const out = [];
  for (let n = 2; out.length < 64; n += 1) if (out.every((p) => n % p)) out.push(n);
  return out;
})();
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
const K256 = PRIMES.map((p) => frac32(Math.cbrt(p)));
const H256 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));

function sha256(bytes) {
  const { padded, dv } = pad(bytes, false);
  const h = Uint32Array.from(H256);
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j += 1) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = w[j - 16] + s0 + w[j - 7] + s1;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let j = 0; j < 64; j += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[j] + w[j]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return wordsToBytes(h, false);
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

function md5(bytes) {
  const { padded, dv } = pad(bytes, true);
  const h = Uint32Array.from([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const m = new Uint32Array(16);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = dv.getUint32(i + j * 4, true);
    let a = h[0], b = h[1], c = h[2], d = h[3];
    for (let j = 0; j < 64; j += 1) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      f = (f + a + MD5_K[j] + m[g]) >>> 0;
      a = d; d = c; c = b; b = (b + rotl(f, MD5_SHIFTS[j])) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
  }
  return wordsToBytes(h, true);
}

const ALGORITHMS = { md5, sha1, sha256 };

function base64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function createHash(algo) {
  const compute = ALGORITHMS[String(algo).toLowerCase().replace('-', '')];
  if (!compute) throw new Error(`Хэш ${algo} не поддерживается`);
  const chunks = [];
  const api = {
    update(data) { chunks.push(toBytes(data)); return api; },
    digest(enc) {
      let n = 0;
      for (const c of chunks) n += c.length;
      const all = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      const bytes = compute(all);
      if (enc === undefined) { const B = globalThis.Buffer; return B ? B.from(bytes) : bytes; }
      if (enc === 'hex') return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
      if (enc === 'base64') return base64(bytes);
      if (enc === 'base64url') return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      throw new Error('Поддерживаются digest(), digest("hex"), digest("base64") и digest("base64url")');
    },
  };
  return api;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  const B = globalThis.Buffer;
  return B ? B.from(a) : a;
}

/** Сравнение за одинаковое время; длины должны совпадать (как в Node). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

module.exports = { createHash, randomBytes, timingSafeEqual };
