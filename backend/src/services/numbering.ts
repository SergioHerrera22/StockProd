import { PoolClient } from 'pg';

const DOC_PREFIX: Record<string, string> = {
  delivery: 'E',
  entry: 'I',
  transfer: 'T',
  count: 'INV',
  pending_delivery: 'PD',
};

const SEQ: Record<string, string> = {
  delivery: 'seq_delivery_number',
  entry: 'seq_stock_entry_number',
  transfer: 'seq_transfer_number',
  count: 'seq_stock_count_number',
  pending_delivery: 'seq_pending_delivery_number',
};

/** Genera el numero correlativo del documento (E-000123, I-000045, T-000012, INV-000003). */
export async function nextDocNumber(client: PoolClient, kind: keyof typeof SEQ): Promise<string> {
  const seq = SEQ[kind];
  const r = await client.query<{ n: string }>(`SELECT nextval('${seq}') AS n`);
  return `${DOC_PREFIX[kind]}-${String(r.rows[0].n).padStart(6, '0')}`;
}
