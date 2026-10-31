'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createYandexOAuth, SCOPES } = require('../src/yandex-oauth');
const config = require('../src/yandex-oauth-config.json');
const body = (v) => new TextEncoder().encode(JSON.stringify(v));
const good = { status: 200, body: body({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600 }) };
function setup(options = {}) {
  const calls = [];
  const flow = createYandexOAuth({ request: async (r) => { calls.push(r); return good; }, ...options });
  const start = new URL(flow.begin());
  const callback = (extra = {}) => config.callbackUri + '?' + new URLSearchParams({ state: start.searchParams.get('state'), code: '1234567', ...extra });
  return { flow, start, callback, calls };
}
test('S256, configuration, scopes and secret-free exchange', async () => {
  const x = setup();
  assert.equal(x.start.searchParams.get('client_id'), config.clientId);
  assert.equal(x.start.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(x.start.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal((await x.flow.complete(x.callback())).accessToken, 'fixture');
  const r = x.calls[0], form = new URLSearchParams(new TextDecoder().decode(r.body));
  assert.equal(r.url, 'https://oauth.yandex.ru/token'); assert.equal(r.redirect, 'error');
  assert.equal(form.has('client_secret'), false);
  assert.equal(x.start.searchParams.get('code_challenge'), crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'));
  await assert.rejects(x.flow.complete(x.callback()));
});
test('random state and verifier', () => {
  const a = setup(), b = setup();
  for (const key of ['state', 'code_challenge']) assert.notEqual(a.start.searchParams.get(key), b.start.searchParams.get(key));
});
test('foreign state does not consume real session', async () => {
  const x = setup(); await assert.rejects(x.flow.complete(x.callback({state:'wrong'})));
  assert.equal(x.calls.length, 0); await x.flow.complete(x.callback());
});
test('reject foreign endpoint, fragment, duplicate params, invalid code and contradictory response', async () => {
  const x = setup();
  for (const raw of [x.callback().replace('://oauth/', '://other/'), x.callback()+'#token=x', x.callback()+'&state=other', x.callback()+'&code=2', x.callback({code:'bad'}), x.callback({error:'access_denied'})]) await assert.rejects(x.flow.complete(raw));
  assert.equal(x.calls.length, 0);
});
test('cancel and expiry prevent exchange', async () => {
  const x = setup(); x.flow.cancel(); await assert.rejects(x.flow.complete(x.callback()));
  let t = 0; const y = setup({now:()=>t, ttlMs:1000}); t = 1000;
  await assert.rejects(y.flow.complete(y.callback())); assert.equal(y.calls.length, 0);
});
test('access denial clears session', async () => {
  const x = setup(), u = new URL(x.callback({error:'access_denied'})); u.searchParams.delete('code');
  await assert.rejects(x.flow.complete(u.href), /Доступ не предоставлен/); assert.equal(x.calls.length, 0);
  await assert.rejects(x.flow.complete(x.callback()));
});
test('no concurrent begin or double exchange', async () => {
  let finish; const x = setup({request:()=>new Promise((r)=>{finish=r;})});
  assert.throws(()=>x.flow.begin()); const first=x.flow.complete(x.callback());
  await assert.rejects(x.flow.complete(x.callback())); finish(good); await first;
});
test('cancel during exchange discards token', async () => {
  let finish; const x=setup({request:()=>new Promise((r)=>{finish=r;})});
  const result=x.flow.complete(x.callback()); x.flow.cancel(); finish(good); await assert.rejects(result, /отменена/);
});
test('network errors and provider responses cannot leak secrets', async () => {
  for (const request of [async()=>{throw new Error('sensitive-fixture');}, async()=>({status:400,body:body({error:'sensitive-fixture'})})]) {
    const x=setup({request}); await assert.rejects(x.flow.complete(x.callback()), (e)=>!e.message.includes('sensitive-fixture'));
    await assert.rejects(x.flow.complete(x.callback()));
  }
});
test('malformed token, expiry and insufficient scopes are rejected', async () => {
  for (const data of [null, {}, {access_token:'x',token_type:'bearer',expires_in:-1}, {access_token:'x',token_type:'bearer',expires_in:1,scope:'cloud_api:disk.read'}]) {
    const x=setup({request:async()=>({status:200,body:body(data)})}); await assert.rejects(x.flow.complete(x.callback()));
  }
});
test('timeout during response and invalid config', async () => {
  let t=0; const x=setup({now:()=>t,ttlMs:1000,request:async()=>{t=1000;return good;}});
  await assert.rejects(x.flow.complete(x.callback()), /истекло/);
  assert.throws(()=>createYandexOAuth({}));
});
