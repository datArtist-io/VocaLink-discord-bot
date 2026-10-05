/** Tiny structured JSON logger (one line per event). */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? 'info'] ?? 20;

export function setLogLevel(level: string): void {
  threshold = ORDER[level.toLowerCase() as Level] ?? 20;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function errToJson(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 4).join(' | ') };
  return v;
}

export function createLogger(scope = 'edge'): Logger {
  const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const rec: Record<string, unknown> = { t: new Date().toISOString(), level, scope, msg };
    if (data) for (const [k, v] of Object.entries(data)) rec[k] = errToJson(v);
    const line = JSON.stringify(rec);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (s: string) => createLogger(`${scope}.${s}`),
  };
}

export const log = createLogger();
