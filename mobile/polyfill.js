import { Buffer } from 'buffer';

// Код из src/ рассчитан на Node: нужен глобальный Buffer.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = { platform: 'android', pid: 1, env: {}, versions: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
