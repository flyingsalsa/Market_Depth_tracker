type Level = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (levelRank[level] < levelRank[minLevel]) return;
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    console.log(head, JSON.stringify(fields));
  } else {
    console.log(head);
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info:  (m: string, f?: Record<string, unknown>) => emit('info',  m, f),
  warn:  (m: string, f?: Record<string, unknown>) => emit('warn',  m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
