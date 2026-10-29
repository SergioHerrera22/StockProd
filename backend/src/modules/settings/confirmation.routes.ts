import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { listConfirmationSettings, upsertConfirmationSetting } from '../../services/confirmationSettings.service';

const router = Router();
router.use(authRequired);

router.get(
  '/',
  requirePerm('settings.write'),
  asyncH(async (_req, res) => {
    const rows = await listConfirmationSettings();
    res.json({ settings: rows });
  })
);

router.put(
  '/:module/:action',
  requirePerm('settings.write'),
  asyncH(async (req, res) => {
    const schema = z.object({
      allow_same_user: z.boolean().optional(),
      require_different_user: z.boolean().optional(),
      require_min_role: z.string().nullable().optional(),
      require_dual_auth: z.boolean().optional(),
      enabled: z.boolean().optional(),
      notes: z.string().nullable().optional(),
    });
    const body = schema.parse(req.body);
    const result = await upsertConfirmationSetting(req.user!.id, req.ip, {
      module: req.params.module as any,
      action: req.params.action as any,
      ...body,
    });
    res.json(result);
  })
);

export default router;
