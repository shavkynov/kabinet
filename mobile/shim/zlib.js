'use strict';
// deflateRawSync / inflateRawSync поверх fflate (подключается при сборке под Android).
const { deflateSync, inflateSync } = require('fflate');
const B = () => globalThis.Buffer;
module.exports = {
  deflateRawSync: (buf) => B().from(deflateSync(Uint8Array.from(buf))),
  inflateRawSync: (buf, opts) => {
    const out = inflateSync(Uint8Array.from(buf));
    if (opts && opts.maxOutputLength && out.length > opts.maxOutputLength) throw new Error('Слишком большой файл внутри архива');
    return B().from(out);
  },
};
