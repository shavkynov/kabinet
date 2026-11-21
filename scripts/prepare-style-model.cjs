'use strict';

// Подготавливает ресурсы встроенной офлайн-модели Russian-GSD и уведомления о лицензиях
// перед сборкой установщиков Tauri. Файл .udpipe не хранится в Git: берётся из кэша,
// переменной KABINET_STYLE_MODEL, ~/Downloads или скачивается с проверкой SHA-256.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL_NAME = 'russian-gsd-ud-2.5-191206.udpipe';
const EXPECTED_SHA256 = 'ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a';
const MODEL_URLS = [
  'https://raw.githubusercontent.com/jwijffels/udpipe.models.ud.2.5/master/inst/udpipe-ud-2.5-191206/russian-gsd-ud-2.5-191206.udpipe',
  'https://lindat.mff.cuni.cz/repository/xmlui/bitstream/handle/11234/1-3131/russian-gsd-ud-2.5-191206.udpipe',
];

const root = path.join(__dirname, '..');
const resRoot = path.join(root, 'experiments', 'tauri-app', 'src-tauri', 'resources');
const modelsDir = path.join(resRoot, 'style-models');
const licensesDir = path.join(resRoot, 'licenses');
const target = path.join(modelsDir, MODEL_NAME);

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function copyLicenses() {
  const srcDir = path.join(root, 'docs', 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(licensesDir, name));
    }
  }
}

async function downloadModel(destTmp) {
  let lastErr = null;
  for (const url of MODEL_URLS) {
    try {
      console.log(`Скачиваю ${MODEL_NAME} из ${url}…`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destTmp, buf);
      const actual = sha256File(destTmp);
      if (actual !== EXPECTED_SHA256) {
        throw new Error(`SHA-256 не совпал: ${actual} вместо ${EXPECTED_SHA256}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      try { fs.rmSync(destTmp, { force: true }); } catch { /* ignore */ }
      console.warn(`Источник недоступен (${url}): ${err.message}`);
    }
  }
  throw lastErr || new Error('Не удалось скачать файл модели');
}

async function main() {
  copyLicenses();
  fs.mkdirSync(modelsDir, { recursive: true });
  for (const placeholder of ['.keep', 'placeholder.txt']) {
    try { fs.rmSync(path.join(modelsDir, placeholder), { force: true }); } catch { /* ignore */ }
  }

  if (fs.existsSync(target) && sha256File(target) === EXPECTED_SHA256) {
    console.log(`Модель уже подготовлена: ${target}`);
    return;
  }

  const candidates = [
    process.env.KABINET_STYLE_MODEL,
    path.join(os.homedir(), 'Downloads', MODEL_NAME),
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile() && sha256File(cand) === EXPECTED_SHA256) {
      fs.copyFileSync(cand, target);
      console.log(`Скопирована локальная модель из ${cand}`);
      return;
    }
  }

  const tmp = `${target}.tmp.${process.pid}`;
  await downloadModel(tmp);
  fs.renameSync(tmp, target);
  console.log(`Модель загружена и проверена (SHA-256 ok): ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
