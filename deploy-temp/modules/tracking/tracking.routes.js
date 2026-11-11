"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Rutas de TRANSPORTE / REPARTO con GPS (/api/tracking).
 * Permisos:
 *  - tracking.read : ver viajes, mapa en vivo y track GPS
 *  - tracking.write: armar/editar viajes y paradas, cancelar
 *  - tracking.gps  : operar el viaje (salió, parada entregada) y reportar posición
 */
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const tracking_service_1 = require("./tracking.service");
const router = (0, express_1.Router)();
// Permisos granulares: lectura para todos los operativos; administración y
// operación de GPS se exigen por ruta.
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('tracking.read'));
const tripsSchema = zod_1.z.object({
    originLocationId: zod_1.z.number().int().positive(),
    driverName: zod_1.z.string().trim().min(2).max(120),
    driverPhone: zod_1.z.string().trim().max(40).optional().nullable(),
    vehicle: zod_1.z.string().trim().max(120).optional().nullable(),
    notes: zod_1.z.string().trim().max(500).optional().nullable(),
    stops: zod_1.z
        .array(zod_1.z.object({
        docType: zod_1.z.enum(['DELIVERY', 'TRANSFER', 'PENDING_DELIVERY']),
        docId: zod_1.z.number().int().positive(),
        address: zod_1.z.string().trim().max(250).optional().nullable(),
        customerName: zod_1.z.string().trim().max(150).optional().nullable(),
    }))
        .min(1)
        .max(50),
});
const tripUpdateSchema = zod_1.z.object({
    driverName: zod_1.z.string().trim().min(2).max(120).optional(),
    driverPhone: zod_1.z.string().trim().max(40).optional().nullable(),
    vehicle: zod_1.z.string().trim().max(120).optional().nullable(),
    notes: zod_1.z.string().trim().max(500).optional().nullable(),
});
const stopSchema = zod_1.z.object({
    docType: zod_1.z.enum(['DELIVERY', 'TRANSFER', 'PENDING_DELIVERY']),
    docId: zod_1.z.number().int().positive(),
    address: zod_1.z.string().trim().max(250).optional().nullable(),
    customerName: zod_1.z.string().trim().max(150).optional().nullable(),
});
const positionSchema = zod_1.z
    .object({
    lat: zod_1.z.number().min(-90).max(90),
    lng: zod_1.z.number().min(-180).max(180),
    accuracy: zod_1.z.number().min(0).max(100000).optional().nullable(),
    speed: zod_1.z.number().min(0).max(200).optional().nullable(),
    heading: zod_1.z.number().min(0).max(360).optional().nullable(),
})
    .strict();
/* ============================ VIAJES ============================ */
router.get('/trips', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, tracking_service_1.listTrips)(req.user, {
        status: (0, pagination_1.strParam)(req.query.status),
        originLocationId: (0, pagination_1.intParam)(req.query.originLocationId),
        page,
        pageSize,
        offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.post('/trips', (0, auth_1.requirePerm)('tracking.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = tripsSchema.parse(req.body);
    res.status(201).json({ trip: await (0, tracking_service_1.createTrip)(req.user, req.ip, input) });
})));
router.get('/trips/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ trip });
}));
router.get('/trips/:id/track', (0, errorHandler_1.asyncH)(async (req, res) => {
    const limit = (0, pagination_1.intParam)(req.query.limit) ?? 500;
    res.json(await (0, tracking_service_1.getTripTrack)(req.user, (0, pagination_1.pathId)(req.params.id), limit));
}));
router.put('/trips/:id', (0, auth_1.requirePerm)('tracking.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = tripUpdateSchema.parse(req.body);
    await (0, tracking_service_1.updateTrip)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), input);
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ trip });
}));
router.post('/trips/:id/depart', (0, auth_1.requirePerm)('tracking.gps'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    await (0, tracking_service_1.departTrip)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ trip });
})));
router.post('/trips/:id/complete', (0, auth_1.requirePerm)('tracking.gps'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    await (0, tracking_service_1.completeTrip)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ trip });
})));
router.post('/trips/:id/cancel', (0, auth_1.requirePerm)('tracking.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason } = zod_1.z.object({ reason: zod_1.z.string().min(5).max(255) }).parse(req.body);
    await (0, tracking_service_1.cancelTrip)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason);
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ trip });
})));
/* ============================ PARADAS ============================ */
router.post('/trips/:id/stops', (0, auth_1.requirePerm)('tracking.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = stopSchema.parse(req.body);
    const stops = await (0, tracking_service_1.addStop)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), input);
    res.json({ stops });
}));
router.delete('/trips/:id/stops/:stopId', (0, auth_1.requirePerm)('tracking.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const stops = await (0, tracking_service_1.removeStop)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), (0, pagination_1.pathId)(req.params.stopId));
    res.json({ stops });
}));
router.post('/trips/:id/stops/:stopId/delivered', (0, auth_1.requirePerm)('tracking.gps'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { notes } = zod_1.z
        .object({ notes: zod_1.z.string().trim().max(255).optional().nullable() })
        .parse(req.body ?? {});
    const result = await (0, tracking_service_1.completeStop)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), (0, pagination_1.pathId)(req.params.stopId), notes);
    const trip = await (0, tracking_service_1.getTrip)(req.user, (0, pagination_1.pathId)(req.params.id));
    res.json({ ok: true, ...result, trip });
})));
/* ============================ COMPARTIR UBICACIÓN CONTINUA ============================ */
const scheduleSchema = zod_1.z
    .object({
    enabled: zod_1.z.boolean(),
    /** Dias 0=domingo..6=sabado */
    days: zod_1.z.array(zod_1.z.number().int().min(0).max(6)).max(7),
    start: zod_1.z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
    end: zod_1.z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM'),
})
    .strict();
router.get('/schedule', (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json(await (0, tracking_service_1.getSchedule)());
}));
router.put('/schedule', (0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = scheduleSchema.parse(req.body);
    await (0, tracking_service_1.saveSchedule)(req.user.id, req.ip, input);
    res.json(await (0, tracking_service_1.getSchedule)());
}));
/** Estado de MI compartido (píldora del chofer). */
router.get('/share', (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json(await (0, tracking_service_1.getShareStatus)(req.user));
}));
router.post('/share/start', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json(await (0, tracking_service_1.startShare)(req.user, req.ip));
}));
router.post('/share/stop', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    await (0, tracking_service_1.stopShare)(req.user, req.ip, 'user');
    res.json({ ok: true });
}));
/** Posición del usuario compartiendo (requiere tracking.gps). La posición
 *  se espeja automaticamente a su viaje EN_RUTA si tiene uno. */
router.post('/positions', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const pos = positionSchema.parse(req.body);
    res.json(await (0, tracking_service_1.addSharedPosition)(req.user, pos));
}));
/* ============================ GPS POR VIAJE (legacy) ============================ */
router.post('/trips/:id/positions', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const pos = positionSchema.parse(req.body);
    res.json(await (0, tracking_service_1.addPosition)(req.user, (0, pagination_1.pathId)(req.params.id), pos));
}));
/* ============================ MAPA Y DISPO ============================ */
router.get('/live', (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json(await (0, tracking_service_1.getLive)(req.user));
}));
router.get('/available', (0, auth_1.requirePerm)('tracking.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const origin = (0, pagination_1.intParam)(req.query.originLocationId);
    if (!origin)
        return res.status(400).json({ error: 'Falta originLocationId' });
    res.json(await (0, tracking_service_1.getAvailableDocs)(req.user, origin));
}));
exports.default = router;
