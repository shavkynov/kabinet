'use strict';
// Создаёт проект Android (mobile/android) вокруг mobile/www и подготавливает его к сборке:
// значки, плагин клавиатуры, подпись, режим экранной клавиатуры. Вызывать после mobile/build.js.
//   node mobile/android-setup.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname;
const android = path.join(here, 'android');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });

function patch(file, from, to, label) {
  const text = fs.readFileSync(file, 'utf8');
  const hit = typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) || []).length;
  if (hit < 1) throw new Error(`${path.basename(file)}: не найдено «${label}». Шаблон Capacitor изменился, правьте mobile/android-setup.js.`);
  fs.writeFileSync(file, text.replace(from, () => to));
}

if (!fs.existsSync(path.join(here, 'www', 'index.html'))) throw new Error('Сначала: node mobile/build.js');

if (!fs.existsSync(android)) run('npx', ['cap', 'add', 'android']);
run('npx', ['cap', 'sync', 'android']);

// Java: плагины клавиатуры, доступа к папке, сети и защищённого хранилища, а также MainActivity, которая их подключает.
// Список должен совпадать с registerPlugin(...) в MainActivity, иначе сборка не скомпилируется.
const javaDir = path.join(android, 'app', 'src', 'main', 'java', 'ru', 'kabinet', 'writer');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ['HwKeyboardPlugin.java', 'SafPlugin.java', 'DavPlugin.java', 'SecretsPlugin.java', 'MainActivity.java']) fs.copyFileSync(path.join(here, 'android-src', f), path.join(javaDir, f));

// WebDAV: плагин Dav использует OkHttp (в шаблоне Capacitor его может не быть).
{
  const appGradle = path.join(android, 'app', 'build.gradle');
  const text = fs.readFileSync(appGradle, 'utf8');
  if (!text.includes('com.squareup.okhttp3:okhttp')) {
    patch(appGradle, /dependencies\s*\{/, "dependencies {\n    implementation 'com.squareup.okhttp3:okhttp:4.12.0'", 'dependencies');
  }
}

// значки
const res = path.join(android, 'app', 'src', 'main', 'res');
function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b); } else fs.copyFileSync(a, b);
  }
}
copyTree(path.join(here, 'android-res'), res);

// манифест: экранная клавиатура сжимает окно, а не перекрывает текст
const manifest = path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml');
let m = fs.readFileSync(manifest, 'utf8');
if (!m.includes('windowSoftInputMode')) patch(manifest, '<activity', '<activity\n            android:windowSoftInputMode="adjustResize"', '<activity');

// Возврат из браузера после входа в Яндекс: kabinet://oauth/yandex?... открывает Кабинет, а @capacitor/app отдаёт адрес окну (appUrlOpen).
// Схема, хост и путь должны совпадать с callbackUri в src/yandex-oauth-config.json (это проверяет test/android-plugins.test.js).
if (!fs.readFileSync(manifest, 'utf8').includes('android:scheme="kabinet"')) {
  const filter = '    <intent-filter>\n' +
    '                <action android:name="android.intent.action.VIEW" />\n' +
    '                <category android:name="android.intent.category.DEFAULT" />\n' +
    '                <category android:name="android.intent.category.BROWSABLE" />\n' +
    '                <data android:scheme="kabinet" android:host="oauth" android:pathPrefix="/yandex" />\n' +
    '            </intent-filter>\n        ';
  patch(manifest, '</activity>', `${filter}</activity>`, '</activity>');
}

// Подпись: один и тот же ключ во всех сборках, чтобы новая версия ставилась поверх старой без потери проектов.
// Ключ и пароли в репозитории не хранятся. Задаются переменными окружения (в GitHub — Secrets, см. android.yml):
//   KABINET_KEYSTORE            путь к файлу ключа (по умолчанию mobile/kabinet-release.keystore, если он лежит рядом)
//   KABINET_KEYSTORE_PASSWORD   пароль хранилища
//   KABINET_KEY_ALIAS           имя ключа (по умолчанию kabinet)
//   KABINET_KEY_PASSWORD        пароль ключа (по умолчанию как пароль хранилища)
// Если ключа нет, APK подписывается отладочным ключом: он ставится на телефон, но не как обновление боевой сборки.
const gradle = path.join(android, 'app', 'build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
if (!g.includes('signingConfig signingConfigs.')) {
  const ksPath = process.env.KABINET_KEYSTORE || path.join(here, 'kabinet-release.keystore');
  const storePass = process.env.KABINET_KEYSTORE_PASSWORD || '';
  const haveKey = fs.existsSync(ksPath) && storePass;
  const q = (v) => `'${String(v).replace(/\\/g, '/').replace(/'/g, "\\'")}'`;
  let block = '';
  let use = 'signingConfigs.debug';
  if (haveKey) {
    block = `signingConfigs {\n        release {\n            storeFile file(${q(ksPath)})\n            storePassword ${q(storePass)}\n            keyAlias ${q(process.env.KABINET_KEY_ALIAS || 'kabinet')}\n            keyPassword ${q(process.env.KABINET_KEY_PASSWORD || storePass)}\n        }\n    }\n    `;
    use = 'signingConfigs.release';
  } else {
    console.warn('ВНИМАНИЕ: ключ подписи не задан (KABINET_KEYSTORE_PASSWORD и файл ключа). APK будет подписан отладочным ключом.');
  }
  patch(gradle, /buildTypes\s*\{/, `${block}buildTypes {`, 'buildTypes');
  if (!/buildTypes\s*\{\s*release\s*\{/.test(fs.readFileSync(gradle, 'utf8'))) throw new Error('build.gradle: не найден блок release. Шаблон Capacitor изменился, правьте mobile/android-setup.js.');
  g = fs.readFileSync(gradle, 'utf8');
  g = g.replace(/(buildTypes\s*\{\s*release\s*\{)/, `$1\n            signingConfig ${use}`);
  if (!g.includes(`signingConfig ${use}`)) throw new Error('build.gradle: не удалось подключить подпись.');
  fs.writeFileSync(gradle, g);
}
console.log('Проект Android готов: mobile/android. Сборка: cd mobile/android && ./gradlew assembleRelease');
