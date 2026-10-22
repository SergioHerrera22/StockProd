import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, pathId } from '../../lib/pagination';
import { 
  createSnapshot, getSnapshot, listSnapshots, compareSnapshots, 
  verifySnapshotIntegrity, getProductStockHistory,
  createDailySnapshots, createWeeklySnapshots
} from '../../services/snapshot.service';

const router = Router();
router.use(authRequired, requirePerm('stock.read'));

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listSnapshots({
      locationId: req.query.locationId ? parseInt(req.query.locationId as string, 10) : undefined,
      snapshotType: req.query.snapshotType as any,
      referenceType: req.query.referenceType as string,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get(
  '/:id',
  asyncH(async (req, res) => {
    const snap = await getSnapshot(pathId(req.params.id));
    if (!snap) return res.status(404).json({ error: 'Snapshot no encontrado' });
    res.json({ snapshot: snap });
  })
);

router.get(
  '/:id/verify',
  asyncH(async (req, res) => {
    const result = await verifySnapshotIntegrity(pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/',
  requirePerm('stock.adjust'), // Permiso elevado para crear snapshots manuales
  asyncH(async (req, res) => {
    const input = z.object({
      locationId: z.number().int().positive(),
      snapshotType: z.enum(['DAILY', 'WEEKLY', 'MANUAL', 'PRE_COUNT', 'POST_COUNT', 'PRE_TRANSFER', 'POST_TRANSFER']),
      referenceId: z.number().int().positive().optional(),
      referenceType: z.string().optional(),
    }).parse(req.body);
    const snap = await createSnapshot(req.user!, req.ip, input.locationId, input.snapshotType, input.referenceId, input.referenceType);
    res.status(201).json({ snapshot: snap });
  })
);

router.post(
  '/compare',
  asyncH(async (req, res) => {
    const { snapshotId1, snapshotId2 } = z.object({
      snapshotId1: z.number().int().positive(),
      snapshotId2: z.number().int().positive(),
    }).parse(req.body);
    const result = await compareSnapshots(snapshotId1, snapshotId2);
    res.json(result);
  })
);

router.get(
  '/product/:productId/history',
  asyncH(async (req, res) => {
    const locationId = parseInt(req.query.locationId as string, 10);
    const productId = pathId(req.params.productId);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
    if (!locationId) return res.status(400).json({ error: 'locationId es requerido' });
    const history = await getProductStockHistory(locationId, productId, limit);
    res.json({ history });
  })
);

// Jobs programados (llamar desde cron externo)
router.post(
  '/daily',
  requirePerm('stock.adjust'),
  asyncH(async (req, res) => {
    const result = await createDailySnapshots(req.user!);
    res.json({ results: result });
  })
);

router.post(
  '/weekly',
  requirePerm('stock.adjust'),
  asyncH(async (req, res) => {
    const result = await createWeeklySnapshots(req.user!);
    res.json({ results: result });
  })
);

export default router;