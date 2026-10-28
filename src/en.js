'use strict';

// Английский язык для анализа текста: те же результаты, что у morph.js (части речи, пассив, предложения), но для английского.
// Без словаря: закрытые списки служебных слов, окончания и соседние слова. Разбор приблизительный.
// Эвристики для пассива, времён и повторов лежат здесь же, чтобы русская логика осталась нетронутой.

const set = (s) => new Set(s.trim().split(/\s+/));
const norm = (w) => String(w).toLowerCase().replace(/[’‘]/g, "'");

const DET = set('a an the this that these those my your his her its our their some any no every each all both either neither another such many much few several most more less other whose which what');
const PREP = set(`of in on at by for with from to into onto upon over under about above below between among through during before after against without within across behind beyond near off out up down around along toward towards like as than past inside outside beside besides except per via`);
const CONJ = set('and but or nor so yet if because although though while when whenever where whereas unless until since once whether that than then');
const PRON = set(`i me myself you yourself yourselves he him himself she her herself it itself we us ourselves they them themselves who whom someone anyone everyone nobody somebody anybody everybody nothing something anything everything one mine yours hers ours theirs`);
const SUBJ = set('i you he she it we they who someone anyone everyone nobody somebody everybody');
const POSS = set('my your his her its our their whose');
const BE = set('be am is are was were been being');
const HAVE = set('have has had having');
const DO = set('do does did doing done');
const MODAL = set('will would shall should can could may might must cannot');
const AUX = new Set([...BE, ...HAVE, ...DO, ...MODAL]);
const ADV = set(`not never always often very too quite just only also even still already soon now then here there ever again almost perhaps maybe
  seldom rarely sometimes usually really rather somewhat nearly merely hardly barely scarcely instead afterwards meanwhile together apart away aside
  ahead back forward home upstairs downstairs outside inside indoors abroad today tomorrow yesterday tonight forever once twice else anyway anyhow
  somehow somewhere anywhere everywhere nowhere well far fast hard late early enough yet thus hence therefore however otherwise indeed alone along
  straight suddenly quickly slowly softly quietly gently`);
const NOT_ADV = set(`family only early friendly lonely lovely ugly silly holy belly bully jelly fly reply supply apply rely ally assembly anomaly butterfly july italy
  lily sally billy molly polly kelly emily holly daily likely unlikely lively deadly costly elderly orderly timely cowardly curly chilly hilly jolly
  monopoly melancholy anomaly rally tally folly gully dolly wily surly sly shy ugly oily wily bubbly crumbly sparkly spindly prickly`);
const NUMWORDS = set('one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million first second third');

// Частые прилагательные.
const ADJ = set(`good bad new old young big small large little long short tall high low great hot cold warm cool dark light heavy thin thick wide narrow deep
  empty full open closed quiet loud soft hard dry wet clean dirty rich poor happy sad angry afraid sure ready free strong weak sick well real true false
  whole right wrong same different other own only last next first early late dead alive proud lonely tired bored strange familiar pale red green blue black
  white yellow brown gray grey golden silver wooden iron stone broken lost final main major minor huge tiny vast bright dim sharp smooth rough sweet bitter
  fresh ancient modern public private common rare simple easy difficult dangerous safe careful gentle wild calm cruel kind nice fine pretty beautiful ugly
  strange odd weird certain clear plain fair fat flat blind deaf mad glad able unable eager anxious nervous silent distant close near
  hungry thirsty lazy busy lucky funny noisy dusty muddy rusty tasty shiny messy greedy guilty clumsy jealous curious furious generous grumpy sleepy stormy
  windy cloudy rainy sunny foggy icy tidy bumpy hairy scary shaky sticky thirsty worthy wealthy healthy heavy empty dirty lonely friendly lovely ugly silly`);
const STATIVE = set(`tired excited bored scared surprised worried interested pleased married ashamed shocked amazed confused relieved satisfied disappointed
  depressed exhausted annoyed embarrassed determined convinced concerned delighted thrilled terrified frightened puzzled gone dead lost closed open
  crowded packed filled covered dressed seated dedicated limited advanced devoted pained obliged inclined supposed related equipped prepared qualified
  talented gifted skilled experienced sophisticated sacred wicked naked beloved aged learned crooked rugged`);

// Неправильные глаголы: прошедшее и причастие II.
const IRR = `be was been|have had had|do did done|say said said|go went gone|get got gotten|make made made|know knew known|think thought thought|take took taken
  see saw seen|come came come|give gave given|find found found|tell told told|become became become|leave left left|feel felt felt|bring brought brought
  begin began begun|keep kept kept|hold held held|write wrote written|stand stood stood|hear heard heard|let let let|mean meant meant|set set set|meet met met
  run ran run|pay paid paid|sit sat sat|speak spoke spoken|lie lay lain|lead led led|read read read|grow grew grown|lose lost lost|fall fell fallen|send sent sent
  build built built|understand understood understood|draw drew drawn|break broke broken|spend spent spent|cut cut cut|rise rose risen|drive drove driven
  buy bought bought|wear wore worn|choose chose chosen|seek sought sought|throw threw thrown|catch caught caught|deal dealt dealt|win won won|forget forgot forgotten
  lay laid laid|eat ate eaten|sell sold sold|fight fought fought|teach taught taught|hang hung hung|shake shook shaken|swim swam swum|sing sang sung|ring rang rung
  drink drank drunk|sleep slept slept|wake woke woken|steal stole stolen|hide hid hidden|fly flew flown|bite bit bitten|blow blew blown|bear bore borne|beat beat beaten
  bend bent bent|bind bound bound|bleed bled bled|feed fed fed|forgive forgave forgiven|freeze froze frozen|hit hit hit|hurt hurt hurt|kneel knelt knelt|lend lent lent
  light lit lit|put put put|ride rode ridden|shoot shot shot|shut shut shut|sink sank sunk|slide slid slid|spin spun spun|spread spread spread|stick stuck stuck
  strike struck struck|swear swore sworn|swing swung swung|tear tore torn|wind wound wound|dig dug dug|shine shone shone|spit spat spat|sweep swept swept|weep wept wept`;
const PAST = new Set();
const PP = new Set();
const BASE_IRR = new Set();
for (const row of IRR.split(/\||\n/)) {
  if (!row.trim()) continue;
  const [b, p, pp] = row.trim().split(/\s+/);
  BASE_IRR.add(b);
  PAST.add(p);
  PP.add(pp);
}
PAST.delete('let'); PAST.delete('set'); PAST.delete('put'); PAST.delete('cut'); PAST.delete('hit'); PAST.delete('hurt'); PAST.delete('shut'); PAST.delete('spread'); PAST.delete('read'); PAST.delete('beat');
PAST.delete('lost'); // «lost» чаще прилагательное; прошедшее ловится по окончанию контекста
PAST.add('lost');
PAST.delete('light'); PAST.delete('found'); PAST.add('found');

// Частые обычные глаголы (основные формы): помогают отличить глагол от существительного.
const VERBS = set(`say go see look take make come get give know think want need find tell ask seem feel try leave call keep let begin show hear play run move live
  believe bring happen write sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read spend grow open walk
  win offer remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain turn smile nod shrug sigh laugh whisper shout
  cry stare glance reply answer sleep wake eat drink sit lie rise stand push pull pick drop catch throw hold carry lift raise lower climb jump step kneel
  reach touch hug kiss hit kick grab shake wave point wonder hope wish fear dream suppose decide agree refuse promise forget realize notice imagine mean
  start finish end return arrive enter exit pass cross lean rest hurry rush drag slip slide crawl creep wander approach face fill pour cover close shut
  hide seek search lock unlock knock ring sing dance cook clean wash dress wear pull`);
const COMMON_NOUN_VERBS = set('look walk turn show call run play work rest stop wait step smile laugh nod sigh wave kiss hug kick push pull drop catch fall rise cry dream hope wish fear love end start return change move cut hit'); // чаще существительное после артикля

const ING_NOUN = set(`building morning evening ceiling feeling meeting painting wedding thing nothing something anything everything king spring string ring wing bring sing swing during
  darling sibling duckling clothing beginning ending opening saying warning feeling living lightning earring offspring bling`);
const NOT_ED = set('bed red hundred weed seed deed creed need feed speed bleed breed indeed shed sled sacred');
const ED_ADJ_OK = new Set();

const ABBR = set('mr mrs ms dr prof sr jr st vs etc e.g i.e no fig vol al approx inc ltd co mt');

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?(?:-[\p{L}\p{N}]+)*/gu;

// ---------- токены ----------
function isFirstInSentence(text, start) {
  const before = text.slice(0, start).replace(/[\s"“”«»'‘’(\[—–-]+$/u, '');
  return before === '' || /[.!?…]$/.test(before);
}

function baseOf(low) {
  // «don't» → «do», «can't» → «can», «he's» → «he»
  const m = /^(.+?)(?:n't|'s|'re|'ve|'ll|'d|'m)$/.exec(low);
  return m ? m[1] : low;
}

function classifyAt(words, i, text) {
  const w = words[i];
  const low = norm(w.text);
  const raw = w.text;
  if (/^\d/.test(low) || NUMWORDS.has(low)) return 'num';
  const b = baseOf(low);
  if (b !== low) {
    if (/n't$/.test(low)) return 'verb';
    if (/'(?:s|re|ve|ll|d|m)$/.test(low)) {
      if (SUBJ.has(b) || ['that', 'there', 'what', 'here', 'let', 'who'].includes(b)) return 'pron';
      return 'noun'; // «John's» (притяжательное)
    }
  }
  if (PRON.has(low) || POSS.has(low)) return 'pron';
  if (AUX.has(low)) return 'verb';
  if (DET.has(low) || PREP.has(low) || CONJ.has(low) || low === 'to') return 'other';
  if (ADV.has(low)) return 'adv';
  if (/ly$/.test(low) && low.length > 4 && !NOT_ADV.has(low) && !/(?:ally|ily)$/.test(low.slice(0, -2) + 'ly') || /^(?:ally|ily)$/.test(low)) return 'adv';
  if (/(?:ally)$/.test(low) && low.length > 5 && !NOT_ADV.has(low)) return 'adv';
  // имя собственное: с заглавной не в начале предложения
  const first = isFirstInSentence(text, w.start);
  if (!first && raw[0] !== raw[0].toLowerCase() && raw !== raw.toUpperCase()) return 'noun';
  if (!first && raw.length > 1 && raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return 'noun';

  // предыдущее значимое слово (наречия пропускаем)
  let k = i - 1;
  while (k >= 0 && (words[k].pos === 'adv')) k -= 1;
  const prev = k >= 0 && !(text.slice(words[k].end, w.start).match(/[.!?…;:]/)) ? words[k] : null;
  const pl = prev ? norm(prev.text) : '';
  const prevTag = prev ? prev.pos : '';
  const afterDet = prev && (DET.has(pl) || POSS.has(pl)) ;
  const nextW = words[i + 1];
  const gap = nextW ? text.slice(w.end, nextW.start) : '.';
  const nextClosed = !nextW || /[.,;:!?…—–()"“”]/.test(gap) || ((() => {
    const n = norm(nextW.text);
    // после слова идёт глагол в прошедшем («The door slammed»): само оно существительное
    const verbish = PAST.has(n) || (/ed$/.test(n) && n.length > 3 && !NOT_ED.has(n) && !STATIVE.has(n) && !ADJ.has(n));
    return PREP.has(n) || CONJ.has(n) || AUX.has(n) || PRON.has(n) || DET.has(n) || ADV.has(n) || n === 'to' || verbish;
  })());

  const isVerbCtx = prev && (SUBJ.has(pl) || MODAL.has(pl) || pl === 'to' || ['not', "n't"].includes(pl) || /n't$/.test(pl) || DO.has(pl) && pl !== 'done'
    || (prevTag === 'noun' && /(?:s)$/.test(low) && !/(?:ss|us|is)$/.test(low)) || (prevTag === 'noun' && !nextClosed === false && /^[a-z]+$/.test(low) && VERBS.has(low)));

  if (BE.has(pl) || HAVE.has(pl)) {
    if (/ing$/.test(low) && low.length > 4) return 'part';
    const perfect = HAVE.has(pl) && !BE.has(pl); // «had lost»: причастие в составе времени, не прилагательное
    if (/ed$/.test(low) && low.length > 3 && !NOT_ED.has(low)) return STATIVE.has(low) && !perfect ? 'adj' : 'part';
    if (PP.has(low)) return STATIVE.has(low) && !perfect ? 'adj' : 'part';
    if (ADJ.has(low)) return 'adj';
  }
  if (ADJ.has(low)) return afterDet && nextClosed ? 'noun' : 'adj';
  if (PAST.has(low) || (PP.has(low) && BASE_IRR.has(low) === false)) {
    if (afterDet) return nextClosed ? 'noun' : 'adj';
    return 'verb';
  }
  if (BASE_IRR.has(low) || VERBS.has(low)) {
    if (afterDet && COMMON_NOUN_VERBS.has(low)) return 'noun';
    if (afterDet) return nextClosed ? 'noun' : 'adj';
    if (prev && PREP.has(pl) && pl !== 'to') return /ing$/.test(low) ? 'part' : 'noun';
    return 'verb';
  }
  if (/ing$/.test(low) && low.length > 4 && !ING_NOUN.has(low)) {
    if (afterDet) return nextClosed ? 'noun' : 'adj';
    return 'part';
  }
  if (ING_NOUN.has(low)) return 'noun';
  if (/ed$/.test(low) && low.length > 3 && !NOT_ED.has(low) && !/(?:eed|ied)$/.test(low.slice(0, 0))) {
    if (STATIVE.has(low) && !(prev && SUBJ.has(pl))) return 'adj';
    if (afterDet || (prevTag === 'adj' && !nextClosed === false)) return nextClosed ? 'noun' : 'adj';
    return 'verb';
  }
  if (/(?:ous|ful|less|ive|able|ible|ish|ic|ical|ary|ory|ent|ant|al)$/.test(low) && low.length > 4 && !/(?:tion|ment|ness|ance|ence)$/.test(low)) {
    if (/(?:ous|ful|less|ive|able|ible|ish|ic|ical)$/.test(low)) return afterDet && nextClosed && !/^(?:active)$/.test(low) ? 'noun' : 'adj';
  }
  if (/(?:tion|sion|ment|ness|ity|ance|ence|ship|hood|ism|ist|age|ure|ery|ology)s?$/.test(low) && low.length > 4) return 'noun';
  if (prev && !afterDet && thirdSg(low) && (['and', 'but', 'or', 'then'].includes(pl) || SUBJ.has(pl))) return 'verb';
  if (isVerbCtx && !afterDet) return 'verb';
  if (/^(?:s?he|it)$/.test(pl) && /s$/.test(low)) return 'verb';
  if (afterDet || prevTag === 'adj') return nextClosed || prevTag === 'adj' ? 'noun' : 'adj';
  return 'noun';
}

/** Слова абзаца: [{ start, end, text, pos }], pos: verb | noun | adj | adv | part | pron | num | other. */
function tokenize(text) {
  const words = [];
  for (const m of String(text).matchAll(WORD_RE)) words.push({ start: m.index, end: m.index + m[0].length, text: m[0], pos: 'other' });
  // два прохода: наречия и служебные слова размечаются первыми, чтобы контекст видел их
  for (let i = 0; i < words.length; i += 1) {
    const low = norm(words[i].text);
    if (ADV.has(low)) words[i].pos = 'adv';
  }
  for (let i = 0; i < words.length; i += 1) words[i].pos = classifyAt(words, i, text);
  return words;
}

// ---------- страдательный залог ----------
const SKIP_BETWEEN = set("not n't never also just still already soon always often quickly slowly suddenly finally later then once really simply merely barely hardly");

function isParticiple(low) {
  if (STATIVE.has(low)) return false;
  if (/ed$/.test(low) && low.length > 4 && !NOT_ED.has(low)) return true;
  return PP.has(low) && low.length > 2 && !['been', 'done', 'gone', 'let', 'set', 'put', 'cut', 'hit', 'hurt', 'shut', 'read'].includes(low) || ['set', 'put', 'cut', 'hit', 'shut', 'read', 'hurt', 'let'].includes(low) && false;
}

/** be + причастие: «was written», «had been broken», «is being built». Возвращает [{ start, end }]. */
function findPassive(words, text = '') {
  const spans = [];
  for (let i = 0; i < words.length; i += 1) {
    const low = norm(words[i].text);
    if (!BE.has(low) && !/^(?:get|gets|got)$/.test(low) && !/'s$|'re$|'m$/.test(low)) continue;
    if (/^(?:get|gets|got)$/.test(low)) continue; // «got caught» пока не считаем
    if (/'s$|'re$|'m$/.test(low) && !['he', 'she', 'it', 'that', 'there', 'what', 'who', 'we', 'you', 'they', 'i'].includes(baseOf(low))) continue;
    let j = i + 1;
    let hops = 0;
    while (j < words.length && hops < 4) {
      const n = norm(words[j].text);
      if (SKIP_BETWEEN.has(n) || words[j].pos === 'adv' || BE.has(n)) { j += 1; hops += 1; continue; }
      break;
    }
    if (j >= words.length) continue;
    if (text && /[.!?…;:]/.test(text.slice(words[i].end, words[j].start))) continue;
    const cand = norm(words[j].text);
    if (!isParticiple(cand)) continue;
    // «was tired of»: качество, а не действие; после причастия сразу существительное: «was a broken»
    if (BE.has(low) && /^(?:am|is|are)$/.test(low) === false && false) continue;
    spans.push({ start: words[i].start, end: words[j].end });
    i = j;
  }
  return spans;
}

// ---------- предложения ----------
function sentences(text) {
  const out = [];
  const push = (from, to) => {
    const body = text.slice(from, to);
    const lead = body.length - body.trimStart().length;
    const trimmed = body.trim();
    if (!trimmed) return;
    out.push({ start: from + lead, end: from + lead + trimmed.length, words: (trimmed.match(WORD_RE) || []).length });
  };
  let start = 0;
  const re = /[.!?…]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let end = m.index + m[0].length;
    while (end < text.length && /["”’')\]]/.test(text[end])) end += 1;
    const rest = text.slice(end);
    if (rest.trim() && !/^\s/.test(rest)) continue; // «3.5», «e.g.», «site.com»
    if (rest.trim() && m[0] === '.') {
      const tok = (/([\p{L}.]+)$/u.exec(text.slice(start, m.index)) || [])[1] || '';
      const low = tok.toLowerCase().replace(/\.$/, '');
      if (ABBR.has(low) || (/^\p{Lu}$/u.test(tok) && /(?:^|\s)$/.test(text.slice(start, m.index - 1)))) continue;
      if (/^\s*[a-z]/.test(rest) && !/^\s*[“"'‘]/.test(rest)) continue; // «Mr. smith» / продолжение строчной буквой
    }
    if (/[!?…]/.test(m[0]) && /^\s+[a-z]/.test(rest)) continue; // «“Really?” she asked»
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return out;
}

/** Всё сразу для одного абзаца (как analyzeBlock в morph.js). */
function analyzeBlock(text) {
  const words = tokenize(text);
  return { words, passive: findPassive(words, text), sentences: sentences(text) };
}

// ---------- основа слова для повторов ----------
function stem(word, pos) {
  let w = norm(word).replace(/'s$/, '');
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(?:sses|xes|ches|shes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (/s$/.test(w) && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (/ing$/.test(w) && w.length > 5) { w = w.slice(0, -3); if (/(.)\1$/.test(w)) w = w.slice(0, -1); }
  else if (/ed$/.test(w) && w.length > 4) { w = /ied$/.test(w) ? `${w.slice(0, -3)}y` : w.slice(0, -2); if (/(.)\1$/.test(w)) w = w.slice(0, -1); }
  else if (/ly$/.test(w) && w.length > 5 && pos === 'adv') w = w.slice(0, -2);
  if (/e$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

// ---------- время глагола (повествование в настоящем или прошедшем) ----------
const MEMORY = /(?:^|[^a-z])(?:remember(?:ed|s|ing)?|recall(?:ed|s|ing)?|once|ago|yesterday|earlier|used to|back then|in those days|as a child|childhood|long before|years before|the day before|the night before|last (?:night|week|month|year|summer|winter)|at that time|in the past|days later|years later)(?![a-z])/;
const SUB_CONJ = set('that because when whenever as after before while until since although though if once where whereas');
const REPORT = set('said asked replied answered whispered shouted cried muttered murmured added continued explained thought wondered called');

function thirdSg(low) {
  if (!/s$/.test(low) || /(?:ss|us|is)$/.test(low) || low.length < 4) return false;
  const base = /ies$/.test(low) ? `${low.slice(0, -3)}y` : /(?:ches|shes|sses|xes|zes|oes)$/.test(low) ? low.slice(0, -2) : low.slice(0, -1);
  return VERBS.has(base) || BASE_IRR.has(base);
}

/** Время глагола-формы: 'past' | 'present' | null (инфинитив, причастие, модальный, вспомогательный в сложной форме). */
function verbTense(words, i) {
  const w = words[i];
  if (w.pos !== 'verb' && w.pos !== 'part') return null;
  const low = norm(w.text);
  let k = i - 1;
  while (k >= 0 && words[k].pos === 'adv') k -= 1;
  const pl = k >= 0 ? norm(words[k].text) : '';
  const afterCtx = MODAL.has(pl) || pl === 'to' || DO.has(pl) || /n't$/.test(pl) || BE.has(pl) || HAVE.has(pl) || pl === 'let' || pl === 'help';
  if (/n't$/.test(low)) { // didn't, doesn't, don't, wasn't...
    if (/^(?:didn't|wasn't|weren't|hadn't)$/.test(low)) return 'past';
    if (/^(?:doesn't|don't|isn't|aren't|hasn't|haven't)$/.test(low)) return 'present';
    return null;
  }
  if (w.pos === 'part') return null;
  if (MODAL.has(low)) return null;
  if (low === 'was' || low === 'were' || low === 'did') return 'past';
  if (low === 'had') { // had + причастие: давнопрошедшее, не считаем
    let j = i + 1;
    while (j < words.length && words[j].pos === 'adv') j += 1;
    if (j < words.length && (words[j].pos === 'part' || BE.has(norm(words[j].text)))) return null;
    return afterCtx ? null : 'past';
  }
  if (low === 'am' || low === 'is' || low === 'are') return 'present';
  if (low === 'have' || low === 'has' || low === 'does' || low === 'do') {
    if (afterCtx && !HAVE.has(pl)) return null;
    if (afterCtx) return null;
    return 'present';
  }
  if (BE.has(low) || low === 'being' || low === 'having' || low === 'doing' || low === 'done') return null;
  if (afterCtx) return null;
  if (PAST.has(low) || (/ed$/.test(low) && low.length > 3 && !NOT_ED.has(low) && !STATIVE.has(low))) return 'past';
  if (/ing$/.test(low) && !ING_NOUN.has(low)) return null;
  if (['and', 'but', 'then', 'or'].includes(pl) && thirdSg(low)) return 'present'; // «she smiles and nods»
  // настоящее: после подлежащего
  const subj = k >= 0 && (SUBJ.has(pl) || words[k].pos === 'noun');
  if (!subj) return null;
  if (/^(?:s?he|it)$/.test(pl) || (words[k].pos === 'noun' && /s$/.test(low) && !/(?:ss|us|is)$/.test(low))) return /s$/.test(low) || BASE_IRR.has(low) ? 'present' : null;
  if (/^(?:i|you|we|they)$/.test(pl)) return 'present';
  return null;
}

/** Как analyzeTenseBlock в tense.js: { past, present, items: [{ start, end, wi, kind }] } только по повествованию. */
function analyzeTenseBlock(text, words, sents) {
  const { speechRanges } = require('./tense');
  const ranges = speechRanges(text);
  const inSpeech = (pos) => ranges.some(([a, b]) => pos >= a && pos < b);
  const res = { past: 0, present: 0, items: [] };
  let scope = false;
  for (const s of sents) {
    const sw = [];
    words.forEach((w, wi) => { if (w.start >= s.start && w.end <= s.end && !inSpeech(w.start)) sw.push(wi); });
    if (!sw.length) continue;
    const narrText = [...text.slice(s.start, s.end)].map((ch, n) => (inSpeech(s.start + n) ? ' ' : ch)).join('');
    const mem = MEMORY.test(norm(narrText)); // слова в кавычках воспоминанием не считаются
    const kinds = sw.map((wi) => verbTense(words, wi));
    const present = kinds.includes('present');
    const inMem = mem || (scope && !present);
    scope = inMem;
    let sub = false;
    const first = norm(words[sw[0]].text);
    if (SUB_CONJ.has(first) && text.slice(words[sw[0]].end, s.end).includes(',')) sub = true;
    let leading = sub;
    sw.forEach((wi, n) => {
      const prevW = n > 0 ? norm(words[sw[n - 1]].text) : '';
      const gap = n > 0 ? text.slice(words[sw[n - 1]].end, words[wi].start) : '';
      if (leading && gap.includes(',')) { sub = false; leading = false; }
      if (!leading && n > 0 && SUB_CONJ.has(norm(words[wi].text))) sub = true;
      if (!leading && sub && gap.includes(',') && !SUB_CONJ.has(norm(words[wi].text)) && /,\s*$/.test(gap)) sub = false;
      const kind = kinds[n];
      if (!kind || inMem) return;
      if (kind === 'present') res.present += 1;
      if (sub) return;
      if (kind === 'past') res.past += 1;
      res.items.push({ start: words[wi].start, end: words[wi].end, wi, kind });
    });
  }
  return res;
}

const ANAPHORA_STARTS = set('and but so or');

module.exports = { analyzeTenseBlock, verbTense, REPORT, tokenize, findPassive, sentences, analyzeBlock, stem, norm, ANAPHORA_STARTS, PAST, PP, BE, HAVE, DO, MODAL, AUX, SUBJ, STATIVE, BASE_IRR, VERBS, baseOf };
