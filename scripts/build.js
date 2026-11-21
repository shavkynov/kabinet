'use strict';

// Сборка окна: склеиваем части renderer/app/*.js и собираем esbuild-ом в renderer/dist/app.js.
const path = require('path');
const { buildApp } = require('./concat');

const entry = buildApp();
const dev = process.env.KABINET_DEV === '1';
const sourcemap = process.env.KABINET_SOURCEMAP === '1';
require('esbuild').build({
  entryPoints: [entry],
  bundle: true,
  outfile: path.join(__dirname, '..', 'renderer', 'dist', 'app.js'),
  format: 'iife',
  target: 'chrome120',
  minify: !dev,
  sourcemap,
  logLevel: 'info',
}).catch(() => process.exit(1));
