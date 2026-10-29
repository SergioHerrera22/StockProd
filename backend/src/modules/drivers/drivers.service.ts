import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { AuthUser } from '../../middleware/auth';
import { writeAudit } from '../../services/audit.service';

export async function listDrivers() {
  const r = await query(
    `SELECT u.id, u.username, u.full_name, u.role_code, u.default_location_id, l.name as location_name, u.is_active
     FROM users u
     LEFT JOIN locations l ON l.id = u.default_location_id
     WHERE u.role_code IN ('TRANSPORTE', 'ADMIN', 'ENCARGADO')
       AND u.is_active = true
     ORDER BY u.full_name`
  );
  return r.rows;
}

export async function getMyAssignments(user: AuthUser) {
  const r = await query(
    `SELECT 
       d.id as delivery_id,
       d.number as reference,
       'DELIVERY' as type,
       d.status,
       d.delivery_type,
       d.customer_name,
       d.customer_phone,
       d.delivery_address,
       d.delivery_lat,
       d.delivery_lng,
       d.location_id,
       l.name as location_name,
       d.notes,
       d.delivery_observations,
       d.due_at,
       d.driver_assigned_at,
       d.delivery_started_at,
       d.delivered_at,
       d.created_at
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     WHERE d.driver_user_id = $1
       AND d.status IN ('CONFIRMADO', 'PARCIAL')
       AND d.delivered_at IS NULL
     UNION ALL
     SELECT 
       t.id as delivery_id,
       t.number as reference,
       'TRANSFER' as type,
       t.status,
       'TRANSFER' as delivery_type,
       NULL as customer_name,
       NULL as customer_phone,
       t.delivery_address,
       t.delivery_lat,
       t.delivery_lng,
       t.destination_location_id as location_id,
       ld.name as location_name,
       t.notes,
       t.delivery_observations,
       t.due_at,
       t.driver_assigned_at,
       t.delivery_started_at,
       t.delivered_at,
       t.created_at
     FROM transfers t
     JOIN locations ld ON ld.id = t.destination_location_id
     WHERE t.driver_user_id = $1
       AND t.status = 'EN_TRANSITO'
       AND t.delivered_at IS NULL
     ORDER BY created_at ASC`,
    [user.id]
  );
  return r.rows;
}

export async function getMyHistory(user: AuthUser) {
  const r = await query(
    `SELECT 
       d.id as delivery_id,
       d.number as reference,
       'DELIVERY' as type,
       d.status,
       d.customer_name,
       d.delivery_address,
       d.delivery_lat,
       d.delivery_lng,
       d.delivered_at,
       d.delivery_started_at,
       d.driver_assigned_at,
       d.created_at
     FROM deliveries d
     WHERE d.driver_user_id = $1
       AND d.delivered_at IS NOT NULL
     UNION ALL
     SELECT 
       t.id as delivery_id,
       t.number as reference,
       'TRANSFER' as type,
       t.status,
       NULL as customer_name,
       t.delivery_address,
       t.delivery_lat,
       t.delivery_lng,
       t.delivered_at,
       t.delivery_started_at,
       t.driver_assigned_at,
       t.created_at
     FROM transfers t
     WHERE t.driver_user_id = $1
       AND t.delivered_at IS NOT NULL
     ORDER BY delivered_at DESC`,
    [user.id]
  );
  return r.rows;
}

export async function startDelivery(user: AuthUser, ip: string | undefined, type: 'DELIVERY' | 'TRANSFER', id: number) {
  return withTx(async (c) => {
    if (type === 'DELIVERY') {
      const d = await c.query('SELECT id, driver_user_id, delivery_started_at FROM deliveries WHERE id = $1 FOR UPDATE', [id]);
      if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
      if (d.rows[0].driver_user_id !== user.id && user.role !== 'ADMIN') throw ApiError.forbidden('No autorizado');
      if (!d.rows[0].delivery_started_at) {
        await c.query('UPDATE deliveries SET delivery_started_at = now() WHERE id = $1', [id]);
      }
      await writeAudit(c, { userId: user.id, action: 'DRIVER_START_DELIVERY', entity: 'delivery', entityId: id, ip });
      return { ok: true };
    } else {
      const t = await c.query('SELECT id, driver_user_id, delivery_started_at FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!t.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
      if (t.rows[0].driver_user_id !== user.id && user.role !== 'ADMIN') throw ApiError.forbidden('No autorizado');
      if (!t.rows[0].delivery_started_at) {
        await c.query('UPDATE transfers SET delivery_started_at = now() WHERE id = $1', [id]);
      }
      await writeAudit(c, { userId: user.id, action: 'DRIVER_START_TRANSFER', entity: 'transfer', entityId: id, ip });
      return { ok: true };
    }
  });
}

export async function completeDelivery(user: AuthUser, ip: string | undefined, type: 'DELIVERY' | 'TRANSFER', id: number, notes?: string) {
  return withTx(async (c) => {
    if (type === 'DELIVERY') {
      const d = await c.query('SELECT id, driver_user_id, delivered_at FROM deliveries WHERE id = $1 FOR UPDATE', [id]);
      if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
      if (d.rows[0].driver_user_id !== user.id && user.role !== 'ADMIN') throw ApiError.forbidden('No autorizado');
      if (d.rows[0].delivered_at) throw ApiError.conflict('Ya fue entregado');
      await c.query('UPDATE deliveries SET delivered_at = now(), delivery_notes = COALESCE($2, delivery_notes) WHERE id = $1', [id, notes?.trim() || null]);
      await writeAudit(c, { userId: user.id, action: 'DRIVER_COMPLETE_DELIVERY', entity: 'delivery', entityId: id, ip });
      return { ok: true };
    } else {
      const t = await c.query('SELECT id, driver_user_id, delivered_at FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!t.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
      if (t.rows[0].driver_user_id !== user.id && user.role !== 'ADMIN') throw ApiError.forbidden('No autorizado');
      if (t.rows[0].delivered_at) throw ApiError.conflict('Ya fue entregado');
      await c.query('UPDATE transfers SET delivered_at = now(), delivery_notes = COALESCE($2, delivery_notes) WHERE id = $1', [id, notes?.trim() || null]);
      await writeAudit(c, { userId: user.id, action: 'DRIVER_COMPLETE_TRANSFER', entity: 'transfer', entityId: id, ip });
      return { ok: true };
    }
  });
}

export async function assignDriver(user: AuthUser, ip: string | undefined, type: 'DELIVERY' | 'TRANSFER', id: number, driverUserId: number) {
  return withTx(async (c) => {
    if (type === 'DELIVERY') {
      const d = await c.query('SELECT id, number FROM deliveries WHERE id = $1 FOR UPDATE', [id]);
      if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
      await c.query(
        `UPDATE deliveries SET driver_user_id = $1, driver_assigned_at = COALESCE(driver_assigned_at, now()) WHERE id = $2`,
        [driverUserId, id]
      );
      await writeAudit(c, { userId: user.id, action: 'DELIVERY_ASSIGN_DRIVER', entity: 'delivery', entityId: id, details: { driverUserId }, ip });
      return { ok: true };
    } else {
      const t = await c.query('SELECT id, number FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!t.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
      await c.query(
        `UPDATE transfers SET driver_user_id = $1, driver_assigned_at = COALESCE(driver_assigned_at, now()) WHERE id = $2`,
        [driverUserId, id]
      );
      await writeAudit(c, { userId: user.id, action: 'TRANSFER_ASSIGN_DRIVER', entity: 'transfer', entityId: id, details: { driverUserId }, ip });
      return { ok: true };
    }
  });
}

export async function getAdminDelays() {
  const r = await query(
    `SELECT 
       d.id, d.number, 'DELIVERY' as type, d.status, d.created_at, d.confirmed_at, d.due_at,
       d.delivery_started_at, d.delivered_at, d.driver_user_id, du.full_name as driver_name,
       d.delivery_address, d.location_id, l.name as location_name,
       CASE WHEN d.delivered_at IS NOT NULL AND d.due_at IS NOT NULL AND d.delivered_at > d.due_at THEN EXTRACT(EPOCH FROM (d.delivered_at - d.due_at))/3600 ELSE 0 END as delay_hours,
       CASE WHEN d.delivered_at IS NULL AND d.due_at IS NOT NULL AND now() > d.due_at THEN EXTRACT(EPOCH FROM (now() - d.due_at))/3600 ELSE 0 END as current_delay_hours
     FROM deliveries d
     LEFT JOIN users du ON du.id = d.driver_user_id
     LEFT JOIN locations l ON l.id = d.location_id
     WHERE (d.delivery_type = 'DOMICILIO' OR d.driver_user_id IS NOT NULL)
       AND d.status IN ('CONFIRMADO','PARCIAL')
     ORDER BY COALESCE(d.due_at, d.created_at) ASC
     LIMIT 200`
  );
  const t = await query(
    `SELECT 
       t.id, t.number, 'TRANSFER' as type, t.status, t.created_at, t.sent_at, t.due_at,
       t.delivery_started_at, t.delivered_at, t.driver_user_id, du.full_name as driver_name,
       t.delivery_address, t.destination_location_id as location_id, ld.name as location_name,
       CASE WHEN t.delivered_at IS NOT NULL AND t.due_at IS NOT NULL AND t.delivered_at > t.due_at THEN EXTRACT(EPOCH FROM (t.delivered_at - t.due_at))/3600 ELSE 0 END as delay_hours,
       CASE WHEN t.delivered_at IS NULL AND t.due_at IS NOT NULL AND now() > t.due_at THEN EXTRACT(EPOCH FROM (now() - t.due_at))/3600 ELSE 0 END as current_delay_hours
     FROM transfers t
     LEFT JOIN users du ON du.id = t.driver_user_id
     LEFT JOIN locations ld ON ld.id = t.destination_location_id
     WHERE t.driver_user_id IS NOT NULL
       AND t.status IN ('EN_TRANSITO')
     ORDER BY COALESCE(t.due_at, t.created_at) ASC
     LIMIT 200`
  );
  return { deliveries: r.rows, transfers: t.rows };
}

export async function geocodeAddress(address: string) {
  // Simple stub for geocoding - in production would call Google Maps API
  // For now return null coords if not provided
  return { address, lat: null, lng: null, formatted: address };
}
