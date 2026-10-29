import { PoolClient } from 'pg';
import { query } from '../db/pool';
import { writeAudit } from './audit.service';

export type ConfModule = 'ENTRY' | 'DELIVERY' | 'TRANSFER' | 'COUNT' | 'VOID';
export type ConfAction = 'CONFIRM' | 'APPROVE' | 'APPLY' | 'RECEIVE' | 'VERIFY' | 'VOID';

export interface ConfirmationSetting {
  module: ConfModule;
  action: ConfAction;
  allow_same_user: boolean;
  require_different_user: boolean;
  require_min_role: string | null;
  require_dual_auth: boolean;
  enabled: boolean;
  notes: string | null;
  updated_by?: number | null;
  updated_at?: Date | string | null;
}

export async function getConfirmationSetting(
  c: PoolClient,
  module: ConfModule,
  action: ConfAction
): Promise<ConfirmationSetting | null> {
  const r = await c.query<ConfirmationSetting>(
    `SELECT module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
     FROM system_confirmation_settings
     WHERE module = $1 AND action = $2`,
    [module, action]
  );
  return r.rows[0] ?? null;
}

export async function listConfirmationSettings(): Promise<ConfirmationSetting[]> {
  const r = await query<ConfirmationSetting>(
    `SELECT module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
     FROM system_confirmation_settings
     ORDER BY module, action`
  );
  return r.rows;
}

export async function upsertConfirmationSetting(
  userId: number,
  ip: string | undefined,
  input: Partial<ConfirmationSetting> & { module: ConfModule; action: ConfAction }
): Promise<ConfirmationSetting> {
  const r = await query<ConfirmationSetting>(
    `INSERT INTO system_confirmation_settings (
       module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
     ) VALUES (
       $1, $2, COALESCE($3, false), COALESCE($4, true), $5, COALESCE($6, false), COALESCE($7, true), $8, $9, now()
     )
     ON CONFLICT (module, action) DO UPDATE SET
       allow_same_user = EXCLUDED.allow_same_user,
       require_different_user = EXCLUDED.require_different_user,
       require_min_role = EXCLUDED.require_min_role,
       require_dual_auth = EXCLUDED.require_dual_auth,
       enabled = EXCLUDED.enabled,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at`,
    [
      input.module,
      input.action,
      input.allow_same_user,
      input.require_different_user,
      input.require_min_role ?? null,
      input.require_dual_auth,
      input.enabled,
      input.notes ?? null,
      userId,
    ]
  );

  // Audit
  try {
    const client: any = await (await import('../db/pool')).getClient();
    try {
      await writeAudit(client, {
        userId,
        action: 'SYSTEM_CONFIRMATION_SETTINGS_UPDATE',
        entity: 'system_confirmation_settings',
        entityId: null as any,
        details: { module: input.module, action: input.action, ...input },
        ip,
      });
    } finally {
      client.release();
    }
  } catch {}

  return r.rows[0];
}
