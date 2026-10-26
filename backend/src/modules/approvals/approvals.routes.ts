import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, pathId } from '../../lib/pagination';
import { 
  listApprovalRules, createApprovalRule, updateApprovalRule,
  listApprovalRequests, getApprovalRequest, resolveApprovalRequest, cancelApprovalRequest,
  evaluateApprovalRules, checkApprovalStatus
} from '../../services/approval.service';

const router = Router();
router.use(authRequired);

// Reglas de aprobación (ADMIN/ENCARGADO con perm approvals.read)
router.get(
  '/rules',
  requirePerm('approvals.read'),
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listApprovalRules({
      entityType: req.query.entityType as string,
      operation: req.query.operation as string,
      isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.post(
  '/rules',
  // Mutación de configuración: solo ADMIN (settings.write). Antes solo exigía
  // approvals.read: un EMPLEADO podía crear reglas de aprobación vía API.
  requirePerm('settings.write'),
  asyncH(async (req, res) => {
    const input = z.object({
      name: z.string().min(3).max(100),
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
      operation: z.enum(['CREATE', 'CONFIRM', 'RECEIVE', 'VOID', 'APPLY', 'ADJUST']),
      condition: z.record(z.unknown()).default({}),
      action: z.record(z.unknown()).default({}),
      priority: z.number().int().optional(),
    }).parse(req.body);
    const result = await createApprovalRule(req.user!, req.ip, input);
    res.status(201).json(result);
  })
);

router.patch(
  '/rules/:id',
  // Mutación de configuración: solo ADMIN (settings.write)
  requirePerm('settings.write'),
  asyncH(async (req, res) => {
    const input = z.object({
      name: z.string().min(3).max(100).optional(),
      condition: z.record(z.unknown()).optional(),
      action: z.record(z.unknown()).optional(),
      priority: z.number().int().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    const result = await updateApprovalRule(req.user!, req.ip, pathId(req.params.id), input);
    res.json(result);
  })
);

// Solicitudes de aprobación
router.get(
  '/requests',
  requirePerm('approvals.read'),
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listApprovalRequests({
      status: req.query.status as any,
      entityType: req.query.entityType as any,
      requestedBy: req.query.requestedBy ? parseInt(req.query.requestedBy as string, 10) : undefined,
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get(
  '/requests/:id',
  requirePerm('approvals.read'),
  asyncH(async (req, res) => {
    const request = await getApprovalRequest(pathId(req.params.id));
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    res.json({ request });
  })
);

router.post(
  '/requests/:id/resolve',
  requirePerm('approvals.approve'),
  asyncH(async (req, res) => {
    const { action, notes } = z.object({
      action: z.enum(['APPROVE', 'REJECT']),
      notes: z.string().max(500).optional(),
    }).parse(req.body);
    const result = await resolveApprovalRequest(req.user!, req.ip, pathId(req.params.id), action, notes);
    res.json(result);
  })
);

router.post(
  '/requests/:id/cancel',
  requirePerm('approvals.approve'),
  asyncH(async (req, res) => {
    const result = await cancelApprovalRequest(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

// Evaluar reglas para un contexto (útil para UI)
router.post(
  '/evaluate',
  requirePerm('approvals.read'),
  asyncH(async (req, res) => {
    const { entityType, operation, context } = z.object({
      entityType: z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
      operation: z.enum(['CREATE', 'CONFIRM', 'RECEIVE', 'VOID', 'APPLY', 'ADJUST']),
      context: z.record(z.unknown()),
    }).parse(req.body);
    const rules = await evaluateApprovalRules(entityType, operation, context);
    res.json({ rules });
  })
);

// Verificar estado de aprobación de una entidad
router.get(
  '/status/:entityType/:entityId',
  requirePerm('approvals.read'),
  asyncH(async (req, res) => {
    const { entityType, entityId } = req.params;
    const status = await checkApprovalStatus(entityType, parseInt(entityId, 10));
    res.json(status);
  })
);

export default router;