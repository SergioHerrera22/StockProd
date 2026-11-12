"use strict";
// Matriz de permisos por rol. El frontend usa una copia identica para la UX,
// pero SIEMPRE se valida en el backend.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERMISSIONS = void 0;
exports.hasPermission = hasPermission;
const ENCARGADO = [
    'products.read', 'products.write', 'categories.write', 'suppliers.manage',
    'stock.read', 'stock.adjust', 'merchandise_requests.use',
    'deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void', 'deliveries.approve',
    'entries.read', 'entries.write', 'entries.confirm', 'entries.void', 'entries.approve',
    'transfers.read', 'transfers.write', 'transfers.receive', 'transfers.dispatch', 'transfers.verify', 'transfers.void', 'transfers.approve',
    'counts.read', 'counts.write', 'counts.apply', 'counts.void', 'counts.approve',
    'movements.read', 'dashboard.read', 'reports.read',
    'locations.read',
    'tracking.read', 'tracking.write', 'tracking.gps',
    'approvals.read', 'approvals.approve',
    'alerts.read', 'alerts.manage',
];
const EMPLEADO = [
    'products.read',
    'stock.read',
    'merchandise_requests.use',
    'deliveries.read', 'deliveries.write', 'deliveries.confirm',
    'movements.read', 'dashboard.read',
    'locations.read',
    'tracking.read', 'tracking.gps',
    'approvals.read',
    'alerts.read',
];
exports.PERMISSIONS = {
    ADMIN: [
        ...ENCARGADO, 'merchandise_requests.use', 'merchandise_requests.manage',
        'locations.manage', 'users.manage', 'users.read', 'audit.read', 'settings.write',
    ],
    ENCARGADO,
    EMPLEADO,
    // Chofer de transporte: ve sus viajes y opera el GPS (compartir ubicación,
    // salió, parada entregada). NO arma Ni edita viajes (tracking.write).
    TRANSPORTE: ['locations.read', 'tracking.read', 'tracking.gps', 'deliveries.read', 'stock.read'],
};
function hasPermission(role, permission, custom) {
    if (custom !== undefined && custom !== null)
        return custom.includes(permission);
    return exports.PERMISSIONS[role]?.includes(permission) ?? false;
}
