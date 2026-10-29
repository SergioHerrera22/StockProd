import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pathId } from '../../lib/pagination';
import {
  listDrivers,
  getMyAssignments,
  getMyHistory,
  startDelivery,
  completeDelivery,
  assignDriver,
  getAdminDelays,
  geocodeAddress,
} from './drivers.service';

const router = Router();
router.use(authRequired);

router.get('/drivers', requirePerm('users.read'), asyncH(async (_req, res) => {
  res.json({ drivers: await listDrivers() });
}));

router.get('/my-assignments', asyncH(async (req, res) => {
  res.json({ assignments: await getMyAssignments(req.user!) });
}));

router.get('/my-history', asyncH(async (req, res) => {
  res.json({ history: await getMyHistory(req.user!) });
}));

router.post('/assign', requirePerm('deliveries.write'), asyncH(async (req, res) => {
  const body = z.object({
    type: z.enum(['DELIVERY', 'TRANSFER']),
    id: z.number().int().positive(),
    driverUserId: z.number().int().positive(),
  }).parse(req.body);
  res.json(await assignDriver(req.user!, req.ip, body.type, body.id, body.driverUserId));
}));

router.post('/start', requirePerm('tracking.gps'), asyncH(async (req, res) => {
  const body = z.object({
    type: z.enum(['DELIVERY', 'TRANSFER']),
    id: z.number().int().positive(),
  }).parse(req.body);
  res.json(await startDelivery(req.user!, req.ip, body.type, body.id));
}));

router.post('/complete', requirePerm('tracking.gps'), asyncH(async (req, res) => {
  const body = z.object({
    type: z.enum(['DELIVERY', 'TRANSFER']),
    id: z.number().int().positive(),
    notes: z.string().optional(),
  }).parse(req.body);
  res.json(await completeDelivery(req.user!, req.ip, body.type, body.id, body.notes));
}));

router.get('/delays', requirePerm('tracking.read'), asyncH(async (_req, res) => {
  res.json(await getAdminDelays());
}));

router.post('/geocode', asyncH(async (req, res) => {
  const body = z.object({ address: z.string().min(3) }).parse(req.body);
  res.json(await geocodeAddress(body.address));
}));

export default router;
