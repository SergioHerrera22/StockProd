"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
/* eslint-disable no-console */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 20;
function stamp() {
    return new Date().toISOString();
}
exports.logger = {
    debug(...args) {
        if (current <= LEVELS.debug)
            console.log(`[${stamp()}] [DEBUG]`, ...args);
    },
    info(...args) {
        if (current <= LEVELS.info)
            console.log(`[${stamp()}] [INFO]`, ...args);
    },
    warn(...args) {
        if (current <= LEVELS.warn)
            console.warn(`[${stamp()}] [WARN]`, ...args);
    },
    error(...args) {
        if (current <= LEVELS.error)
            console.error(`[${stamp()}] [ERROR]`, ...args);
    },
};
