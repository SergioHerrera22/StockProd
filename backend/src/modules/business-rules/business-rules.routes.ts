import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, pathId } from '../../lib/pagination';
import { 
  listBusinessRules, createBusinessRule, updateBusinessRule,
  evaluateBusinessRules,
  listControlThresholds, upsertControlThreshold, deleteControlThreshold,
  evaluateThresholdsAndAlert
} from '../../services/businessRules.service';

const router = Router();
router.use(authRequired, requirePerm('audit.read')); // Reusar perm de auditoría o crear uno específico

// Reglas de negocio
router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listBusinessRules({
      entityType: req.query.entityType as string,
      triggerEvent: req.query.triggerEvent as string,
      isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.post(
  '/',
  asyncH(async (req, res) => {
    const input = z.object({
      code: z.string().min(3).max(50),
      name: z.string().min(3).max(100),
      description: z.string().optional(),
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
      triggerEvent: z.enum(['BEFORE_CREATE', 'BEFORE_CONFIRM', 'BEFORE_RECEIVE', 'BEFORE_VOID', 'BEFORE_APPLY', 'BEFORE_ADJUST']),
      condition: z.record(z.unknown()).default({}),
      action: z.record(z.unknown()).default({}),
      severity: z.enum(['INFO', 'WARNING', 'BLOCKING']).optional(),
    }).parse(req.body);
    const result = await createBusinessRule(req.user!, req.ip, input);
    res.status(201).json(result);
  })
);

router.patch(
  '/:id',
  asyncH(async (req, res) => {
    const input = z.object({
      name: z.string().min(3).max(100).optional(),
      description: z.string().optional(),
      condition: z.record(z.unknown()).optional(),
      action: z.record(z.unknown()).optional(),
      severity: z.enum(['INFO', 'WARNING', 'BLOCKING']).optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    const result = await updateBusinessRule(req.user!, req.ip, pathId(req.params.id), input);
    res.json(result);
  })
);

// Evaluar reglas para un contexto
router.post(
  '/evaluate',
  asyncH(async (req, res) => {
    const { entityType, triggerEvent, context } = z.object({
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
      triggerEvent: z.enum(['BEFORE_CREATE', 'BEFORE_CONFIRM', 'BEFORE_RECEIVE', 'BEFORE_VOID', 'BEFORE_APPLY', 'BEFORE_ADJUST']),
      context: z.record(z.unknown()),
    }).parse(req.body);
    const rules = await evaluateBusinessRules(entityType, triggerEvent, context);
    res.json({ rules });
  })
);

// Umbrales de control
router.get(
  '/thresholds',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listControlThresholds({
      locationId: req.query.locationId ? parseInt(req.query.locationId as string, 10) : null,
      entityType: req.query.entityType as string,
      isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.post(
  '/thresholds',
  asyncH(async (req, res) => {
    const input = z.object({
      locationId: z.number().int().positive().nullable().optional().transform(v => v ?? null),
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST', 'PRODUCT']),
      metric: z.string().min(1).max(50),
      thresholdValue: z.number(),
      thresholdOperator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ']),
      action: z.record(z.unknown()).default({}),
    }).parse(req.body);
    const result = await upsertControlThreshold(req.user!, req.ip, input);
    res.json(result);
  })
);

router.delete(
  '/thresholds/:id',
  asyncH(async (req, res) => {
    const result = await deleteControlThreshold(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

// Evaluar umbrales y generar alertas si corresponde
router.post(
  '/thresholds/evaluate',
  asyncH(async (req, res) => {
    const { entityType, context, targetLocationId } = z.object({
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST', 'PRODUCT']),
      context: z.record(z.unknown()),
      targetLocationId: z.number().int().positive().optional(),
    }).parse(req.body);
    const alerts = await evaluateThresholdsAndAlert(entityType, context, targetLocationId);
    res.json({ alerts });
  })
);

export default router;