'use strict';
const fs = require('fs');
const crypto = require('crypto');
function readChecked(file, expected) {
  const raw = fs.readFileSync(file);
  const sha = crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
  if (sha !== expected) throw new Error(`Source changed; refusing to overwrite ${file}`);
  return raw.toString('utf8');
}
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`Patch anchor not unique: ${from}`);
  return text.replace(from, to);
}
let main = readChecked('main.js', '1a1953d6b652906ca584ace827ad96064fe9bd55');
let pkg = readChecked('package.json', 'a9abd10cf53d9db6ebcdf4eccb4bf87b86384c29');
main = once(main, "const exporter = require('./src/export');", "const exporter = require('./src/export');\nconst exportTarget = require('./src/export-target');");
const anchor = "  const res = await dialog.showSaveDialog(win, {\n    title: t('Экспорт проекта'),";
main = once(main, anchor, `  let defaultPath = path.join(app.getPath('documents'), \`\${path.basename(dir)}.pdf\`);
  try {
    defaultPath = exportTarget.defaultPath(app.getPath('userData'), dir, app.getPath('documents'));
  } catch (err) {
    console.error('export destination read:', err);
    dialog.showErrorBox(t('Экспорт проекта'), 'Не удалось прочитать настройки места экспорта. Будет предложена папка «Документы».\\n' + String(err.message || err));
  }
${anchor}`);
main = once(main, "    defaultPath: path.join(app.getPath('documents'), `${path.basename(dir)}.pdf`),", '    defaultPath,');
main = once(main, '  shell.showItemInFolder(file);\n  return file;', `  try {
    exportTarget.remember(app.getPath('userData'), dir, file);
  } catch (err) {
    console.error('export destination write:', err);
    dialog.showErrorBox(t('Экспорт проекта'), 'Файл экспортирован, но запомнить папку и формат не удалось.\\n' + String(err.message || err));
  }
  shell.showItemInFolder(file);
  return file;`);
const oldTest = JSON.parse(pkg).scripts.test;
if (oldTest.includes('test/export-target.test.js')) throw new Error('Test already registered');
pkg = once(pkg, JSON.stringify(oldTest), JSON.stringify(oldTest + ' test/export-target.test.js'));
fs.writeFileSync('main.js', main);
fs.writeFileSync('package.json', pkg);
