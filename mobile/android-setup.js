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

// Java: плагин клавиатуры и MainActivity, которая его подключает
const javaDir = path.join(android, 'app', 'src', 'main', 'java', 'ru', 'kabinet', 'writer');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ['HwKeyboardPlugin.java', 'MainActivity.java']) fs.copyFileSync(path.join(here, 'android-src', f), path.join(javaDir, f));

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

// подпись: один и тот же ключ во всех сборках, чтобы новая версия ставилась поверх старой без потери проектов
const gradle = path.join(android, 'app', 'build.gradle');
const g = fs.readFileSync(gradle, 'utf8');
if (!g.includes('kabinet-release.keystore')) {
  const ks = path.join(here, 'kabinet-release.keystore').replace(/\\/g, '/');
  // отдельный блок в конце файла: не зависит от того, как написан шаблон Capacitor
  fs.appendFileSync(gradle, `
// подпись релизной сборки (mobile/android-setup.js)
android {
    signingConfigs {
        kabinetRelease {
            storeFile file('${ks}')
            storePassword 'kabinet-writer'
            keyAlias 'kabinet'
            keyPassword 'kabinet-writer'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.kabinetRelease
        }
    }
}
`);
}
console.log('Проект Android готов: mobile/android. Сборка: cd mobile/android && ./gradlew assembleRelease');
