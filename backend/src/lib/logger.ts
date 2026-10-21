/* eslint-disable no-console */
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 20;

function stamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(...args: unknown[]) {
    if (current <= LEVELS.debug) console.log(`[${stamp()}] [DEBUG]`, ...args);
  },
  info(...args: unknown[]) {
    if (current <= LEVELS.info) console.log(`[${stamp()}] [INFO]`, ...args);
  },
  warn(...args: unknown[]) {
    if (current <= LEVELS.warn) console.warn(`[${stamp()}] [WARN]`, ...args);
  },
  error(...args: unknown[]) {
    if (current <= LEVELS.error) console.error(`[${stamp()}] [ERROR]`, ...args);
  },
};
