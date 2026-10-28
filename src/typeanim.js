'use strict';

// Логика анимации появления набранных букв без редактора.
// Сам эффект рисует CSS Highlight API (renderer/typeanim.js): новые буквы получают цвет текста с растущей непрозрачностью.
// Ничего не добавляется в DOM редактора и не пересоздаётся, поэтому перерисовка узлов ProseMirror анимацию не сбрасывает.
// Подстройка скорости: DURATION_MS (одно число), плавность: STEPS (непрозрачность по ступеням).

const DURATION_MS = 100;   // за это время буква проявляется полностью
const STEPS = [0.12, 0.34, 0.56, 0.78, 0.94]; // непрозрачность цвета текста по ступеням (5 ступеней за 100 мс, на 60 Гц это 6 кадров)
const MAX_CHARS = 4;       // набор до 4 знаков за одну правку (быстрая печать, автозамена) анимируется, больше (вставка, загрузка) нет

/**
 * Одиночная правка редактора: { from, to, size, text } (text только если вставлен обычный текст).
 * Возвращает [от, до] для анимации или null.
 */
function animatedRange(step) {
  if (!step || step.from !== step.to || !step.size || step.size > MAX_CHARS) return null;
  if (typeof step.text !== 'string' || step.text.length !== step.size || !/\S/.test(step.text)) return null;
  return [step.from, step.from + step.size];
}

/** Пометка отработала и может быть снята. */
const expired = (t, now) => now - t >= DURATION_MS;

/** Номер ступени по возрасту буквы в мс: 0..STEPS.length-1, либо -1, если проявление закончилось (или возраст неверный). */
function levelAt(age) {
  if (!(age >= 0) || age >= DURATION_MS) return -1;
  return Math.min(STEPS.length - 1, Math.floor((age / DURATION_MS) * STEPS.length));
}

/**
 * Метки после правки документа: items = [{ from, to, t }], map(pos, assoc) переводит позицию (assoc 1 / -1 как в ProseMirror).
 * Устаревшие и «схлопнувшиеся» (текст удалён) метки уходят. Начало сдвигается вперёд при вставке перед ним,
 * конец остаётся перед вставкой после него: соседний новый текст не растягивает чужую метку.
 */
function advance(items, map, now) {
  const out = [];
  for (const it of items) {
    if (expired(it.t, now)) continue;
    const from = map(it.from, 1);
    const to = map(it.to, -1);
    if (to > from) out.push({ from, to, t: it.t });
  }
  return out;
}

module.exports = { DURATION_MS, STEPS, MAX_CHARS, animatedRange, expired, levelAt, advance };
