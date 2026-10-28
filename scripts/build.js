'use strict';

// Сборка окна: склеиваем части renderer/app/*.js и собираем esbuild-ом в renderer/dist/app.js.
const path = require('path');
const { buildApp } = require('./concat');

const entry = buildApp();
require('esbuild').build({
  entryPoints: [entry],
  bundle: true,
  outfile: path.join(__dirname, '..', 'renderer', 'dist', 'app.js'),
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
}).catch(() => process.exit(1));
