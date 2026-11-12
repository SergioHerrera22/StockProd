"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STANDARD_PERMISSIONS = void 0;
exports.grantLocationPermission = grantLocationPermission;
exports.revokeLocationPermission = revokeLocationPermission;
exports.listUserPermissions = listUserPermissions;
exports.listLocationPermissions = listLocationPermissions;
exports.hasEffectivePermission = hasEffectivePermission;
exports.getEffectivePermissions = getEffectivePermissions;
exports.requireLocationPerm = requireLocationPerm;
const pool_1 = require("../db/pool");
const errors_1 = require("../lib/errors");
const audit_service_1 = require("./audit.service");
/**
 * Otorgar permiso por ubicacion
 */
async function grantLocationPermission(user, ip, input) {
    // Validar que el otorgante tenga permiso para gestionar permisos en esa ubicacion
    const canManage = await hasEffectivePermission(user.id, 'users.manage', input.locationId);
    if (!canManage && user.role !== 'ADMIN') {
        throw errors_1.ApiError.forbidden('No tienes permiso para gestionar permisos en esta ubicación');
    }
    return (0, pool_1.withTx)(async (c) => {
        // Verificar que usuario y ubicacion existan y esten activos
        const [u, l] = await Promise.all([
            c.query('SELECT id FROM users WHERE id = $1 AND is_active = true', [input.userId]),
            c.query('SELECT id FROM locations WHERE id = $1 AND is_active = true', [input.locationId]),
        ]);
        if (!u.rows[0])
            throw errors_1.ApiError.notFound('Usuario no encontrado o inactivo');
        if (!l.rows[0])
            throw errors_1.ApiError.notFound('Ubicación no encontrada o inactiva');
        // Validar scope OWN_LOCATION: la ubicacion debe coincidir con default_location_id del usuario
        if (input.scope === 'OWN_LOCATION') {
            const ud = await c.query('SELECT default_location_id FROM users WHERE id = $1', [input.userId]);
            if (ud.rows[0]?.default_location_id !== input.locationId) {
                throw errors_1.ApiError.badRequest('Para scope OWN_LOCATION, la ubicación debe ser la ubicación por defecto del usuario');
            }
        }
        await c.query(`INSERT INTO user_location_permissions (user_id, location_id, permission, scope, granted_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, location_id, permission) DO UPDATE SET
         scope = EXCLUDED.scope,
         granted_by = EXCLUDED.granted_by,
         granted_at = now(),
         expires_at = EXCLUDED.expires_at`, [input.userId, input.locationId, input.permission, input.scope, user.id, input.expiresAt ?? null]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'LOCATION_PERMISSION_GRANT', entity: 'user_location_permission', details: input, ip });
        return { ok: true };
    });
}
/**
 * Revocar permiso por ubicacion
 */
async function revokeLocationPermission(user, ip, userId, locationId, permission) {
    const canManage = await hasEffectivePermission(user.id, 'users.manage', locationId);
    if (!canManage && user.role !== 'ADMIN') {
        throw errors_1.ApiError.forbidden('No tienes permiso para gestionar permisos en esta ubicación');
    }
    return (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`DELETE FROM user_location_permissions WHERE user_id = $1 AND location_id = $2 AND permission = $3`, [userId, locationId, permission]);
        if (!r.rowCount)
            throw errors_1.ApiError.notFound('Permiso no encontrado');
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'LOCATION_PERMISSION_REVOKE', entity: 'user_location_permission', details: { userId, locationId, permission }, ip });
        return { ok: true };
    });
}
/**
 * Listar permisos de un usuario
 */
async function listUserPermissions(userId) {
    const r = await (0, pool_1.query)(`SELECT ulp.*, l.code AS location_code, l.name AS location_name, gu.full_name AS granted_by_name
     FROM user_location_permissions ulp
     JOIN locations l ON l.id = ulp.location_id
     JOIN users gu ON gu.id = ulp.granted_by
     WHERE ulp.user_id = $1 AND (ulp.expires_at IS NULL OR ulp.expires_at > now())
     ORDER BY l.code, ulp.permission`, [userId]);
    return r.rows.map(mapPerm);
}
/**
 * Listar usuarios con permisos en una ubicacion
 */
async function listLocationPermissions(locationId) {
    const r = await (0, pool_1.query)(`SELECT ulp.*, u.username, u.full_name, u.role_code, u.default_location_id, gu.full_name AS granted_by_name
     FROM user_location_permissions ulp
     JOIN users u ON u.id = ulp.user_id
     JOIN users gu ON gu.id = ulp.granted_by
     WHERE ulp.location_id = $1 AND (ulp.expires_at IS NULL OR ulp.expires_at > now()) AND u.is_active = true
     ORDER BY u.full_name, ulp.permission`, [locationId]);
    return r.rows.map(mapPerm);
}
function mapPerm(r) {
    return {
        userId: r.user_id,
        locationId: r.location_id,
        permission: r.permission,
        scope: r.scope,
        grantedBy: r.granted_by,
        grantedAt: r.granted_at,
        expiresAt: r.expires_at,
        locationCode: r.location_code,
        locationName: r.location_name,
        grantedByName: r.granted_by_name,
        username: r.username,
        fullName: r.full_name,
        roleCode: r.role_code,
        defaultLocationId: r.default_location_id,
    };
}
/**
 * Verificar permiso efectivo (usa funcion BD has_effective_permission)
 */
async function hasEffectivePermission(userId, permission, locationId) {
    const r = await (0, pool_1.query)(`SELECT has_effective_permission($1, $2, $3) AS has`, [userId, permission, locationId ?? null]);
    return r.rows[0]?.has ?? false;
}
/**
 * Obtener todos los permisos efectivos de un usuario (para frontend)
 */
async function getEffectivePermissions(userId) {
    const r = await (0, pool_1.query)(`SELECT * FROM v_user_effective_permissions WHERE user_id = $1 AND is_effective = true`, [userId]);
    return r.rows;
}
/**
 * Middleware helper: verificar permiso en ruta (location_id opcional, se infiere de params)
 */
function requireLocationPerm(permission, getLocationId) {
    return async (req, res, next) => {
        const userId = req.user?.id;
        const locationId = getLocationId(req);
        const hasPerm = await hasEffectivePermission(userId, permission, locationId);
        if (!hasPerm) {
            return res.status(403).json({ error: `Permiso denegado: ${permission}${locationId ? ` en ubicación ${locationId}` : ''}` });
        }
        next();
    };
}
/**
 * Permisos estándar del sistema (para poblar UI)
 */
exports.STANDARD_PERMISSIONS = [
    // Products
    { permission: 'products.read', label: 'Ver productos', category: 'Productos' },
    { permission: 'products.write', label: 'Crear/editar productos', category: 'Productos' },
    { permission: 'categories.write', label: 'Gestionar categorías', category: 'Productos' },
    { permission: 'products.import', label: 'Importar productos', category: 'Productos' },
    // Stock
    { permission: 'stock.read', label: 'Ver stock', category: 'Stock' },
    { permission: 'stock.adjust', label: 'Ajustar stock manual', category: 'Stock' },
    // Deliveries
    { permission: 'deliveries.read', label: 'Ver entregas', category: 'Entregas' },
    { permission: 'deliveries.write', label: 'Crear/modificar entregas', category: 'Entregas' },
    { permission: 'deliveries.confirm', label: 'Confirmar entregas', category: 'Entregas' },
    { permission: 'deliveries.void', label: 'Anular entregas', category: 'Entregas' },
    { permission: 'deliveries.approve', label: 'Aprobar entregas', category: 'Entregas' },
    // Entries
    { permission: 'entries.read', label: 'Ver entradas', category: 'Entradas' },
    { permission: 'entries.write', label: 'Crear/modificar entradas', category: 'Entradas' },
    { permission: 'entries.confirm', label: 'Confirmar entradas', category: 'Entradas' },
    { permission: 'entries.void', label: 'Anular entradas', category: 'Entradas' },
    { permission: 'entries.approve', label: 'Aprobar entradas', category: 'Entradas' },
    // Transfers
    { permission: 'transfers.read', label: 'Ver transferencias', category: 'Transferencias' },
    { permission: 'transfers.write', label: 'Crear transferencias', category: 'Transferencias' },
    { permission: 'transfers.dispatch', label: 'Despachar transferencias', category: 'Transferencias' },
    { permission: 'transfers.receive', label: 'Recibir transferencias', category: 'Transferencias' },
    { permission: 'transfers.verify', label: 'Verificar recepción (2da persona)', category: 'Transferencias' },
    { permission: 'transfers.void', label: 'Anular transferencias', category: 'Transferencias' },
    { permission: 'transfers.approve', label: 'Aprobar transferencias', category: 'Transferencias' },
    // Counts
    { permission: 'counts.read', label: 'Ver inventarios', category: 'Inventarios' },
    { permission: 'counts.write', label: 'Crear/modificar inventarios', category: 'Inventarios' },
    { permission: 'counts.apply', label: 'Aplicar inventarios', category: 'Inventarios' },
    { permission: 'counts.approve', label: 'Aprobar inventarios', category: 'Inventarios' },
    // Movements
    { permission: 'movements.read', label: 'Ver movimientos', category: 'Movimientos' },
    // Dashboard/Reports
    { permission: 'dashboard.read', label: 'Ver dashboard', category: 'Reportes' },
    { permission: 'reports.read', label: 'Ver reportes', category: 'Reportes' },
    // Locations
    { permission: 'locations.read', label: 'Ver ubicaciones', category: 'Ubicaciones' },
    { permission: 'locations.manage', label: 'Gestionar ubicaciones', category: 'Ubicaciones' },
    // Users
    { permission: 'users.read', label: 'Ver usuarios', category: 'Usuarios' },
    { permission: 'users.manage', label: 'Gestionar usuarios y permisos', category: 'Usuarios' },
    // Audit
    { permission: 'audit.read', label: 'Ver auditoría', category: 'Auditoría' },
    // Approvals
    { permission: 'approvals.read', label: 'Ver solicitudes de aprobación', category: 'Aprobaciones' },
    { permission: 'approvals.approve', label: 'Aprobar/rechazar solicitudes', category: 'Aprobaciones' },
    // Alerts
    { permission: 'alerts.read', label: 'Ver alertas', category: 'Alertas' },
    { permission: 'alerts.manage', label: 'Gestionar alertas', category: 'Alertas' },
];
