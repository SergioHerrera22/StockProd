/**
 * Rutas de TRANSPORTE / REPARTO con GPS (/api/tracking).
 * Permisos:
 *  - tracking.read : ver viajes, mapa en vivo y track GPS
 *  - tracking.write: armar/editar viajes y paradas, cancelar
 *  - tracking.gps  : operar el viaje (salió, parada entregada) y reportar posición
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam, pathId } from '../../lib/pagination';
import {
  listTrips,
  getTrip,
  getTripTrack,
  getAvailableDocs,
  createTrip,
  updateTrip,
  addStop,
  removeStop,
  departTrip,
  completeStop,
  completeTrip,
  cancelTrip,
  addPosition,
  getLive,
  type StopDocType,
} from './tracking.service';

const router = Router();

// Permisos granulares: lectura para todos los operativos; administración y
// operación de GPS se exigen por ruta.
router.use(authRequired, requirePerm('tracking.read'));

const tripsSchema = z.object({
  originLocationId: z.number().int().positive(),
  driverName: z.string().trim().min(2).max(120),
  driverPhone: z.string().trim().max(40).optional().nullable(),
  vehicle: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  stops: z
    .array(
      z.object({
        docType: z.enum(['DELIVERY', 'TRANSFER', 'PENDING_DELIVERY']),
        docId: z.number().int().positive(),
        address: z.string().trim().max(250).optional().nullable(),
        customerName: z.string().trim().max(150).optional().nullable(),
      })
    )
    .min(1)
    .max(50),
});

const tripUpdateSchema = z.object({
  driverName: z.string().trim().min(2).max(120).optional(),
  driverPhone: z.string().trim().max(40).optional().nullable(),
  vehicle: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

const stopSchema = z.object({
  docType: z.enum(['DELIVERY', 'TRANSFER', 'PENDING_DELIVERY']),
  docId: z.number().int().positive(),
  address: z.string().trim().max(250).optional().nullable(),
  customerName: z.string().trim().max(150).optional().nullable(),
});

const positionSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100000).optional().nullable(),
    speed: z.number().min(0).max(200).optional().nullable(),
    heading: z.number().min(0).max(360).optional().nullable(),
  })
  .strict();

/* ============================ VIAJES ============================ */

router.get(
  '/trips',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listTrips(req.user!, {
      status: strParam(req.query.status),
      originLocationId: intParam(req.query.originLocationId),
      page,
      pageSize,
      offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.post(
  '/trips',
  requirePerm('tracking.write'),
  idempotent(asyncH(async (req, res) => {
    const input = tripsSchema.parse(req.body);
    res.status(201).json({ trip: await createTrip(req.user!, req.ip, input) });
  }))
);

router.get(
  '/trips/:id',
  asyncH(async (req, res) => {
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ trip });
  })
);

router.get(
  '/trips/:id/track',
  asyncH(async (req, res) => {
    const limit = intParam(req.query.limit) ?? 500;
    res.json(await getTripTrack(req.user!, pathId(req.params.id), limit));
  })
);

router.put(
  '/trips/:id',
  requirePerm('tracking.write'),
  asyncH(async (req, res) => {
    const input = tripUpdateSchema.parse(req.body);
    await updateTrip(req.user!, req.ip, pathId(req.params.id), input);
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ trip });
  })
);

router.post(
  '/trips/:id/depart',
  requirePerm('tracking.gps'),
  idempotent(asyncH(async (req, res) => {
    await departTrip(req.user!, req.ip, pathId(req.params.id));
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ trip });
  }))
);

router.post(
  '/trips/:id/complete',
  requirePerm('tracking.gps'),
  idempotent(asyncH(async (req, res) => {
    await completeTrip(req.user!, req.ip, pathId(req.params.id));
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ trip });
  }))
);

router.post(
  '/trips/:id/cancel',
  requirePerm('tracking.write'),
  idempotent(asyncH(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5).max(255) }).parse(req.body);
    await cancelTrip(req.user!, req.ip, pathId(req.params.id), reason);
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ trip });
  }))
);

/* ============================ PARADAS ============================ */

router.post(
  '/trips/:id/stops',
  requirePerm('tracking.write'),
  asyncH(async (req, res) => {
    const input = stopSchema.parse(req.body);
    const stops = await addStop(req.user!, req.ip, pathId(req.params.id), input);
    res.json({ stops });
  })
);

router.delete(
  '/trips/:id/stops/:stopId',
  requirePerm('tracking.write'),
  asyncH(async (req, res) => {
    const stops = await removeStop(req.user!, req.ip, pathId(req.params.id), pathId(req.params.stopId));
    res.json({ stops });
  })
);

router.post(
  '/trips/:id/stops/:stopId/delivered',
  requirePerm('tracking.gps'),
  idempotent(asyncH(async (req, res) => {
    const { notes } = z
      .object({ notes: z.string().trim().max(255).optional().nullable() })
      .parse(req.body ?? {});
    const result = await completeStop(req.user!, req.ip, pathId(req.params.id), pathId(req.params.stopId), notes);
    const trip = await getTrip(req.user!, pathId(req.params.id));
    res.json({ ok: true, ...result, trip });
  }))
);

/* ============================ GPS ============================ */

router.post(
  '/trips/:id/positions',
  requirePerm('tracking.gps'),
  asyncH(async (req, res) => {
    const pos = positionSchema.parse(req.body);
    res.json(await addPosition(req.user!, pathId(req.params.id), pos));
  })
);

/* ============================ MAPA Y DISPO ============================ */

router.get(
  '/live',
  asyncH(async (req, res) => {
    res.json(await getLive(req.user!));
  })
);

router.get(
  '/available',
  requirePerm('tracking.write'),
  asyncH(async (req, res) => {
    const origin = intParam(req.query.originLocationId);
    if (!origin) return res.status(400).json({ error: 'Falta originLocationId' });
    res.json(await getAvailableDocs(req.user!, origin));
  })
);

export default router;
