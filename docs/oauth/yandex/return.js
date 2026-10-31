(() => {
  'use strict';
  const message = document.getElementById('message');
  const button = document.getElementById('return');
  button.hidden = true;
  const source = new URL(window.location.href);
  window.history.replaceState(null, '', window.location.pathname);
  const state = source.searchParams.get('state');
  const code = source.searchParams.get('code');
  const error = source.searchParams.get('error');
  const errors = {
    access_denied: 'Пользователь не предоставил доступ.',
    invalid_request: 'Яндекс отклонил параметры запроса.',
    invalid_client: 'Яндекс не принял настройки OAuth-приложения.',
    unauthorized_client: 'Для приложения не разрешён этот способ входа.',
    unsupported_response_type: 'Яндекс не поддержал запрошенный тип ответа.',
    invalid_scope: 'Яндекс не принял запрошенные права доступа.',
    server_error: 'Ошибка на стороне Яндекса.',
    temporarily_unavailable: 'Авторизация Яндекса временно недоступна.',
  };
  const providerHint = Object.prototype.hasOwnProperty.call(errors, error) ? ` ${errors[error]}` : '';
  const fail = (reason) => {
    message.textContent = `Не удалось завершить вход. ${reason}${providerHint} Вернитесь в Кабинет и начните подключение заново.`;
  };
  if (source.hash) {
    fail('В ответе есть фрагмент URL (#). Эта версия ожидает код в параметрах адреса.');
    return;
  }
  if (['state', 'code', 'error', 'error_description'].some((key) => source.searchParams.getAll(key).length > 1)) {
    fail('В ответе повторяются параметры OAuth.');
    return;
  }
  if (!state) {
    fail('В ответе отсутствует state. Вход нужно запускать кнопкой в приложении, не открывать страницу возврата отдельно.');
    return;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    fail(`Не совпал формат state. Полученная длина: ${state.length}; ожидалась длина 43.`);
    return;
  }
  if (!!code === !!error) {
    fail(code ? 'В ответе одновременно присутствуют code и error.' : 'В ответе отсутствуют и code, и error.');
    return;
  }
  if (code && !/^[\x20-\x7E]{1,2048}$/.test(code)) {
    fail('Код содержит неподдерживаемые символы или превышает допустимую длину 2048.');
    return;
  }
  const target = new URL('kabinet://oauth/yandex');
  target.searchParams.set('state', state);
  if (code) target.searchParams.set('code', code);
  else target.searchParams.set('error', 'access_denied');
  message.textContent = code ? 'Яндекс ответил. Вернитесь в Кабинет, чтобы завершить подключение.' : `Доступ не предоставлен.${providerHint} Можно вернуться в Кабинет.`;
  button.hidden = false;
  button.addEventListener('click', () => window.location.assign(target.href));
})();
