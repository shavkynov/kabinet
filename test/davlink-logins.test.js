'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDavLink } = require('../src/davlink');

function setup(t, records, secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-logins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (records) fs.writeFileSync(path.join(dir, 'dav-links.json'), JSON.stringify(records));
  return createDavLink({ dataDir: dir, secret, request: async () => { throw new Error('Unexpected network request'); } });
}

test('saved logins deduplicate by service and account without losing other accounts', (t) => {
  const account = { url: 'https://example.org', user: 'alice', pass: 'fixture', root: '/one', label: 'Cloud' };
  const link = setup(t, { first: account, second: { ...account, root: '/two' }, third: { ...account, user: 'bob' } });
  const entries = link.logins();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.user), ['alice', 'bob']);
  assert.equal(entries[0].url, account.url);
});

test('saved logins tolerate absent settings and unreadable credentials', (t) => {
  assert.deepEqual(setup(t).logins(), []);
  const link = setup(t, { first: { url: 'https://example.org', user: 'alice', pass: 'unreadable', root: '/one' } },
    { seal: (value) => value, open: () => { throw new Error('Cannot decrypt fixture'); } });
  assert.deepEqual(link.logins(), []);
});
