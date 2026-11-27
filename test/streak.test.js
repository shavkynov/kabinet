'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_GOAL,
  MIN_GOAL,
  MAX_GOAL,
  writingDay,
  addDays,
  loadStreak,
  computeStreak,
  recordTypedWords,
  setDailyGoal,
  toggleRestDay,
} = require('../src/streak');

const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe('writingDay (граница дня 4:00)', () => {
  it('до 04:00 относит набор ко вчерашнему писательскому дню', () => {
    assert.equal(writingDay(local(2026, 11, 27, 3, 59)), '2026-11-26');
    assert.equal(writingDay(local(2026, 11, 27, 0, 15)), '2026-11-26');
    assert.equal(writingDay(local(2026, 11, 27, 4, 0)), '2026-11-27');
    assert.equal(writingDay(local(2026, 3, 1, 2, 0)), '2026-02-28');
  });
});

describe('стрики и цель по умолчанию', () => {
  it('по умолчанию цель 1000 слов, а удаления и 0 не уменьшают счётчик', () => {
    let st = loadStreak(null);
    assert.equal(st.goal, DEFAULT_GOAL);
    const day1 = local(2026, 11, 20, 10, 0);

    let res = recordTypedWords(st, 600, day1);
    st = res.state;
    assert.equal(res.reachedTodayNow, false);
    assert.equal(res.summary.todayWords, 600);
    assert.equal(res.summary.current, 0);

    // Стирание не уменьшает написанное за день
    res = recordTypedWords(st, -250, day1);
    st = res.state;
    assert.equal(res.summary.todayWords, 600);

    // Добираем до 1000 -> сигнал достижения срабатывает ровно один раз
    res = recordTypedWords(st, 450, day1);
    st = res.state;
    assert.equal(res.reachedTodayNow, true);
    assert.equal(res.summary.metToday, true);
    assert.equal(res.summary.current, 1);

    res = recordTypedWords(st, 120, day1);
    st = res.state;
    assert.equal(res.reachedTodayNow, false);
    assert.equal(res.summary.todayWords, 1170);
  });

  it('держит серию живой до конца текущего дня и сгорает после пропуска', () => {
    let st = loadStreak(null);
    st = recordTypedWords(st, 1000, local(2026, 11, 20)).state;
    st = recordTypedWords(st, 1100, local(2026, 11, 21)).state;
    st = recordTypedWords(st, 1000, local(2026, 11, 22)).state;

    // Утром 23-го ещё 0 слов, но вчерашняя серия 3 дня не сгорела
    const morning23 = computeStreak(st, local(2026, 11, 23, 9, 0));
    assert.equal(morning23.current, 3);
    assert.equal(morning23.best, 3);

    // Пропустили 23-е целиком -> 24-го серия сгорает, рекорд best сохраняется
    const morning24 = computeStreak(st, local(2026, 11, 24, 9, 0));
    assert.equal(morning24.current, 0);
    assert.equal(morning24.best, 3);
  });

  it('меняет дневную цель в пределах [50..50000] без пересчёта прошлых дней', () => {
    let st = loadStreak(null);
    st = recordTypedWords(st, 600, local(2026, 11, 20)).state; // не дотянули до 1000
    st = setDailyGoal(st, 500, local(2026, 11, 21)).state;
    assert.equal(st.goal, 500);
    // Вчерашний день помнит прежнюю цель 1000 и не становится задним числом выполненным
    const s21 = computeStreak(st, local(2026, 11, 21));
    assert.equal(s21.current, 0);

    st = setDailyGoal(st, 10, local(2026, 11, 21)).state;
    assert.equal(st.goal, MIN_GOAL);
    st = setDailyGoal(st, 999999, local(2026, 11, 21)).state;
    assert.equal(st.goal, MAX_GOAL);
  });
});

describe('выходные дни и защита от накрутки задним числом', () => {
  it('запланированный выходной сохраняет серию без прибавки, а письмо в выходной прибавляет стрик', () => {
    let st = loadStreak(null);
    // Пятница 2026-11-20: задаём воскресенье (0) выходным на будущее
    const fri = local(2026, 11, 20);
    st = toggleRestDay(st, 0, fri).state;
    st = recordTypedWords(st, 1000, fri).state; // Пт
    st = recordTypedWords(st, 1000, local(2026, 11, 21)).state; // Сб
    // Вс 2026-11-22 пропускаем полностью -> в Пн 2026-11-23 пишем ещё
    st = recordTypedWords(st, 1000, local(2026, 11, 23)).state; // Пн
    let sum = computeStreak(st, local(2026, 11, 23));
    assert.equal(sum.current, 3); // Пт + Сб + Пн; Вс не сломало, но не добавило

    // Если в следующий выходной (Вс 2026-11-29) всё же выполнить цель, он пойдёт в плюс
    for (let d = 24; d <= 29; d += 1) {
      st = recordTypedWords(st, 1000, local(2026, 11, d)).state;
    }
    sum = computeStreak(st, local(2026, 11, 29));
    assert.equal(sum.current, 9);
  });

  it('назначение выходного сегодня не спасает вчерашний уже пропущенный день', () => {
    let st = loadStreak(null);
    // 2026-11-21 (Сб): написали 1000; 2026-11-22 (Вс): пропустили без выходного!
    st = recordTypedWords(st, 1000, local(2026, 11, 21)).state;
    const mon = local(2026, 11, 23); // Пн
    // В понедельник пытаемся отметить воскресенье выходным
    st = toggleRestDay(st, 0, mon).state;
    st = recordTypedWords(st, 1000, mon).state;
    const sum = computeStreak(st, mon);
    assert.equal(sum.current, 1); // Вчерашний пропуск не спасён: стрик 1, а не 2
  });

  it('снятие выходного не ломает уже честно пропущенные в прошлом выходные и не даёт отметить все 7 дней', () => {
    let st = loadStreak(null);
    const fri = local(2026, 11, 20);
    st = toggleRestDay(st, 0, fri).state;
    st = recordTypedWords(st, 1000, fri).state;
    st = recordTypedWords(st, 1000, local(2026, 11, 21)).state;
    // Пропустили Вс 22-го, написали в Пн 23-го
    st = recordTypedWords(st, 1000, local(2026, 11, 23)).state;
    // На Пн 23-го убираем Вс из выходных
    st = toggleRestDay(st, 0, local(2026, 11, 23)).state;
    const sum = computeStreak(st, local(2026, 11, 23));
    assert.equal(sum.current, 3); // Вс 22-го осталось в истории как выходной

    // Попытка отметить 7 дней выходными блокируется на 6-м
    for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
      st = toggleRestDay(st, wd, local(2026, 11, 24)).state;
    }
    assert.equal(st.restDays.length, 6);
  });

  it('подрезает историю старше 400 дней', () => {
    let st = loadStreak(null);
    st = recordTypedWords(st, 1000, local(2024, 1, 1)).state;
    const farFuture = local(2026, 11, 27);
    st = recordTypedWords(st, 1000, farFuture).state;
    const cutoff = addDays('2026-11-27', -400);
    assert.ok(Object.keys(st.days).every((iso) => iso >= cutoff));
  });
});
