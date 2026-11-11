"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pageParams = pageParams;
exports.intParam = intParam;
exports.pathId = pathId;
exports.strParam = strParam;
const errors_1 = require("./errors");
const MAX_PAGE_SIZE = 200;
function pageParams(req, defaultSize = 20) {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(String(req.query.pageSize ?? String(defaultSize)), 10) || defaultSize));
    return { page, pageSize, offset: (page - 1) * pageSize };
}
function intParam(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    const n = parseInt(String(value), 10);
    return Number.isFinite(n) ? n : undefined;
}
/**
 * ID de recurso tomado de la ruta (/transfers/:id).
 * Si no es un entero positivo lanza 404: sin esto, valores como "undefined"
 * llegaban a PostgreSQL como NaN y devolvian un error 500 crudo.
 */
function pathId(value) {
    const n = parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(n) || n <= 0)
        throw errors_1.ApiError.notFound('Recurso no encontrado');
    return n;
}
function strParam(value) {
    if (value === undefined || value === null)
        return undefined;
    const s = String(value).trim();
    return s === '' ? undefined : s;
}
