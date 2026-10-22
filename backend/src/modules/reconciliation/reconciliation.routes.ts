import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams } from '../../lib/pagination';
import { 
  runFullReconciliation, getReconciliationHistory
} from '../../services/reconciliation.service';

const router = Router();
router.use(authRequired, requirePerm('audit.read')); // Solo ADMIN/ENCARGADO con audit.read

// Ejecutar conciliación completa
router.post(
  '/run',
  asyncH(async (req, res) => {
    const { locationId } = z.object({
      locationId: z.number().int().positive().optional(),
    }).parse(req.body);
    const result = await runFullReconciliation(req.user!, req.ip, locationId);
    res.json(result);
  })
);

// Historial de conciliaciones
router.get(
  '/history',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await getReconciliationHistory({
      locationId: req.query.locationId ? parseInt(req.query.locationId as string, 10) : undefined,
      status: req.query.status as string,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

export default router;