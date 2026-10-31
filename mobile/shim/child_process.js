'use strict';
module.exports = { execFile: (_cmd, _args, cb) => { if (typeof cb === 'function') cb(new Error('not supported')); } };
