'use strict';

// Карта кода: разделы и функции с номерами строк. Нужна, чтобы не читать большие файлы целиком.
// npm run map            всё
// npm run map -- app     только файлы, в имени которых есть "app"

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const filter = process.argv[2];
const files = [
  'main.js', 'preload.js',
  ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`),
  ...fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.js') && f !== 'app.gen.js').map((f) => `renderer/${f}`),
  ...fs.readdirSync(path.join(root, 'renderer', 'app')).filter((f) => f.endsWith('.js')).map((f) => `renderer/app/${f}`),
  'renderer/style.css', 'renderer/index.html',
].filter((f) => !filter || f.includes(filter));

for (const f of files) {
  const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
  console.log(`\n== ${f} (${lines.length} строк)`);
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^\/\/ -{3,} (.+?) -{3,}/)) || (m = line.match(/^\/\* -{3,} (.+?) -{3,} \*\//))) console.log(`${i + 1}: ## ${m[1]}`);
    else if ((m = line.match(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/))) console.log(`${i + 1}:   ${m[1]}`);
    else if ((m = line.match(/^handle\('([^']+)'/))) console.log(`${i + 1}:   ipc ${m[1]}`);
    else if (f.endsWith('.html') && (m = line.match(/<(?:div|aside|section|dialog)[^>]*\bid="([^"]+)"/))) console.log(`${i + 1}:   #${m[1]}`);
  });
}
