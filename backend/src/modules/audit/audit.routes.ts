import { Router } from 'express';
import { query } from '../../db/pool';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam } from '../../lib/pagination';

const router = Router();
router.use(authRequired, requirePerm('audit.read'));

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 30);
    const params: unknown[] = [];
    const where: string[] = [];
    const userId = intParam(req.query.userId);
    const action = strParam(req.query.action);
    const entity = strParam(req.query.entity);
    if (userId) { params.push(userId); where.push(`a.user_id = $${params.length}`); }
    if (action) { params.push(`%${action.toUpperCase()}%`); where.push(`a.action ILIKE $${params.length}`); }
    if (entity) { params.push(entity); where.push(`a.entity = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM audit_logs a ${whereSql}`, params);
    const rows = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at,
              u.full_name AS user_name, u.username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ logs: rows.rows, total: Number(count.rows[0].total), page, pageSize });
  })
);

export default router;
