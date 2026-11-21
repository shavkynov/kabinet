'use strict';

// Подготавливает ресурсы встроенных офлайн-модулей перед сборкой установщиков Tauri:
//   - языковая модель Russian-GSD (style-models/russian-gsd-ud-2.5-191206.udpipe)
//   - словари офлайн-орфографии ru и en (dictionaries/{ru,en}.{dic,aff})
//   - лицензионные уведомления (licenses/*)
// Бинарные модели и словари не хранятся в Git: берутся из кэша, переменных окружения
// (KABINET_STYLE_MODEL / KABINET_SPELL_DIR), ~/Downloads или скачиваются с проверкой SHA-256.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL_NAME = 'russian-gsd-ud-2.5-191206.udpipe';
const EXPECTED_MODEL_SHA256 = 'ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a';
const MODEL_URLS = [
  'https://raw.githubusercontent.com/jwijffels/udpipe.models.ud.2.5/master/inst/udpipe-ud-2.5-191206/russian-gsd-ud-2.5-191206.udpipe',
  'https://lindat.mff.cuni.cz/repository/xmlui/bitstream/handle/11234/1-3131/russian-gsd-ud-2.5-191206.udpipe',
];

const DICTS = [
  {
    name: 'ru.dic',
    sha256: 'f6047416a0204adbecf3a451b874ec8a97ee37e2cbc714466ef04d8dbcc0d6fc',
    urls: ['https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/ru/index.dic'],
  },
  {
    name: 'ru.aff',
    sha256: '38ce7d4af78e211e9bafe4bf7e3d6a2c420591136cb738ec6648f8fdf6524cd7',
    urls: ['https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/ru/index.aff'],
  },
  {
    name: 'en.dic',
    sha256: 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647',
    urls: ['https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic'],
  },
  {
    name: 'en.aff',
    sha256: '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b',
    urls: ['https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.aff'],
  },
];

const root = path.join(__dirname, '..');
const resRoot = path.join(root, 'desktop', 'src-tauri', 'resources');
const modelsDir = path.join(resRoot, 'style-models');
const dictsDir = path.join(resRoot, 'dictionaries');
const licensesDir = path.join(resRoot, 'licenses');

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

async function downloadWithSha(urls, expectedSha, destTmp, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      console.log(`Скачиваю ${label} из ${url}…`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destTmp, buf);
      const actual = sha256File(destTmp);
      if (actual !== expectedSha) {
        throw new Error(`SHA-256 не совпал: ${actual} вместо ${expectedSha}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      try { fs.rmSync(destTmp, { force: true }); } catch { /* ignore */ }
      console.warn(`Источник недоступен (${url}): ${err.message}`);
    }
  }
  throw lastErr || new Error(`Не удалось скачать ${label}`);
}

async function ensureAsset({ dir, name, expectedSha, urls, localCandidates }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const placeholder of ['.keep', 'placeholder.txt']) {
    try { fs.rmSync(path.join(dir, placeholder), { force: true }); } catch { /* ignore */ }
  }
  const target = path.join(dir, name);
  if (fs.existsSync(target) && sha256File(target) === expectedSha) {
    console.log(`Ресурс уже подготовлен: ${target}`);
    return;
  }
  for (const cand of localCandidates.filter(Boolean)) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile() && sha256File(cand) === expectedSha) {
      fs.copyFileSync(cand, target);
      console.log(`Скопирован локальный ресурс: ${cand} -> ${target}`);
      return;
    }
  }
  const tmp = `${target}.tmp.${process.pid}`;
  await downloadWithSha(urls, expectedSha, tmp, name);
  fs.renameSync(tmp, target);
  console.log(`Ресурс загружен и проверен (SHA-256 ok): ${target}`);
}

async function main() {
  copyLicenses();

  await ensureAsset({
    dir: modelsDir,
    name: MODEL_NAME,
    expectedSha: EXPECTED_MODEL_SHA256,
    urls: MODEL_URLS,
    localCandidates: [
      process.env.KABINET_STYLE_MODEL,
      path.join(os.homedir(), 'Downloads', MODEL_NAME),
    ],
  });

  const envDictDir = process.env.KABINET_SPELL_DIR;
  for (const d of DICTS) {
    await ensureAsset({
      dir: dictsDir,
      name: d.name,
      expectedSha: d.sha256,
      urls: d.urls,
      localCandidates: [
        envDictDir ? path.join(envDictDir, d.name) : null,
        path.join(os.homedir(), 'Downloads', d.name),
      ],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
