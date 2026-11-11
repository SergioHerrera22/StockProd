"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextDocNumber = nextDocNumber;
const DOC_PREFIX = {
    delivery: 'E',
    entry: 'I',
    transfer: 'T',
    count: 'INV',
    pending_delivery: 'PD',
    trip: 'RP',
};
const SEQ = {
    delivery: 'seq_delivery_number',
    entry: 'seq_stock_entry_number',
    transfer: 'seq_transfer_number',
    count: 'seq_stock_count_number',
    pending_delivery: 'seq_pending_delivery_number',
    trip: 'seq_trip_number',
};
/** Genera el numero correlativo del documento (E-000123, I-000045, T-000012, INV-000003). */
async function nextDocNumber(client, kind) {
    const seq = SEQ[kind];
    const r = await client.query(`SELECT nextval('${seq}') AS n`);
    return `${DOC_PREFIX[kind]}-${String(r.rows[0].n).padStart(6, '0')}`;
}
