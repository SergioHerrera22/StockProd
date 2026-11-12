"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
exports.asyncH = asyncH;
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const logger_1 = require("../lib/logger");
const env_1 = require("../config/env");
function errorHandler(err, req, res, _next) {
    if (err instanceof errors_1.ApiError) {
        return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err instanceof zod_1.ZodError) {
        const details = err.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
        }));
        return res.status(400).json({ error: 'Datos invalidos', details });
    }
    const anyErr = err;
    // Un cuerpo demasiado grande es un error del cliente, no un fallo interno.
    if (anyErr?.type === 'entity.too.large' || anyErr?.status === 413 || anyErr?.statusCode === 413) {
        return res.status(413).json({ error: 'El archivo o lote es demasiado grande. Dividí la carga e intentá nuevamente.' });
    }
    // Violaciones de unicidad / FK / CHECK / NOT NULL de PostgreSQL.
    // Se incluye el detalle del motor (constraint, columna) para poder diagnosticar
    // el origen real del problema desde el mensaje que ve el usuario.
    if (anyErr?.code === '23505') {
        return res.status(409).json({
            error: anyErr.constraint ? `Registro duplicado (${anyErr.constraint})` : 'Registro duplicado',
            details: anyErr.detail,
        });
    }
    if (anyErr?.code === '23503') {
        return res.status(409).json({ error: 'Referencia invalida: el registro relacionado no existe', details: anyErr.detail });
    }
    if (anyErr?.code === '23514') {
        return res.status(400).json({
            error: anyErr.constraint
                ? `Los datos violan una restriccion de integridad (${anyErr.constraint})`
                : 'Los datos violan una restriccion de integridad',
            details: anyErr.detail,
        });
    }
    if (anyErr?.code === '23P01') {
        return res.status(409).json({ error: 'Operacion excluyente: el registro ya fue procesado' });
    }
    if (anyErr?.code === '23502') {
        const campo = anyErr.column ? ` de "${anyErr.column}"` : '';
        const tabla = anyErr.table ? ` en "${anyErr.table}"` : '';
        return res.status(400).json({
            error: `Falta un dato obligatorio${campo}${tabla}`,
            details: anyErr.detail,
            column: anyErr.column,
            table: anyErr.table,
        });
    }
    const dbg = [
        anyErr?.code ? `code=${anyErr.code}` : null,
        anyErr?.constraint ? `constraint=${anyErr.constraint}` : null,
        anyErr?.table ? `table=${anyErr.table}` : null,
        anyErr?.column ? `column=${anyErr.column}` : null,
        anyErr?.detail ? `detail=${anyErr.detail}` : null,
    ].filter(Boolean).join(' ');
    logger_1.logger.error(`Error no manejado en ${req.method} ${req.originalUrl}: ${anyErr?.message ?? err}` +
        (dbg ? ` [${dbg}]` : ''), err instanceof Error ? err.stack : undefined);
    return res.status(500).json({
        error: 'Error interno del servidor',
        ...(env_1.config.isProd ? {} : { detail: anyErr?.message }),
    });
}
/** Envuelve handlers async para que los errores lleguen al errorHandler. */
function asyncH(fn) {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
}
