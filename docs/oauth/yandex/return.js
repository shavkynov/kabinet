(() => {
  'use strict';
  const message = document.getElementById('message');
  const button = document.getElementById('return');
  const source = new URL(window.location.href);
  window.history.replaceState(null, '', window.location.pathname);
  const state = source.searchParams.get('state');
  const code = source.searchParams.get('code');
  const error = source.searchParams.get('error');
  const duplicate = ['state', 'code', 'error', 'error_description'].some((key) => source.searchParams.getAll(key).length > 1);
  if (source.hash || duplicate || !/^[A-Za-z0-9_-]{43}$/.test(state || '') ||
      (!!code === !!error) || (code && !/^\d{7}$/.test(code))) {
    message.textContent = 'Некорректный ответ. Вернитесь в Кабинет и начните подключение заново.';
    return;
  }
  const target = new URL('kabinet://oauth/yandex');
  target.searchParams.set('state', state);
  if (code) target.searchParams.set('code', code);
  else target.searchParams.set('error', 'access_denied');
  message.textContent = code ? 'Яндекс ответил. Вернитесь в Кабинет, чтобы завершить подключение.' : 'Доступ не предоставлен. Можно вернуться в Кабинет.';
  button.hidden = false;
  button.addEventListener('click', () => window.location.assign(target.href));
})();
