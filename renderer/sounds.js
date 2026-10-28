// Звуки печатной машинки.
// По умолчанию звук синтезируется на лету. Для каждой клавиши (буквы, пробел, delete, enter) можно загрузить
// свои записи и выбрать одну из них или все вперемешку (см. setKeyFiles и setKeySel).
//
// Звуки клавиш сохраняют прежний тембр. У обычной клавиши высота глухого удара каждый раз
// берётся из одной гаммы (ля-минорная пентатоника) и плавно «ходит» по ней, поэтому набор текста
// складывается в ненавязчивую мелодию, а не в случайный шум.

// Варианты звука клавиш (ключ -> подпись).
export const PROFILES = {
  typewriter: 'Машинка',
  soft: 'Мягкие',
  mech: 'Механика',
  pen: 'Перо',
};

const SCALE = [110.0, 130.81, 146.83, 164.81, 196.0, 220.0]; // ля, до, ре, ми, соль, ля (около прежних 150 Гц)

export class TypeSounds {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.enabled = true;
    this.volume = 0.6; // 0..1
    this.keyBuf = { key: [], space: [], enter: [], backspace: [] }; // загруженные записи: [{ file, buffer }]
    this.keySel = { key: 'default', space: 'default', enter: 'default', backspace: 'default' }; // default | * | имя файла
    this.profile = 'typewriter';
    this.last = 0;
    this.noteIdx = 2;
  }

  setProfile(name) {
    this.profile = Object.hasOwn(PROFILES, name) ? name : 'typewriter';
  }

  /** Какая запись играет для клавиши: 'default' (синтез), '*' (любая из загруженных) или имя файла. */
  setKeySel(kind, sel) {
    if (Object.hasOwn(this.keyBuf, kind)) this.keySel[kind] = sel || 'default';
  }

  setKeyFiles(kind, items) {
    if (Object.hasOwn(this.keyBuf, kind)) this.keyBuf[kind] = items;
  }

  /** Байты файла -> AudioBuffer. */
  async decode(data) {
    const ctx = this._ensure();
    if (!ctx) throw new Error('Звук недоступен.');
    const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return ctx.decodeAudioData(bytes);
  }

  /** Контекст звука (создаётся при первом обращении, пытается «проснуться»). */
  getContext() {
    return this._ensure();
  }

  setEnabled(on) {
    this.enabled = !!on;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.value = this.volume * this.volume;
  }

  /** Короткая демонстрация для кнопки «Проверить звук». */
  test() {
    const seq = [['key', 0], ['key', 140], ['key', 270], ['space', 420], ['key', 560], ['backspace', 740], ['enter', 1000]];
    for (const [kind, ms] of seq) setTimeout(() => this.play(kind), ms);
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * this.volume;
      this.master.connect(this.ctx.destination);

      const len = this.ctx.sampleRate; // секунда белого шума, из неё нарезаются щелчки
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  play(kind) {
    if (!this.enabled || this.volume <= 0) return;
    const now = performance.now();
    if (now - this.last < 18) return; // не чаще ~50 звуков в секунду
    this.last = now;
    const ctx = this._ensure();
    if (!ctx) return;

    const list = this.keyBuf[kind];
    const sel = this.keySel[kind];
    if (list && list.length && sel !== 'default') {
      const pick = sel === '*' ? list[Math.floor(Math.random() * list.length)] : list.find((x) => x.file === sel);
      if (pick) {
        this._sample(pick.buffer);
        return;
      }
    }
    const t = ctx.currentTime + 0.002;
    const name = Object.hasOwn(PROFILES, this.profile) ? this.profile : 'typewriter';
    const fn = this[`_${kind}_${name}`] || this[`_${kind}_typewriter`] || this._key_typewriter;
    fn.call(this, t);
  }

  /**
   * Лёгкий «динь» при достижении цели по словам: две мягкие чистые ноты из той же гаммы.
   * Не зависит от выключателя звуков клавиш, но подчиняется громкости.
   */
  chime() {
    if (this.volume <= 0) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    this._ding(t, 659.25, 0.55, 0.12);        // ми
    this._ding(t + 0.12, 880.0, 0.95, 0.1);   // ля
  }

  // ---------- готовые записи ----------

  _sample(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.96 + Math.random() * 0.08; // лёгкая случайность, чтобы не было «пулемёта»
    src.connect(this.master);
    src.start();
  }

  // ---------- синтез ----------

  _burst(t, dur, { type = 'bandpass', freq = 2000, q = 1, gain = 0.4, attack = 0.001 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    return filter;
  }

  // Глухой удар с падающим тоном: from -> to за dur секунд.
  _tone(t, from, to, dur, gain, type = 'sine') {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  _ding(t, freq, dur, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // Следующая нота обычной клавиши: небольшой шаг по гамме вверх или вниз, у краёв отражается.
  _nextNote() {
    const steps = [-2, -1, -1, 0, 1, 1, 2];
    let i = this.noteIdx + steps[Math.floor(Math.random() * steps.length)];
    const max = SCALE.length - 1;
    if (i < 0) i = -i;
    if (i > max) i = 2 * max - i;
    this.noteIdx = Math.min(max, Math.max(0, i));
    return SCALE[this.noteIdx];
  }

  // обычная клавиша: удар литеры + глухой «стук» о валик. Высота стука из гаммы,
  // падение тона то же, что и раньше (примерно вдвое).
  _key_typewriter(t) {
    const j = 0.9 + Math.random() * 0.2;
    const note = this._nextNote();
    this._burst(t, 0.03, { freq: 2400 * j, q: 0.9, gain: 0.5 });
    this._burst(t, 0.012, { type: 'highpass', freq: 5000, gain: 0.22, attack: 0.0005 });
    this._tone(t, note, note * 0.47, 0.06, 0.32);
    this._burst(t + 0.035, 0.05, { type: 'lowpass', freq: 600, gain: 0.18 });
  }

  // пробел: ниже и глуше
  _space_typewriter(t) {
    const j = 0.92 + Math.random() * 0.16;
    this._burst(t, 0.07, { freq: 1100 * j, q: 0.7, gain: 0.45 });
    this._tone(t, 95 * j, 55, 0.1, 0.42);
    this._burst(t + 0.04, 0.06, { type: 'lowpass', freq: 400, gain: 0.25 });
  }

  // удаление: короткий сухой двойной «тик», отличается от обычной клавиши
  _backspace_typewriter(t) {
    const j = 0.94 + Math.random() * 0.12;
    this._burst(t, 0.02, { freq: 3600 * j, q: 1.2, gain: 0.42 });
    this._tone(t, 900 * j, 500, 0.03, 0.12, 'triangle');
    this._burst(t + 0.065, 0.016, { freq: 3000 * j, q: 1.2, gain: 0.22 });
  }

  // Enter: возврат каретки. Звучит иначе, чем буква: сначала сухая трещотка (шесть быстрых
  // щелчков ниже по тембру, чем у клавиши), затем тяжёлый глухой упор каретки с лёгким отскоком.
  // Без звона. Около 0.3 с.
  _enter_typewriter(t) {
    // Возврат каретки: «тррр» (быстрая трещотка, отличается от одиночного стука буквы)
    // и тяжёлый упор в конце. Упор лежит в слышимой на ноутбуке области, а не в самом басу.
    const j = 0.97 + Math.random() * 0.06;
    for (let i = 0; i < 6; i++) {
      this._burst(t + i * 0.022, 0.014, { freq: (1500 + i * 60) * j, q: 2.2, gain: 0.3, attack: 0.0004 });
    }
    const hit = t + 0.19;
    this._tone(hit, 150, 68, 0.16, 0.8);
    this._tone(hit, 300, 140, 0.05, 0.25);
    this._burst(hit, 0.12, { type: 'lowpass', freq: 520, gain: 0.7 });
    this._burst(hit, 0.02, { freq: 1000, q: 0.7, gain: 0.4 });
    this._tone(hit + 0.075, 120, 70, 0.06, 0.22);
    this._burst(hit + 0.075, 0.03, { type: 'lowpass', freq: 500, gain: 0.2 });
  }


  // ---------- вариант «Мягкие»: приглушённые подушечные удары, без резких высоких ----------

  _key_soft(t) {
    const note = this._nextNote();
    this._burst(t, 0.05, { type: 'lowpass', freq: 1300, gain: 0.22, attack: 0.004 });
    this._tone(t, note * 1.5, note * 1.1, 0.09, 0.22);
  }

  _space_soft(t) {
    this._burst(t, 0.08, { type: 'lowpass', freq: 600, gain: 0.26, attack: 0.004 });
    this._tone(t, 100, 62, 0.12, 0.3);
  }

  _backspace_soft(t) {
    this._burst(t, 0.035, { type: 'lowpass', freq: 1800, gain: 0.2, attack: 0.003 });
    this._tone(t, 320, 210, 0.05, 0.12);
  }

  _enter_soft(t) {
    this._burst(t, 0.11, { type: 'lowpass', freq: 900, gain: 0.3, attack: 0.01 });
    this._tone(t + 0.02, 150, 80, 0.14, 0.4);
    this._burst(t + 0.12, 0.06, { type: 'lowpass', freq: 450, gain: 0.2 });
  }

  // ---------- вариант «Механика»: сухой щелчок переключателя и глухой «тук» ----------

  _key_mech(t) {
    const j = 0.92 + Math.random() * 0.16;
    const note = this._nextNote();
    this._burst(t, 0.008, { freq: 4200 * j, q: 1.5, gain: 0.5, attack: 0.0003 });
    this._tone(t + 0.004, note * 1.8, note * 0.9, 0.05, 0.28, 'triangle');
    this._burst(t + 0.012, 0.03, { type: 'lowpass', freq: 900, gain: 0.22 });
  }

  _space_mech(t) {
    const j = 0.94 + Math.random() * 0.12;
    this._burst(t, 0.01, { freq: 2600 * j, q: 1.2, gain: 0.45, attack: 0.0004 });
    this._tone(t + 0.006, 150, 72, 0.09, 0.42);
    this._burst(t + 0.012, 0.05, { type: 'lowpass', freq: 650, gain: 0.3 });
    this._burst(t + 0.075, 0.01, { freq: 3000 * j, q: 1.2, gain: 0.15 });
  }

  _backspace_mech(t) {
    const j = 0.94 + Math.random() * 0.12;
    this._burst(t, 0.006, { freq: 5000 * j, q: 1.4, gain: 0.4, attack: 0.0003 });
    this._tone(t, 700 * j, 480, 0.025, 0.14, 'triangle');
  }

  _enter_mech(t) {
    this._burst(t, 0.01, { freq: 3800, q: 1.4, gain: 0.45, attack: 0.0003 });
    this._burst(t + 0.05, 0.01, { freq: 3300, q: 1.4, gain: 0.45, attack: 0.0003 });
    this._tone(t + 0.05, 130, 70, 0.1, 0.5);
    this._burst(t + 0.05, 0.07, { type: 'lowpass', freq: 700, gain: 0.35 });
  }

  // ---------- вариант «Перо»: шорох пера по бумаге ----------

  _key_pen(t) {
    const f = 3500 + Math.random() * 2500;
    this._burst(t, 0.06, { freq: f, q: 0.8, gain: 0.15, attack: 0.012 });
    this._burst(t + 0.01, 0.03, { type: 'highpass', freq: 6000, gain: 0.06, attack: 0.006 });
  }

  _space_pen(t) {
    this._burst(t, 0.1, { freq: 2600, q: 0.7, gain: 0.11, attack: 0.03 });
  }

  _backspace_pen(t) {
    this._burst(t, 0.035, { freq: 5600, q: 1.0, gain: 0.17, attack: 0.004 });
    this._burst(t + 0.045, 0.03, { freq: 5000, q: 1.0, gain: 0.12, attack: 0.004 });
  }

  _enter_pen(t) {
    const f = this._burst(t, 0.24, { freq: 5000, q: 0.8, gain: 0.14, attack: 0.05 });
    f.frequency.setValueAtTime(5000, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.24);
    this._tone(t + 0.22, 220, 130, 0.05, 0.16);
    this._burst(t + 0.22, 0.03, { type: 'lowpass', freq: 800, gain: 0.14 });
  }
}
