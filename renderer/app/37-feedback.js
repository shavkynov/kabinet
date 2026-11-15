// ---------- обратная связь и журнал ----------
// Отчёт (сообщение, версия, система и журнал) копируется в буфер обмена, а страница нового обращения на GitHub
// открывается с заголовком и началом текста: адрес не вмещает весь журнал.

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* запасной путь ниже */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
  ta.remove();
  return ok;
}

function openFeedback() {
  const dlg = $('#feedbackDialog');
  const text = $('#fbText');
  const hint = $('#fbHint');
  hint.textContent = '';
  const kind = () => (document.querySelector('input[name="fbKind"]:checked') || {}).value || 'Ошибка';
  const done = async (send) => {
    const body = text.value.trim();
    if (!body) { hint.textContent = t('Опишите, что случилось.'); text.focus(); return; }
    const withLog = $('#fbLog').checked;
    try {
      const report = await api.feedbackReport(kind(), body, withLog);
      const copied = await copyText(report);
      if (send) await api.feedbackOpen(kind(), body, withLog);
      dlg.close();
      text.value = '';
      if (!copied) setStatus('error', t('Не удалось скопировать отчёт. Откройте журнал через «Справка → Открыть папку журнала».'));
      else setStatus('ok', send ? t('Отчёт скопирован. На странице GitHub вставьте его в сообщение (Ctrl+V).') : t('Отчёт скопирован в буфер обмена'));
    } catch (e) { hint.textContent = e.message; }
  };
  $('#fbSend').onclick = () => done(true);
  $('#fbCopy').onclick = () => done(false);
  $('#fbCancel').onclick = () => dlg.close();
  dlg.showModal();
  text.focus();
}
