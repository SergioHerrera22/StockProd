"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cached = cached;
exports.cacheInvalidate = cacheInvalidate;
const store = new Map();
function cacheGet(key) {
    const e = store.get(key);
    if (!e)
        return undefined;
    if (Date.now() >= e.expiresAt) {
        store.delete(key);
        return undefined;
    }
    return e.value;
}
function cacheSet(key, value, ttlMs) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
/** Ejecuta fn devolviendo el valor cacheado si existe y no expiró (TTL por key). */
async function cached(key, ttlMs, fn) {
    const hit = cacheGet(key);
    if (hit !== undefined)
        return hit;
    const value = await fn();
    cacheSet(key, value, ttlMs);
    return value;
}
/** Invalida por prefijo (ej. 'confirm-setting:' → borra todas las variantes). */
function cacheInvalidate(prefix) {
    for (const k of store.keys()) {
        if (k.startsWith(prefix))
            store.delete(k);
    }
}
