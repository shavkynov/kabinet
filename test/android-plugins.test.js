'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'mobile', 'android-src');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const config = JSON.parse(read('src', 'yandex-oauth-config.json'));

const javaFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.java')).sort();
const pluginClasses = javaFiles
  .filter((f) => /@CapacitorPlugin\s*\(/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')))
  .map((f) => f.replace(/\.java$/, ''))
  .sort();

test('android-setup copies every Java file from android-src', () => {
  const setup = read('mobile', 'android-setup.js');
  const list = /for \(const f of \[([^\]]+)\]\) fs\.copyFileSync/.exec(setup);
  assert.ok(list, 'не найден список Java-файлов в android-setup.js');
  const copied = [...list[1].matchAll(/'([^']+\.java)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(copied, javaFiles);
});

test('MainActivity registers exactly the plugins that exist', () => {
  const main = read('mobile', 'android-src', 'MainActivity.java');
  const registered = [...main.matchAll(/registerPlugin\(\s*(\w+)\.class\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(registered, pluginClasses);
  assert.ok(pluginClasses.includes('SecretsPlugin'));
});

test('callback URL in config matches the intent filter written by android-setup', () => {
  const setup = read('mobile', 'android-setup.js');
  const u = new URL(config.callbackUri);
  assert.ok(setup.includes(`android:scheme="${u.protocol.slice(0, -1)}"`));
  assert.ok(setup.includes(`android:host="${u.host}"`));
  assert.ok(setup.includes(`android:pathPrefix="${u.pathname}"`));
});

const TEMPLATE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const TEMPLATE_GRADLE = `apply plugin: 'com.android.application'

android {
    namespace "ru.kabinet.writer"
    compileSdk rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "ru.kabinet.writer"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
}
`;

// Запускает настоящий android-setup.js на копии шаблона Capacitor; вместо npx — пустая заглушка.
function runSetup(workDir) {
  const mobile = path.join(workDir, 'mobile');
  const env = { ...process.env, PATH: `${path.join(workDir, 'bin')}${path.delimiter}${process.env.PATH}` };
  delete env.KABINET_KEYSTORE;
  delete env.KABINET_KEYSTORE_PASSWORD;
  return execFileSync(process.execPath, [path.join(mobile, 'android-setup.js')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function prepare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-setup-'));
  const mobile = path.join(dir, 'mobile');
  const appMain = path.join(mobile, 'android', 'app', 'src', 'main');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(mobile, 'www'), { recursive: true });
  fs.writeFileSync(path.join(mobile, 'www', 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(mobile, 'android-res', 'mipmap-hdpi'), { recursive: true });
  fs.writeFileSync(path.join(mobile, 'android-res', 'mipmap-hdpi', 'ic.txt'), 'x');
  fs.mkdirSync(appMain, { recursive: true });
  fs.writeFileSync(path.join(appMain, 'AndroidManifest.xml'), TEMPLATE_MANIFEST);
  fs.writeFileSync(path.join(mobile, 'android', 'app', 'build.gradle'), TEMPLATE_GRADLE);
  fs.copyFileSync(path.join(root, 'mobile', 'android-setup.js'), path.join(mobile, 'android-setup.js'));
  fs.cpSync(srcDir, path.join(mobile, 'android-src'), { recursive: true });
  return { dir, mobile, appMain };
}

const skipWindows = { skip: process.platform === 'win32' ? 'нужна оболочка sh для заглушки npx' : false };

test('android-setup patches a Capacitor template: Java files, OAuth return filter, keyboard mode', skipWindows, (t) => {
  const { dir, mobile, appMain } = prepare();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runSetup(dir);
  const javaOut = path.join(appMain, 'java', 'ru', 'kabinet', 'writer');
  assert.deepEqual(fs.readdirSync(javaOut).sort(), javaFiles);
  const manifest = fs.readFileSync(path.join(appMain, 'AndroidManifest.xml'), 'utf8');
  assert.equal((manifest.match(/<intent-filter>/g) || []).length, 2);
  assert.equal((manifest.match(/<\/intent-filter>/g) || []).length, 2);
  assert.equal((manifest.match(/<\/activity>/g) || []).length, 1);
  assert.ok(manifest.includes('android:windowSoftInputMode="adjustResize"'));
  const activity = manifest.slice(manifest.indexOf('<activity'), manifest.indexOf('</activity>'));
  const u = new URL(config.callbackUri);
  assert.ok(activity.includes('android.intent.action.VIEW'));
  assert.ok(activity.includes('android.intent.category.BROWSABLE'));
  assert.ok(activity.includes(`<data android:scheme="${u.protocol.slice(0, -1)}" android:host="${u.host}" android:pathPrefix="${u.pathname}" />`));
  assert.ok(activity.includes('android:launchMode="singleTask"'));
  assert.ok(fs.readFileSync(path.join(mobile, 'android', 'app', 'build.gradle'), 'utf8').includes('signingConfigs.debug'));
});

test('android-setup is idempotent: a second run does not duplicate the filter', skipWindows, (t) => {
  const { dir, appMain } = prepare();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runSetup(dir);
  const first = fs.readFileSync(path.join(appMain, 'AndroidManifest.xml'), 'utf8');
  runSetup(dir);
  assert.equal(fs.readFileSync(path.join(appMain, 'AndroidManifest.xml'), 'utf8'), first);
});

test('SecretsPlugin never stores readable values and handles a lost key', () => {
  const java = read('mobile', 'android-src', 'SecretsPlugin.java');
  assert.match(java, /@CapacitorPlugin\(name = "Secrets"\)/);
  assert.match(java, /AndroidKeyStore/);
  assert.match(java, /AES\/GCM\/NoPadding/);
  assert.match(java, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.M/);
  assert.doesNotMatch(java, /putString\(PREFIX \+ name, value\)/);
  assert.match(java, /remove\(PREFIX \+ name\)/);
});
