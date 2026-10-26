import { Router } from 'express';
import { query } from '../../db/pool';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam } from '../../lib/pagination';

const router = Router();
router.use(authRequired, requirePerm('movements.read'));

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 30);
    const params: unknown[] = [];
    const where: string[] = [];

    const productId = intParam(req.query.productId);
    const locationId = intParam(req.query.locationId);
    const userId = intParam(req.query.userId);
    const type = strParam(req.query.type);
    const referenceType = strParam(req.query.referenceType);
    const from = strParam(req.query.from);
    const to = strParam(req.query.to);
    const q = strParam(req.query.q);

    if (productId) { params.push(productId); where.push(`m.product_id = $${params.length}`); }
    if (locationId) { params.push(locationId); where.push(`m.location_id = $${params.length}`); }
    if (userId) { params.push(userId); where.push(`m.user_id = $${params.length}`); }
    if (type) { params.push(type); where.push(`m.type = $${params.length}::movement_type`); }
    if (referenceType) { params.push(referenceType); where.push(`m.reference_type = $${params.length}::reference_type`); }
    if (from) { params.push(from); where.push(`m.created_at >= $${params.length}::timestamptz`); }
    if (to) { params.push(`${to} 23:59:59.999`); where.push(`m.created_at <= $${params.length}::timestamptz`); }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR m.reference_number ILIKE $${n} OR m.reason ILIKE $${n})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await query<{ total: string }>(
      `SELECT COUNT(*) total FROM stock_movements m
       JOIN products p ON p.id = m.product_id ${whereSql}`,
      params
    );
    const rows = await query(
      `SELECT m.id, m.type, m.quantity, m.balance_before, m.balance_after,
              m.reference_type, m.reference_id, m.reference_number, m.reason, m.notes, m.created_at,
              p.id AS product_id, p.code AS product_code, p.name AS product_name, p.unit,
              l.name AS location_name, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN locations l ON l.id = m.location_id
       JOIN users u ON u.id = m.user_id
       ${whereSql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      movements: rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        quantity: Number(r.quantity),
        balance_before: Number(r.balance_before),
        balance_after: Number(r.balance_after),
      })),
      total: Number(count.rows[0].total),
      page, pageSize,
    });
  })
);

router.get(
  '/export.csv',
  asyncH(async (req, res) => {
    // Libro de movimientos con los MISMOS filtros de la pantalla (mejora 11).
    // Cap de seguridad: 10000 filas por export (usá filtros de fecha para más).
    const params: unknown[] = [];
    const where: string[] = [];

    const productId = intParam(req.query.productId);
    const locationId = intParam(req.query.locationId);
    const userId = intParam(req.query.userId);
    const type = strParam(req.query.type);
    const from = strParam(req.query.from);
    const to = strParam(req.query.to);
    const q = strParam(req.query.q);

    if (productId) { params.push(productId); where.push(`m.product_id = $${params.length}`); }
    if (locationId) { params.push(locationId); where.push(`m.location_id = $${params.length}`); }
    if (userId) { params.push(userId); where.push(`m.user_id = $${params.length}`); }
    if (type) { params.push(type); where.push(`m.type = $${params.length}::movement_type`); }
    if (from) { params.push(from); where.push(`m.created_at >= $${params.length}::timestamptz`); }
    if (to) { params.push(`${to} 23:59:59.999`); where.push(`m.created_at <= $${params.length}::timestamptz`); }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR m.reference_number ILIKE $${n} OR m.reason ILIKE $${n})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await query(
      `SELECT m.type, m.quantity, m.balance_after, m.created_at,
              m.reference_type, m.reference_number, m.reason, m.notes,
              p.code AS product_code, p.name AS product_name, p.unit,
              l.name AS location_name, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN locations l ON l.id = m.location_id
       JOIN users u ON u.id = m.user_id
       ${whereSql}
       ORDER BY m.created_at ASC, m.id ASC    -- libro en orden cronologico real
       LIMIT 10000`,
      params
    );

    const esc = (v: unknown) => String(v ?? '').replace(/"/g, '""');
    const header = 'Fecha y hora;Tipo;Código;Producto;Sucursal;Cantidad;Saldo posterior;Referencia;Motivo;Usuario;Notas';
    const lines = rows.rows.map((r: Record<string, unknown>) => [
      new Date(r.created_at as string).toLocaleString('es-AR'),
      r.type, esc(r.product_code), esc(r.product_name), esc(r.location_name),
      Number(r.quantity), Number(r.balance_after),
      esc(r.reference_number), esc(r.reason), esc(r.user_name), esc(r.notes),
    ].join(';'));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="movimientos.csv"');
    res.send('\uFEFF' + [header, ...lines].join('\n'));
  })
);

router.get(
  '/users',
  asyncH(async (_req, res) => {
    const r = await query(
      `SELECT DISTINCT u.id, u.full_name FROM users u
       JOIN stock_movements m ON m.user_id = u.id ORDER BY u.full_name`
    );
    res.json({ users: r.rows });
  })
);

export default router;
