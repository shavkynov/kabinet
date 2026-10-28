// Фоновый эмбиент. Звуки синтезируются на лету из шума, готовые записи не нужны.
// Для каждого варианта можно загрузить свою запись: она играет по кругу вместо синтеза.

export const AMBIENTS = {
  rain: 'Дождь',
  fire: 'Камин',
  wind: 'Ветер',
  sea: 'Море',
  hum: 'Тишина',
};

const SECONDS = 8;
const FADE = 0.6;

export class Ambient {
  constructor(sounds) {
    this.sounds = sounds;
    this.bus = null;
    this.volume = 0.4;
    this.current = null; // { variant, out, stops: [fn] }
    this.buffers = null;
  }

  _ctx() {
    const ctx = this.sounds.getContext();
    if (ctx && !this.bus) {
      this.bus = ctx.createGain();
      this.bus.gain.value = this._gain();
      this.bus.connect(ctx.destination);
    }
    return ctx;
  }

  _gain() {
    return this.volume * this.volume * 0.9;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.bus) this.bus.gain.setTargetAtTime(this._gain(), this.bus.context.currentTime, 0.05);
  }

  // Бесшовные петли шума: конец плавно перетекает в начало.
  _makeBuffers(ctx) {
    if (this.buffers) return this.buffers;
    const rate = ctx.sampleRate;
    const n = Math.floor(rate * SECONDS);
    const m = Math.floor(rate * FADE);
    const make = (fill) => {
      const raw = new Float32Array(n + m);
      fill(raw);
      const buf = ctx.createBuffer(1, n, rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = raw[i];
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI / 2;
        d[i] = raw[i] * Math.sin(a) + raw[n + i] * Math.cos(a);
      }
      return buf;
    };
    const white = make((r) => { for (let i = 0; i < r.length; i++) r[i] = Math.random() * 2 - 1; });
    const brown = make((r) => {
      let last = 0;
      for (let i = 0; i < r.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        r[i] = last * 3.5;
      }
    });
    const pink = make((r) => {
      let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
      for (let i = 0; i < r.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        r[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    });
    this.buffers = { white, brown, pink };
    return this.buffers;
  }

  /** Включает вариант (если он уже играет, ничего не делает). */
  play(variant, buffer = null) {
    const ctx = this._ctx();
    if (!ctx) return;
    if (this.current && this.current.variant === variant && this.current.buffer === buffer) return;
    this.stop();

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, ctx.currentTime);
    out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.2);
    out.connect(this.bus);
    const stops = [];
    const timers = [];
    const env = { ctx, out, stops, timers, buffers: this._makeBuffers(ctx) };

    if (buffer) this._custom(env, buffer);
    else if (variant === 'fire') this._fire(env);
    else if (variant === 'wind') this._wind(env);
    else if (variant === 'sea') this._sea(env);
    else if (variant === 'hum') this._hum(env);
    else this._rain(env);

    this.current = { variant, buffer, out, stops, timers };
  }

  stop() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.timers.forEach((t) => clearTimeout(t));
    cur.timers.length = 0;
    const ctx = cur.out.context;
    cur.out.gain.cancelScheduledValues(ctx.currentTime);
    cur.out.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    setTimeout(() => {
      cur.stops.forEach((fn) => { try { fn(); } catch { /* уже остановлено */ } });
      cur.out.disconnect();
    }, 1200);
  }

  // ---------- строительные блоки ----------

  _loop(env, name, filters, gainValue) {
    const { ctx, out, stops, buffers } = env;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.loop = true;
    let node = src;
    for (const f of filters) {
      const b = ctx.createBiquadFilter();
      b.type = f.type;
      b.frequency.value = f.freq;
      if (f.q) b.Q.value = f.q;
      node.connect(b);
      node = b;
    }
    const g = ctx.createGain();
    g.gain.value = gainValue;
    node.connect(g);
    g.connect(out);
    src.start(0, Math.random() * SECONDS);
    stops.push(() => src.stop());
    return { gain: g, filter: node };
  }

  _lfo(env, freq, depth, param) {
    const { ctx, stops } = env;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(param);
    osc.start();
    stops.push(() => osc.stop());
  }

  // Короткий шумовой импульс (капля, треск).
  _pop(env, { type, freq, q, gain, dur }) {
    const { ctx, out, buffers } = env;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = buffers.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, Math.random() * (SECONDS - 1), dur + 0.02);
  }

  // Повторяет fn через случайные промежутки, пока вариант играет.
  _every(env, fn, minMs, spanMs) {
    const idx = env.timers.length;
    env.timers.push(0);
    const loop = () => {
      fn();
      env.timers[idx] = setTimeout(loop, minMs + Math.random() * spanMs);
    };
    env.timers[idx] = setTimeout(loop, minMs + Math.random() * spanMs);
  }

  // ---------- варианты ----------

  _rain(env) {
    // тихий общий фон + много отдельных капель разной величины (так дождь меньше похож на шум)
    this._loop(env, 'white', [{ type: 'highpass', freq: 1800 }, { type: 'lowpass', freq: 6500 }], 0.07);
    this._loop(env, 'brown', [{ type: 'lowpass', freq: 380 }], 0.16);
    this._loop(env, 'pink', [{ type: 'bandpass', freq: 1100, q: 0.9 }], 0.06);
    this._every(env, () => { // мелкие капли
      this._pop(env, {
        type: 'bandpass', freq: 2200 + Math.random() * 4200, q: 3, gain: 0.05 + Math.random() * 0.1, dur: 0.008 + Math.random() * 0.01,
      });
    }, 8, 38);
    this._every(env, () => { // редкие крупные капли по подоконнику
      this._pop(env, {
        type: 'bandpass', freq: 700 + Math.random() * 900, q: 4, gain: 0.12 + Math.random() * 0.14, dur: 0.03 + Math.random() * 0.03,
      });
    }, 180, 700);
  }

  _fire(env) {
    this._loop(env, 'brown', [{ type: 'lowpass', freq: 260 }], 0.5);
    this._loop(env, 'pink', [{ type: 'bandpass', freq: 650, q: 0.6 }], 0.05);
    this._every(env, () => {
      const pops = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 3) : 1;
      for (let i = 0; i < pops; i++) {
        setTimeout(() => {
          if (!this.current) return;
          this._pop(env, {
            type: Math.random() < 0.5 ? 'highpass' : 'bandpass',
            freq: 1400 + Math.random() * 2200,
            q: 0.8,
            gain: 0.08 + Math.random() * 0.28,
            dur: 0.005 + Math.random() * 0.018,
          });
        }, i * (12 + Math.random() * 30));
      }
    }, 70, 600);
  }

  _wind(env) {
    const a = this._loop(env, 'pink', [{ type: 'bandpass', freq: 520, q: 0.8 }], 0.35);
    this._lfo(env, 0.11, 260, a.filter.frequency);
    this._lfo(env, 0.07, 0.15, a.gain.gain);
  }

  _sea(env) {
    const low = this._loop(env, 'brown', [{ type: 'lowpass', freq: 700 }], 0.28);
    this._lfo(env, 0.09, 0.2, low.gain.gain);
    const hiss = this._loop(env, 'pink', [{ type: 'bandpass', freq: 2400, q: 0.5 }], 0.05);
    this._lfo(env, 0.09, 0.035, hiss.gain.gain);
  }

  _hum(env) {
    this._loop(env, 'brown', [{ type: 'lowpass', freq: 160 }], 0.5);
    this._loop(env, 'pink', [{ type: 'lowpass', freq: 1200 }], 0.02);
  }

  _custom(env, buffer) {
    const { ctx, out, stops } = env;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g);
    g.connect(out);
    src.start();
    stops.push(() => src.stop());
  }
}
