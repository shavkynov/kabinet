'use strict';

// Синхронизирует номер версии во всех манифестах и lock-файлах проекта:
//   node scripts/bump-version.js 0.42.0

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Использование: node scripts/bump-version.js <X.Y.Z>');
  process.exit(1);
}

function replaceRegex(relPath, re, replacement, label) {
  const full = path.join(ROOT, relPath);
  const src = fs.readFileSync(full, 'utf8');
  if (!re.test(src)) {
    throw new Error(`${relPath}: не найден фрагмент (${label})`);
  }
  const updated = src.replace(re, replacement);
  fs.writeFileSync(full, updated);
  console.log(`  ok  ${relPath} -> ${next}`);
}

function replaceCargoPkg(relPath, pkgName) {
  const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${pkgName}"\\r?\\nversion = ")[^"]+(")`);
  replaceRegex(relPath, re, `$1${next}$2`, `Cargo.lock package ${pkgName}`);
}

replaceRegex('package.json', /("version":\s*")[^"]+(")/, `$1${next}$2`, 'package.json version');
replaceRegex(
  'package-lock.json',
  /("name":\s*"kabinet",\r?\n\s*"version":\s*")[^"]+("[\s\S]*?"packages":\s*\{\r?\n\s*"":\s*\{\r?\n\s*"name":\s*"kabinet",\r?\n\s*"version":\s*")[^"]+(")/,
  `$1${next}$2${next}$3`,
  'package-lock.json root version',
);
replaceRegex('mobile/package.json', /("version":\s*")[^"]+(")/, `$1${next}$2`, 'mobile/package.json version');
replaceRegex('desktop/src-tauri/tauri.conf.json', /("version":\s*")[^"]+(")/, `$1${next}$2`, 'tauri.conf.json version');
replaceRegex('desktop/src-tauri/Cargo.toml', /(name = "kabinet-tauri"\r?\nversion = ")[^"]+(")/, `$1${next}$2`, 'src-tauri Cargo.toml');
replaceRegex('desktop/core/Cargo.toml', /(name = "kabinet-core"\r?\nversion = ")[^"]+(")/, `$1${next}$2`, 'core Cargo.toml');
replaceCargoPkg('desktop/core/Cargo.lock', 'kabinet-core');
replaceCargoPkg('desktop/src-tauri/Cargo.lock', 'kabinet-core');
replaceCargoPkg('desktop/src-tauri/Cargo.lock', 'kabinet-tauri');
