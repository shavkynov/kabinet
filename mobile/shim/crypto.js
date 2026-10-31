'use strict';
// createHash('sha1' | 'sha256').update().digest('hex') и randomBytes — без зависимостей, синхронно.

function utf8(str) { return new TextEncoder().encode(String(str)); }

function sha1(bytes) {
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(padded.length - 4, (len << 3) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j += 1) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j += 1) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function createHash(algo) {
  if (String(algo).toLowerCase() !== 'sha1') throw new Error(`Хэш ${algo} не поддерживается`);
  const chunks = [];
  const api = {
    update(data) { chunks.push(typeof data === 'string' ? utf8(data) : Uint8Array.from(data)); return api; },
    digest(enc) {
      let n = 0;
      for (const c of chunks) n += c.length;
      const all = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      const hex = sha1(all);
      if (enc === 'hex') return hex;
      throw new Error('Поддерживается только digest("hex")');
    },
  };
  return api;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(a);
  const B = globalThis.Buffer;
  return B ? B.from(a) : a;
}

module.exports = { createHash, randomBytes };
