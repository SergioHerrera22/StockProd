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
