import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, pathId } from '../../lib/pagination';
import { 
  listAlerts, getAlert, acknowledgeAlert, resolveAlert, dismissAlert, countPendingAlerts,
  runAllScheduledChecks
} from '../../services/alerts.service';

const router = Router();
router.use(authRequired, requirePerm('alerts.read'));

// Contador para badge en UI
router.get(
  '/pending-count',
  asyncH(async (req, res) => {
    const user = req.user!;
    const locationId = req.query.locationId ? parseInt(req.query.locationId as string, 10) : undefined;
    // El usuario ve alertas dirigidas a su rol o globales
    const count = await countPendingAlerts(user.role, locationId);
    res.json({ count });
  })
);

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listAlerts({
      status: req.query.status as any,
      severity: req.query.severity as any,
      code: req.query.code as string,
      targetRole: req.user!.role,
      targetLocationId: req.query.locationId ? parseInt(req.query.locationId as string, 10) : undefined,
      entityType: req.query.entityType as string,
      entityId: req.query.entityId ? parseInt(req.query.entityId as string, 10) : undefined,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get(
  '/:id',
  asyncH(async (req, res) => {
    const alert = await getAlert(pathId(req.params.id));
    if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
    res.json({ alert });
  })
);

router.post(
  '/:id/acknowledge',
  requirePerm('alerts.manage'),
  asyncH(async (req, res) => {
    const result = await acknowledgeAlert(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/resolve',
  requirePerm('alerts.manage'),
  asyncH(async (req, res) => {
    const { notes } = z.object({ notes: z.string().max(500).optional() }).parse(req.body);
    const result = await resolveAlert(req.user!, req.ip, pathId(req.params.id), notes);
    res.json(result);
  })
);

router.post(
  '/:id/dismiss',
  requirePerm('alerts.manage'), // Solo ADMIN/ENCARGADO
  asyncH(async (req, res) => {
    const { notes } = z.object({ notes: z.string().max(500).optional() }).parse(req.body);
    const result = await dismissAlert(req.user!, req.ip, pathId(req.params.id), notes);
    res.json(result);
  })
);

// Endpoint para ejecutar checks programados (llamar desde cron/job scheduler)
router.post(
  '/run-scheduled-checks',
  requirePerm('alerts.manage'),
  asyncH(async (req, res) => {
    const results = await runAllScheduledChecks();
    res.json({ results });
  })
);

export default router;