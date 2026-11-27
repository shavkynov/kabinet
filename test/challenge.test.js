'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSession,
  onInput,
  togglePause,
  skipBreak,
  tick,
  exitSession,
  snapshot,
  formatClock,
} = require('../src/challenge');

describe('challenge engine: общие свойства и форматирование', () => {
  it('форматирует секунды и часы для полос и таймера', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(149_200), '02:30');
    assert.equal(formatClock(3600_000), '1:00:00');
  });

  it('ждёт первого набранного символа до запуска таймера', () => {
    const s = createSession('sprint', '15m');
    assert.equal(s.status, 'waiting');
    tick(s, 10_000);
    assert.equal(s.status, 'waiting');

    // Удаление до старта не запускает таймер
    onInput(s, { wordDelta: -1, inserted: false }, 20_000);
    assert.equal(s.status, 'waiting');

    // Первый введённый знак запускает отсчёт
    const ev = onInput(s, { wordDelta: 0, inserted: true }, 25_000);
    assert.deepEqual(ev, ['started']);
    assert.equal(s.status, 'running');
  });
});

describe('challenge engine: Спринт и шахматная пауза', () => {
  it('выигрывает при наборе цели слов и корректно считает чистую прибавку', () => {
    const s = createSession('sprint', { presetId: '15m', targetWords: 5, durationSec: 60 });
    onInput(s, { wordDelta: 3, inserted: true }, 1000);
    onInput(s, { wordDelta: -2, inserted: false }, 2000); // удалили 2 слова -> 1 слово
    assert.equal(s.words, 1);

    onInput(s, { wordDelta: 4, inserted: true }, 3000);
    assert.equal(s.status, 'won');
    assert.equal(s.words, 5);
  });

  it('проигрывает по истечении времени, если слов не хватает', () => {
    const s = createSession('sprint', { presetId: '15m', targetWords: 100, durationSec: 10 });
    onInput(s, { wordDelta: 10, inserted: true }, 1000);
    const ev = tick(s, 12_000);
    assert.deepEqual(ev, ['failed']);
    assert.equal(s.status, 'failed');
    assert.equal(s.failReason, 'timeout');
  });

  it('даёт пропорциональный банк паузы (10 мин/час) и отгрызает его как шахматные часы', () => {
    const s15 = createSession('sprint', '15m');
    const s60 = createSession('sprint', '60m');
    assert.equal(s15.pauseBankMs, 150_000); // 2:30
    assert.equal(s60.pauseBankMs, 600_000); // 10:00

    const s = createSession('sprint', { presetId: '15m', targetWords: 500, durationSec: 900 });
    onInput(s, { wordDelta: 10, inserted: true }, 0);

    // Ставим первую паузу на 40 секунд
    assert.deepEqual(togglePause(s, 60_000), ['paused']);
    assert.equal(s.status, 'paused');
    assert.deepEqual(togglePause(s, 100_000), ['resumed']);
    assert.equal(snapshot(s, 100_000).pauseRemainingMs, 110_000);

    // Писали до 120_000 (итого 80с активного письма -> осталось 820с)
    // Вторая пауза на 150с (> остатка 110с): банк заканчивается на 230_000,
    // после чего 40с перехлёста честно вычитаются из основного таймера!
    togglePause(s, 120_000);
    const ev = tick(s, 270_000);
    assert.ok(ev.includes('pause-expired'));
    assert.equal(s.status, 'running');
    const snap = snapshot(s, 270_000);
    assert.equal(snap.pauseRemainingMs, 0);
    assert.equal(snap.canPause, false);
    assert.equal(snap.remainingMs, (900 - 80 - 40) * 1000);
  });

  it('набор текста во время паузы сам снимает её', () => {
    const s = createSession('sprint', '15m');
    onInput(s, { wordDelta: 1, inserted: true }, 0);
    togglePause(s, 10_000);
    const ev = onInput(s, { wordDelta: 1, inserted: true }, 20_000);
    assert.ok(ev.includes('resumed'));
    assert.equal(s.status, 'running');
    assert.equal(s.words, 2);
  });
});

describe('challenge engine: Марафонец', () => {
  it('не имеет паузы и проигрывает при простое >= 60 с (в том числе в фоновой вкладке)', () => {
    const s = createSession('marathon', { presetId: '30m', durationSec: 300, maxIdleMs: 60_000 });
    assert.equal(s.allowPause, false);
    assert.deepEqual(togglePause(s, 1000), []);

    onInput(s, { wordDelta: 1, inserted: true }, 0);
    // За 46 с простоя (осталось 14 с) включается предупреждение
    assert.equal(snapshot(s, 46_000).idleWarn, true);

    // Если автор уснул / ушёл в фон и прошло сразу 500 с (> 60 с простоя и > 300 с цели),
    // честный исход — failed (простой наступил раньше конца марафона), а не ложный выигрыш
    const ev = tick(s, 500_000);
    assert.deepEqual(ev, ['failed']);
    assert.equal(s.status, 'failed');
    assert.equal(s.failReason, 'idle');
  });

  it('побеждает, если перерывы короче 60 секунд до самого конца срока', () => {
    const s = createSession('marathon', { presetId: '15m', durationSec: 100, maxIdleMs: 60_000 });
    onInput(s, { wordDelta: 5, inserted: true }, 0);
    onInput(s, { wordDelta: 5, inserted: true }, 50_000);
    const ev = tick(s, 100_000);
    assert.deepEqual(ev, ['won']);
    assert.equal(s.status, 'won');
  });
});

describe('challenge engine: Помодоро', () => {
  it('переключает фазы письмо -> отдых -> письмо, позволяет пропустить отдых и завершается победой', () => {
    const s = createSession('pomodoro', { presetId: '2r', rounds: 2, workSec: 60, breakSec: 20 });
    assert.equal(s.pauseBankMs, 20_000); // 1/6 от 120с

    onInput(s, { wordDelta: 12, inserted: true }, 0);
    assert.deepEqual(tick(s, 60_000), ['phase-break']);
    assert.equal(s.status, 'break');
    assert.equal(snapshot(s, 61_000).canPause, false);

    // Пропуск перерыва сразу начинает раунд 2
    assert.deepEqual(skipBreak(s, 65_000), ['phase-work']);
    assert.equal(s.status, 'running');
    assert.equal(s.round, 2);

    // После 2-го рабочего раунда вызов успешно завершается
    assert.deepEqual(tick(s, 125_000), ['won']);
    assert.equal(s.status, 'won');
  });

  it('корректно фиксирует ручной выход без проигрыша', () => {
    const s = createSession('pomodoro', '4r');
    onInput(s, { wordDelta: 15, inserted: true }, 0);
    const ev = exitSession(s, 30_000);
    assert.deepEqual(ev, ['exited']);
    assert.equal(s.status, 'exited');
    assert.equal(snapshot(s, 30_000).elapsedWorkMs, 30_000);
  });
});
