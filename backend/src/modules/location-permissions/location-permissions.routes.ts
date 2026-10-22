import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { 
  grantLocationPermission, revokeLocationPermission,
  listUserPermissions, listLocationPermissions,
  getEffectivePermissions, hasEffectivePermission,
  STANDARD_PERMISSIONS
} from '../../services/locationPermissions.service';
import { pathId } from '../../lib/pagination';

const router = Router();
router.use(authRequired, requirePerm('users.manage'));

// Catálogo de permisos estándar (para UI)
router.get(
  '/catalog',
  asyncH(async (_req, res) => {
    res.json({ permissions: STANDARD_PERMISSIONS });
  })
);

// Permisos efectivos del usuario actual (para frontend)
router.get(
  '/my-effective',
  asyncH(async (req, res) => {
    const perms = await getEffectivePermissions(req.user!.id);
    res.json({ permissions: perms });
  })
);

// Verificar permiso específico (para guards en frontend)
router.get(
  '/check',
  asyncH(async (req, res) => {
    const { permission, locationId } = z.object({
      permission: z.string(),
      locationId: z.number().int().positive().optional(),
    }).parse(req.query);
    const has = await hasEffectivePermission(req.user!.id, permission, locationId);
    res.json({ hasPermission: has });
  })
);

// Gestionar permisos de un usuario
router.get(
  '/user/:userId',
  asyncH(async (req, res) => {
    const perms = await listUserPermissions(pathId(req.params.userId));
    res.json({ permissions: perms });
  })
);

router.post(
  '/user/:userId',
  asyncH(async (req, res) => {
    const input = z.object({
      locationId: z.number().int().positive(),
      permission: z.string(),
      scope: z.enum(['GLOBAL', 'LOCATION', 'OWN_LOCATION']),
      expiresAt: z.string().datetime().nullable().optional(),
    }).parse(req.body);
    const result = await grantLocationPermission(req.user!, req.ip, {
      userId: pathId(req.params.userId),
      locationId: input.locationId,
      permission: input.permission,
      scope: input.scope,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    res.status(201).json(result);
  })
);

router.delete(
  '/user/:userId/:locationId/:permission',
  asyncH(async (req, res) => {
    const result = await revokeLocationPermission(req.user!, req.ip, 
      pathId(req.params.userId),
      pathId(req.params.locationId),
      req.params.permission
    );
    res.json(result);
  })
);

// Usuarios con permisos en una ubicación
router.get(
  '/location/:locationId',
  asyncH(async (req, res) => {
    const perms = await listLocationPermissions(pathId(req.params.locationId));
    res.json({ permissions: perms });
  })
);

export default router;