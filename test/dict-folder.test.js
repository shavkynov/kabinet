'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = require('../src/project');
const { createFolderSync } = require('../src/folder');
function adapterFor(meta) {
  const files = new Map([['project.json', Buffer.from(JSON.stringify(meta))]]);
  return {
    files,
    async list(rel) {
      const prefix = rel ? rel + '/' : '';
      const children = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        children.set(name, { name, dir: slash >= 0 });
      }
      return [...children.values()];
    },
    async read(rel) { return files.has(rel) ? Buffer.from(files.get(rel)) : null; },
    async write(rel, bytes) { files.set(rel, Buffer.from(bytes)); },
    async mkdir() {},
    async remove(rel) { files.delete(rel); },
  };
}
async function scenario(localWords, remoteWords, blockBackup = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-dict-folder-'));
  const dir = path.join(root, 'Project');
  try {
    project.createProject(dir, 'Same name');
    project.setProjectWords(dir, localWords);
    const file = path.join(dir, 'project.json');
    const localBefore = fs.readFileSync(file, 'utf8');
    const remote = JSON.parse(localBefore);
    if (remoteWords === null) delete remote.words;
    else remote.words = remoteWords;
    const adapter = adapterFor(remote);
    const remoteBefore = Buffer.from(adapter.files.get('project.json'));
    const sync = createFolderSync(dir, adapter, { stateFile: path.join(root, 'state.json') });
    const conflicts = path.join(dir, 'Конфликты');
    if (blockBackup) {
      fs.writeFileSync(conflicts, 'blocked');
      await assert.rejects(sync.sync(), 'dictionary-only replacement must stop when backup cannot be written');
      assert.equal(fs.readFileSync(file, 'utf8'), localBefore);
      assert.deepEqual(adapter.files.get('project.json'), remoteBefore);
      return;
    }
    await sync.sync();
    const names = fs.existsSync(conflicts) ? fs.readdirSync(conflicts).filter((name) => name.endsWith('.json')) : [];
    assert.equal(names.length, 1, 'dictionary-only local metadata must be preserved');
    const saved = fs.readFileSync(path.join(conflicts, names[0]), 'utf8');
    assert.equal(saved, localBefore);
    assert.deepEqual(JSON.parse(saved).words, localWords);
    assert.deepEqual(adapter.files.get('Конфликты/' + names[0]), Buffer.from(localBefore));
    assert.deepEqual(project.projectWords(dir), remoteWords);
    assert.deepEqual(adapter.files.get('project.json'), remoteBefore);
    await sync.sync();
    assert.deepEqual(fs.readdirSync(conflicts).filter((name) => name.endsWith('.json')), names);
    assert.deepEqual(project.projectWords(dir), remoteWords);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('first attachment preserves local word additions before accepting remote dictionary', () => scenario(['Local'], ['Remote']));
test('first attachment preserves explicit empty dictionary without resurrecting removed words', () => scenario([], ['Remote']));
test('first attachment preserves local dictionary when remote metadata has no words field', () => scenario(['Local'], null));
test('failed local backup stops dictionary replacement', () => scenario(['Local'], ['Remote'], true));

test('слова из двух одновременно изменённых project.json объединяются, остальное берётся у нас', () => {
  const { mergeMetaWords } = require('../src/dict');
  const local = JSON.stringify({ name: 'Наш', words: ['Аня', 'Боря'] });
  const remote = JSON.stringify({ name: 'Чужой', words: ['Аня', 'Вика'] });
  const out = JSON.parse(mergeMetaWords(local, remote).toString('utf8'));
  assert.equal(out.name, 'Наш');
  assert.deepEqual(out.words, ['Аня', 'Боря', 'Вика']);
  assert.equal(mergeMetaWords(local, JSON.stringify({ words: ['Аня'] })), null, 'у нас уже всё есть: сливать нечего');
  assert.equal(mergeMetaWords(local, JSON.stringify({ name: 'без слов' })), null);
  assert.equal(mergeMetaWords(local, 'не json'), null);
});
