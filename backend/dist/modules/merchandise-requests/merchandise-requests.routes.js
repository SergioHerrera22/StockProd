"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const pagination_1 = require("../../lib/pagination");
const pool_1 = require("../../db/pool");
const merchandise_requests_service_1 = require("./merchandise-requests.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
const itemsSchema = zod_1.z.array(zod_1.z.object({ productId: zod_1.z.number().int().positive(), quantity: zod_1.z.number().min(3) })).min(1).max(300);
router.get('/products', (0, auth_1.requirePerm)('merchandise_requests.use'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const term = (0, pagination_1.strParam)(req.query.q)?.trim();
    if (!term || term.length < 2)
        return res.json({ products: [] });
    const pattern = '%' + term.replace(/[\\%_]/g, '\\\\$&') + '%';
    const result = await (0, pool_1.query)(`SELECT id,code,barcode,name,brand,unit FROM products
  WHERE is_active=true AND (code ILIKE $1 OR barcode ILIKE $1 OR name ILIKE $1 OR brand ILIKE $1)
  ORDER BY CASE WHEN code=$2 OR barcode=$2 THEN 0 WHEN code ILIKE $1 OR barcode ILIKE $1 THEN 1 ELSE 2 END,name
  LIMIT 25`, [pattern, term]);
    res.json({ products: result.rows });
}));
router.get('/', (0, auth_1.requirePerm)('merchandise_requests.use'), (0, errorHandler_1.asyncH)(async (req, res) => res.json({ requests: await (0, merchandise_requests_service_1.listMerchandiseRequests)(req.user, (0, pagination_1.strParam)(req.query.status)) })));
router.get('/:id', (0, auth_1.requirePerm)('merchandise_requests.use'), (0, errorHandler_1.asyncH)(async (req, res) => res.json({ request: await (0, merchandise_requests_service_1.getMerchandiseRequest)(req.user, (0, pagination_1.pathId)(req.params.id)) })));
router.post('/', (0, auth_1.requirePerm)('merchandise_requests.use'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => { const d = zod_1.z.object({ items: itemsSchema, notes: zod_1.z.string().max(1000).optional() }).parse(req.body); res.status(201).json(await (0, merchandise_requests_service_1.createMerchandiseRequest)(req.user, d.items, d.notes, req.ip)); })));
router.post('/:id/seen', (0, auth_1.requirePerm)('merchandise_requests.manage'), (0, errorHandler_1.asyncH)(async (req, res) => res.json(await (0, merchandise_requests_service_1.setMerchandiseRequestStatus)(req.user, (0, pagination_1.pathId)(req.params.id), 'VISTO', undefined, req.ip))));
router.post('/:id/preparing', (0, auth_1.requirePerm)('merchandise_requests.manage'), (0, errorHandler_1.asyncH)(async (req, res) => res.json(await (0, merchandise_requests_service_1.setMerchandiseRequestStatus)(req.user, (0, pagination_1.pathId)(req.params.id), 'EN_PREPARACION', undefined, req.ip))));
router.post('/:id/attended', (0, auth_1.requirePerm)('merchandise_requests.manage'), (0, errorHandler_1.asyncH)(async (req, res) => res.json(await (0, merchandise_requests_service_1.setMerchandiseRequestStatus)(req.user, (0, pagination_1.pathId)(req.params.id), 'ATENDIDO', undefined, req.ip))));
router.post('/:id/reject', (0, auth_1.requirePerm)('merchandise_requests.manage'), (0, errorHandler_1.asyncH)(async (req, res) => { const d = zod_1.z.object({ reason: zod_1.z.string().min(5).max(255) }).parse(req.body); res.json(await (0, merchandise_requests_service_1.setMerchandiseRequestStatus)(req.user, (0, pagination_1.pathId)(req.params.id), 'RECHAZADO', d.reason, req.ip)); }));
exports.default = router;
