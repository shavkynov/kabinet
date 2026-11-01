'use strict';
// Надёжные сетевые запросы для синхронизации по мобильной сети: срок на каждый запрос и повторы при временных сбоях.
// Без этого один оборвавшийся запрос (смена сети, режим сна телефона, медленная связь) оставлял синхронизацию
// с ошибкой до следующего обхода, а зависший запрос мог держать её бесконечно.

const TRANSIENT = new Set([408, 423, 425, 429, 500, 502, 503, 504]);

/** Промис, который обязательно завершится: по истечении ms отклоняется. */
function withTimeout(promise, ms, message = 'Сервер не отвечает.', { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimer(() => reject(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimer(timer));
}

/**
 * Оборачивает send(req) → res: срок на попытку и до attempts попыток при сбое сети или временном ответе сервера
 * (занят, слишком много запросов, 5xx). Запросы синхронизации безопасно повторять: запись, чтение и удаление идемпотентны.
 */
function retrying(send, { attempts = 3, timeoutMs = 90000, delays = [1500, 6000], graceMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), setTimer, clearTimer } = {}) {
  return async function request(req) {
    const limit = (req && req.timeoutMs ? req.timeoutMs : timeoutMs) + graceMs;
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      const last = i === attempts - 1;
      let res;
      try {
        res = await withTimeout(send(req), limit, 'Сервер не отвечает.', { setTimer, clearTimer });
      } catch (e) {
        lastError = e;
        if (last) throw e;
        await sleep(delays[Math.min(i, delays.length - 1)]);
        continue;
      }
      if (!TRANSIENT.has(res.status) || last) return res;
      const after = Number(res.headers && res.headers['retry-after']);
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : delays[Math.min(i, delays.length - 1)]);
    }
    throw lastError || new Error('Сервер не отвечает.');
  };
}

module.exports = { withTimeout, retrying, TRANSIENT };
