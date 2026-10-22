import { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

export interface AuditEntry {
  userId: number | null;
  action: string;       // ej: LOGIN, DELIVERY_CONFIRM, PRODUCT_CREATE
  entity: string;       // ej: delivery, product, user
  entityId?: number | null;
  details?: unknown;
  ip?: string | null;
}

/** Registra una operacion en audit_logs. */
export async function writeAudit(poolOrClient: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await poolOrClient.query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      entry.userId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ip ?? null,
    ]
  );
}
