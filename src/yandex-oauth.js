'use strict';

const crypto = require('node:crypto');
const config = require('./yandex-oauth-config.json');
const SCOPES = ['cloud_api:disk.read', 'cloud_api:disk.write'];
const validAuthorizationCode = (value) => typeof value === 'string' && /^[\x20-\x7E]{1,2048}$/.test(value);

function createYandexOAuth({ request, now = Date.now, ttlMs = 600000 } = {}) {
  if (typeof request !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Неверная конфигурация OAuth.');
  let pending = null;
  const cancel = () => { pending = null; };
  function begin() {
    if (pending && now() < pending.deadline) throw new Error('Авторизация уже выполняется.');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    pending = { verifier, state, deadline: now() + ttlMs, exchanging: false };
    const url = new URL('https://oauth.yandex.ru/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId,
      redirect_uri: config.redirectUri, scope: SCOPES.join(' '), state,
      code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return url.href;
  }
  async function complete(raw) {
    const session = pending;
    if (!session) throw new Error('Нет ожидающей авторизации.');
    if (now() >= session.deadline) { cancel(); throw new Error('Время авторизации истекло.'); }
    if (session.exchanging) throw new Error('Ответ уже обрабатывается.');
    if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Некорректный ответ OAuth.');
    let url;
    try { url = new URL(raw); } catch { throw new Error('Некорректный адрес возврата.'); }
    const base = new URL(url.href); base.search = ''; base.hash = '';
    if (base.href !== config.callbackUri || url.hash) throw new Error('Неверный адрес возврата.');
    for (const key of ['state', 'code', 'error', 'error_description']) {
      if (url.searchParams.getAll(key).length > 1) throw new Error('Повторяющиеся параметры OAuth.');
    }
    const state = Buffer.from(url.searchParams.get('state') || '');
    const expected = Buffer.from(session.state);
    if (state.length !== expected.length || !crypto.timingSafeEqual(state, expected)) throw new Error('Ответ не относится к текущему входу.');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code && error) throw new Error('Противоречивый ответ OAuth.');
    if (error) { cancel(); throw new Error('Доступ не предоставлен.'); }
    if (!validAuthorizationCode(code)) throw new Error('Некорректный код авторизации.');
    session.exchanging = true;
    try {
      let res;
      try {
        res = await request({ method: 'POST', url: 'https://oauth.yandex.ru/token',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          redirect: 'error', timeoutMs: 30000,
          body: new TextEncoder().encode(new URLSearchParams({ grant_type: 'authorization_code',
            client_id: config.clientId, code, code_verifier: session.verifier }).toString()),
        });
      } catch { throw new Error('Не удалось связаться с Яндексом. Повторите подключение.'); }
      if (pending !== session) throw new Error('Авторизация отменена.');
      if (now() >= session.deadline) throw new Error('Время авторизации истекло.');
      if (!res || res.status !== 200) throw new Error('Яндекс не выдал токен. Повторите подключение.');
      let data;
      try { data = JSON.parse(new TextDecoder().decode(res.body)); } catch { throw new Error('Некорректный ответ Яндекса.'); }
      const expiresAt = now() + (data && data.expires_in) * 1000;
      if (!data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 ||
          String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
          !Number.isSafeInteger(expiresAt) || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string')) throw new Error('Некорректные параметры токена.');
      if (data.scope !== undefined && (typeof data.scope !== 'string' || !SCOPES.every((s) => data.scope.split(/\s+/).includes(s)))) throw new Error('Не предоставлены права чтения и записи Диска.');
      return { accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresAt, tokenType: 'bearer' };
    } finally {
      if (pending === session) pending = null;
      session.verifier = ''; session.state = '';
    }
  }
  return { begin, complete, cancel };
}

module.exports = { createYandexOAuth, SCOPES, validAuthorizationCode };
