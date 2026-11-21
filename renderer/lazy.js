// Разметка текста (анализ, подсветка имён, слова словаря) на больших главах пересчитывается не на каждое нажатие клавиши,
// а когда ввод затих: до этого прежняя разметка просто сдвигается вместе с текстом. Маленькие главы пересчитываются сразу.

export const LAZY_MIN_SIZE = 6000; // размер документа ProseMirror (≈ знаков), с которого пересчёт откладывается
export const HUGE_MIN_SIZE = 80000; // сверхбольшие главы (десятки тысяч слов): более редкий пересчёт при наборе
const QUIET_MS = 250; // тишина после последней клавиши
const MAX_WAIT_MS = 2500; // но не дольше, даже если автор печатает без остановки
const HUGE_QUIET_MS = 650;
const HUGE_MAX_WAIT_MS = 4000;

/** Нужно ли откладывать пересчёт для этого документа. */
export const isBig = (doc) => doc.content.size > LAZY_MIN_SIZE;
export const isHuge = (doc) => doc.content.size > HUGE_MIN_SIZE;

/**
 * Вид плагина для отложенного пересчёта: когда состояние помечено stale, ждёт тишины и посылает транзакцию с меткой key.
 * isStale(state) -> bool.
 */
export function lazyView(key, isStale) {
  return () => {
    let timer = null;
    let since = 0;
    return {
      update(view) {
        if (!isStale(view.state)) { clearTimeout(timer); timer = null; since = 0; return; }
        const now = Date.now();
        if (!since) since = now;
        clearTimeout(timer);
        const huge = isHuge(view.state.doc);
        const quiet = huge ? HUGE_QUIET_MS : QUIET_MS;
        const maxWait = huge ? HUGE_MAX_WAIT_MS : MAX_WAIT_MS;
        const wait = Math.max(0, Math.min(quiet, maxWait - (now - since)));
        timer = setTimeout(() => {
          timer = null;
          since = 0;
          if (view.isDestroyed) return;
          view.dispatch(view.state.tr.setMeta(key, true));
        }, wait);
      },
      destroy() { clearTimeout(timer); },
    };
  };
}
