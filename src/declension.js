'use strict';

// Падежные формы имён и названий (Д1): «Анна» → «Анны, Анне, Анну, Анной». Словаря языка здесь нет,
// формы строятся по типовым моделям склонения и окончаниям. Модель может ошибиться на редком слове;
// лишняя неверная форма почти безвредна (такого слова в тексте не будет), а пропущенную автор добавит
// в «Имена в тексте». Неизменяемые слова (Ли, Мэри, Нелли) формы не получают.
// Модуль без Electron и без редактора: работает со строками, проверяется тестами.

const MAX_WORDS = 5; // длиннее считаем не названием, а фразой
const MAX_COMBOS = 40; // предел сочетаний форм на один падеж у многословного названия

// Слова, которые внутри названия не изменяются: «Ростов на Дону», «Леонардо да Винчи», «Ван Дейк».
const PARTICLES = new Set('на в во под над за при у от из с со о об по де ван фон ла ле дель ди и'.split(' '));
// Слова на -ая/-ой/-ий, которые не прилагательные.
const NOT_ADJ = new Set(['аглая', 'исая', 'георгий']);

const SIBILANT = /[жчшщ]$/;
const SIBILANT_OR_TS = /[жчшщц]$/;
const VELAR = /[гкх]$/;
const SURNAME_END = /(?:ов|ев|ёв|ин|ын)$/i;
const FLEETING = /(?:ел|ёл|ек|ёк|ок|ец|ёц)$/i;

const lower = (s) => s.toLowerCase();
const isWord = (w) => /^[а-яё]+$/i.test(w);
const same = (w) => [[w], [w], [w], [w], [w]];

/** Пять падежей: родительный, дательный, винительный, творительный, предложный. Каждый: список вариантов. */
function mk(gen, dat, acc, instr, prep) {
  return [gen, dat, acc, instr, prep].map((x) => (Array.isArray(x) ? x : [x]));
}

function merge(a, b) {
  return a.map((variants, i) => [...new Set([...variants, ...b[i]])]);
}

// ---------- прилагательные: «Красная», «Нижний», «Достоевский», «Толстой» ----------

function adjType(w, opts) {
  const l = lower(w);
  if (NOT_ADJ.has(l) || l.length < 4) return null;
  if (/ая$/.test(l)) return 'f-hard';
  if (/яя$/.test(l)) return 'f-soft';
  if (/ое$/.test(l)) return 'n-hard';
  if (/ее$/.test(l)) return 'n-soft';
  if (/ые$/.test(l)) return 'p-hard';
  if (/ие$/.test(l) && (/[кгхжчшщ]ие$/.test(l) || (opts.multi && !opts.last))) return 'p-soft';
  if (/(?:ый|ой)$/.test(l)) return 'm-hard';
  if (/ий$/.test(l)) {
    if (/[кгх]ий$/.test(l)) return 'm-velar';
    if (/[жчшщ]ий$/.test(l)) return 'm-soft';
    if (/ний$/.test(l) && opts.multi && !opts.last) return 'm-soft';
  }
  return null;
}

function adjCases(w, type) {
  const b = w.slice(0, -2);
  switch (type) {
    case 'm-hard': return mk(`${b}ого`, `${b}ому`, `${b}ого`, `${b}ым`, `${b}ом`);
    case 'm-velar': return mk(`${b}ого`, `${b}ому`, `${b}ого`, `${b}им`, `${b}ом`);
    case 'm-soft': return mk(`${b}его`, `${b}ему`, `${b}его`, `${b}им`, `${b}ем`);
    case 'f-hard': return mk(`${b}ой`, `${b}ой`, `${b}ую`, `${b}ой`, `${b}ой`);
    case 'f-soft': return mk(`${b}ей`, `${b}ей`, `${b}юю`, `${b}ей`, `${b}ей`);
    case 'n-hard': return mk(`${b}ого`, `${b}ому`, [w], `${b}ым`, `${b}ом`);
    case 'n-soft': return mk(`${b}его`, `${b}ему`, [w], `${b}им`, `${b}ем`);
    case 'p-hard': return mk(`${b}ых`, `${b}ым`, [w, `${b}ых`], `${b}ыми`, `${b}ых`);
    default: return mk(`${b}их`, `${b}им`, [w, `${b}их`], `${b}ими`, `${b}их`); // p-soft
  }
}

// ---------- существительные ----------

/** Мужской род на согласную: «Иван», «Павел», «Лев», «Иванов», «Лондон». */
function mascHard(w) {
  const stems = [w];
  if (FLEETING.test(w) && w.length >= 4) stems.push(w.slice(0, -2) + w.slice(-1)); // Павел → Павл-, Орёл → Орл-
  if (lower(w) === 'лев') stems.push(`${w[0]}ьв`); // Лев → Льв-
  const out = [[], [], [], [], []];
  for (const s of stems) {
    out[0].push(`${s}а`);
    out[1].push(`${s}у`);
    out[2].push(`${s}а`);
    out[3].push(`${s}ом`);
    if (SIBILANT_OR_TS.test(s)) out[3].push(`${s}ем`);
    out[4].push(`${s}е`);
  }
  if (w.length >= 5 && SURNAME_END.test(w)) out[3].push(`${w}ым`); // Иванов → Ивановым (и «Ростовом» от места)
  return out;
}

/** Мужской род на -й: «Сергей», «Николай», «Василий», «Дмитрий». */
function mascJ(w) {
  if (/ий$/i.test(w)) {
    const b = w.slice(0, -2);
    return mk(`${b}ия`, `${b}ию`, `${b}ия`, `${b}ием`, `${b}ии`);
  }
  const b = w.slice(0, -1);
  return mk(`${b}я`, `${b}ю`, `${b}я`, `${b}ем`, `${b}е`);
}

/** На мягкий знак: мужской («Игорь», «Кремль») и женский («Рязань», «Любовь», «Церковь») рода вместе. */
function soft(w) {
  const b = w.slice(0, -1);
  const male = mk(`${b}я`, `${b}ю`, `${b}я`, [`${b}ем`, `${b}ём`], `${b}е`);
  const bases = [b];
  if (/овь$/i.test(w) && w.length >= 5) bases.push(`${w.slice(0, -3)}в`); // Церковь → Церкв-, Любовь → Любв-
  const female = [[], [], [w], [], []];
  for (const s of bases) {
    female[0].push(`${s}и`);
    female[1].push(`${s}и`);
    female[3].push(`${s}ью`);
    female[4].push(`${s}и`);
  }
  return merge(male, female);
}

/** Женский род (и мужские имена) на -а: «Анна», «Ольга», «Никита», «Москва», «Иванова». */
function femHard(w) {
  const b = w.slice(0, -1);
  const instr = SIBILANT_OR_TS.test(b) ? [`${b}ей`, `${b}ой`] : [`${b}ой`];
  const out = mk(VELAR.test(b) || SIBILANT.test(b) ? `${b}и` : `${b}ы`, `${b}е`, `${b}у`, instr, `${b}е`);
  if (w.length >= 5 && SURNAME_END.test(b)) { // женская фамилия: Иванова → Ивановой
    out[0].push(`${b}ой`);
    out[1].push(`${b}ой`);
    out[4].push(`${b}ой`);
  }
  return out;
}

/** На -я: «Катя», «Илья», «Софья», «Мария». */
function femSoft(w) {
  if (/ия$/i.test(w)) {
    const b = w.slice(0, -1);
    return mk(`${b}и`, `${b}и`, `${b}ю`, `${b}ей`, `${b}и`);
  }
  const b = w.slice(0, -1);
  if (/ья$/i.test(w)) return mk(`${b}и`, `${b}е`, `${b}ю`, [`${b}ей`, `${b}ёй`], `${b}е`);
  return mk(`${b}и`, `${b}е`, `${b}ю`, `${b}ей`, `${b}е`);
}

/** Средний род (названия мест): «Подмосковье», «озеро», «море», «Побережье». */
function neuter(w) {
  if (/о$/i.test(w)) {
    const b = w.slice(0, -1);
    return mk(`${b}а`, `${b}у`, [w], `${b}ом`, `${b}е`);
  }
  if (/ие$/i.test(w)) {
    const b = w.slice(0, -2);
    return mk(`${b}ия`, `${b}ию`, [w], `${b}ием`, `${b}ии`);
  }
  const b = w.slice(0, -1);
  if (/ье$/i.test(w)) return mk(`${b}я`, `${b}ю`, [w], [`${b}ем`, `${b}ём`], `${b}е`);
  return mk(`${b}я`, `${b}ю`, [w], `${b}ем`, `${b}е`);
}

/** Падежи одного слова без дефиса. opts: { kind, multi, last }. Неизменяемое слово возвращается как есть. */
function wordCases(w, opts) {
  if (!isWord(w) || w.length < 2) return same(w);
  if (w === w.toUpperCase() && w.length > 1) return same(w); // аббревиатура
  if (PARTICLES.has(lower(w)) && w === lower(w)) return same(w);
  const l = lower(w);
  if (/(?:ых|их)$/.test(l) && l.length > 3) return same(w); // «Ростовых», «Белых»: родительный множественного, не меняется
  const adj = adjType(w, opts);
  if (adj) return adjCases(w, adj);
  if (/ия$/.test(l) || /я$/.test(l)) return femSoft(w);
  if (/а$/.test(l)) return femHard(w);
  if (/ь$/.test(l)) return soft(w);
  if (/й$/.test(l)) return mascJ(w);
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(l)) return mascHard(w);
  if (/[ое]$/.test(l) && opts.kind === 'place' && w.length >= 4) return neuter(w);
  return same(w); // Ли, Мэри, Нелли, Гюго: не изменяются
}

const yo = (s) => s.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

function withYo(cases) {
  return cases.map((variants) => [...new Set(variants.flatMap((v) => (/[ёЁ]/.test(v) ? [v, yo(v)] : [v])))]);
}

/** Слово с возможным дефисом: «Санкт-Петербург», «Ростов-на-Дону», «Мамин-Сибиряк». */
function tokenCases(token, opts) {
  const parts = token.split('-');
  if (parts.length === 1) return withYo(wordCases(token, opts));
  const part = (p, o) => wordCases(p, { ...o, multi: false, last: true });
  const particleInside = parts.some((p, i) => i > 0 && PARTICLES.has(lower(p)) && p === lower(p));
  const capital = (p) => p.length >= 2 && p[0] !== lower(p[0]);
  let declined;
  if (particleInside) declined = parts.map((p, i) => (i === 0 ? part(p, opts) : same(p)));
  else if (opts.kind === 'character' && parts.every(capital)) declined = parts.map((p) => part(p, opts));
  else declined = parts.map((p, i) => (i === parts.length - 1 ? part(p, opts) : same(p)));
  return withYo(combine(declined, '-'));
}

/** Сочетания форм слов по падежам: для каждого падежа все слова стоят в этом падеже. */
function combine(perWord, glue) {
  const out = [];
  for (let c = 0; c < 5; c += 1) {
    let acc = [''];
    perWord.forEach((cases, i) => {
      const next = [];
      for (const prefix of acc) {
        for (const v of cases[c]) {
          next.push(i === 0 ? v : `${prefix}${glue}${v}`);
          if (next.length >= MAX_COMBOS) break;
        }
        if (next.length >= MAX_COMBOS) break;
      }
      acc = next;
    });
    out.push([...new Set(acc)]);
  }
  return out;
}

/**
 * Падежные формы названия или имени (без именительного падежа): Set строк.
 * opts.kind: 'character' | 'place' (для мест добавляется склонение среднего рода: «Подмосковье»).
 */
function caseForms(name, opts = {}) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) return new Set();
  const words = text.split(' ');
  if (words.length > MAX_WORDS) return new Set();
  const kind = opts.kind || '';
  const perWord = words.map((w, i) => tokenCases(w, { kind, multi: words.length > 1, last: i === words.length - 1 }));
  const forms = new Set(combine(perWord, ' ').flat());
  if (/[ёЁ]/.test(text)) forms.add(yo(text)); // «Семён» часто печатают как «Семен»
  forms.delete(text);
  return forms;
}

/**
 * Все сгенерированные формы для названия карточки и «Имён в тексте»: массив строк.
 * Имена в «Имена в тексте», которые уже являются формой предыдущего имени («Анны» при названии «Анна»),
 * не склоняются повторно. Явные имена в результат не входят.
 */
function nameForms(title, aliases = [], opts = {}) {
  const explicit = new Set([title, ...aliases].map((x) => lower(String(x).trim())));
  const generated = new Set();
  const out = [];
  for (const name of [title, ...aliases]) {
    const key = lower(String(name).trim());
    if (!key || generated.has(key)) continue;
    for (const f of caseForms(name, opts)) {
      const fk = lower(f);
      if (generated.has(fk)) continue;
      generated.add(fk);
      if (!explicit.has(fk) && fk.length >= 2) out.push(f);
    }
  }
  return out;
}

module.exports = { caseForms, nameForms };
