"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertLocationAccess = assertLocationAccess;
exports.assertTransferAccess = assertTransferAccess;
const errors_1 = require("../lib/errors");
/**
 * Control de acceso por ubicación.
 * Si el usuario tiene "restringir a su ubicación" activado, solo puede operar
 * (entregas, entradas, transferencias, inventarios) en su ubicación habitual.
 * La consulta (lectura de stock, productos, movimientos) sigue siendo global.
 */
function assertLocationAccess(user, locationId) {
    if (user.role === 'ADMIN' || !user.restrictToLocation)
        return;
    if (!user.locationId) {
        throw errors_1.ApiError.forbidden('Tu usuario está restringido a una ubicación pero no tiene ninguna asignada. Avisá al administrador.');
    }
    if (Number(locationId) !== Number(user.locationId)) {
        throw errors_1.ApiError.forbidden(`Tu usuario solo puede operar en su ubicación habitual. Esta operación corresponde a otra ubicación.`);
    }
}
/** Transferencias: la operación debe involucrar la ubicación del usuario (origen o destino). */
function assertTransferAccess(user, originLocationId, destinationLocationId) {
    if (user.role === 'ADMIN' || !user.restrictToLocation)
        return;
    if (!user.locationId) {
        throw errors_1.ApiError.forbidden('Tu usuario está restringido a una ubicación pero no tiene ninguna asignada. Avisá al administrador.');
    }
    const loc = Number(user.locationId);
    if (Number(originLocationId) !== loc && Number(destinationLocationId) !== loc) {
        throw errors_1.ApiError.forbidden('Solo podés operar transferencias que involucren tu ubicación.');
    }
}
