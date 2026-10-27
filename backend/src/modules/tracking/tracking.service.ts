/**
 * Módulo TRANSPORTE / REPARTO con GPS.
 *
 * Un VIAJE es la ruta de una camioneta que sale de una ubicación y hace
 * PARADAS, cada una con un documento asociado:
 *  - TRANSFER (T-...): transferencia EN_TRANSITO (sale de la sucursal origen
 *    hacia la destino; la recepción sigue por su flujo normal).
 *  - PENDING_DELIVERY (PD-...): orden de retiro derivada — la mercadería viaja
 *    desde la sucursal de origen de los items hasta la de retiro.
 *  - DELIVERY (EN-...): pedido a domicilio; parada sin sucursal, con dirección
 *    opcional cargada a mano.
 *
 * El chofer comparte la ubicación desde el celular (watchPosition del
 * navegador) y el backend guarda los puntos (con tope y throttle) para el
 * mapa en vivo del admin y de las sucursales. Nada del stock se mueve acá:
 * cada documento se cierra por su propio flujo.
 *
 * Seguridad: respeta locationGuard — un ENCARGADO restringido a su
 * ubicación ve y arma solo viajes de su sucursal (o con parada en ella).
 */
import type { AuthUser } from '../../middleware/auth';
import { ApiError } from '../../lib/errors';
import { assertLocationAccess } from '../../lib/locationGuard';
import { query, withTx } from '../../db/pool';
import type { PoolClient } from 'pg';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';

export type StopDocType = 'DELIVERY' | 'TRANSFER' | 'PENDING_DELIVERY';

export interface StopInput {
  docType: StopDocType;
  docId: number;
  address?: string | null;
  customerName?: string | null;
}

export interface CreateTripInput {
  originLocationId: number;
  driverName: string;
  driverPhone?: string | null;
  vehicle?: string | null;
  notes?: string | null;
  stops: StopInput[];
}

export interface UpdateTripInput {
  driverName?: string;
  driverPhone?: string | null;
  vehicle?: string | null;
  notes?: string | null;
}

export interface PositionInput {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
}

export interface TripStopRow {
  id: number;
  sequence: number;
  location_id: number | null;
  location_code: string | null;
  location_name: string | null;
  delivery_id: number | null;
  transfer_id: number | null;
  pending_delivery_id: number | null;
  doc_type: StopDocType;
  reference: string;
  customer_name: string | null;
  address: string | null;
  delivered_at: string | null;
  delivered_by_name: string | null;
  notes: string | null;
}

export interface TripRow {
  id: number;
  number: string;
  status: 'EN_PREPARACION' | 'EN_RUTA' | 'COMPLETADO' | 'CANCELADO';
  origin_location_id: number;
  origin_code: string;
  origin_name: string;
  driver_name: string;
  driver_phone: string | null;
  driver_user_id: number | null;
  vehicle: string | null;
  notes: string | null;
  departed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by_name: string | null;
  created_at: string;
  stop_count: number;
  delivered_count: number;
  last_position: { lat: number; lng: number; recorded_at: string } | null;
  stops?: TripStopRow[];
}

/** ¿Es viaje activo (todavía editable)? */
const ACTIVE_STATES = `'EN_PREPARACION', 'EN_RUTA'`;

function tripHeadSelect(): string {
  return `
    SELECT t.id, t.number::text AS number, t.status::text AS status,
           t.origin_location_id, lo.code AS origin_code, lo.name AS origin_name,
           t.driver_name, t.driver_phone, t.vehicle, t.notes,
           t.driver_user_id,
           t.departed_at, t.completed_at, t.cancelled_at, t.cancel_reason,
           u.full_name AS created_by_name, t.created_at,
           (SELECT COUNT(*)::int FROM trip_stops ts WHERE ts.trip_id = t.id) AS stop_count,
           (SELECT COUNT(*)::int FROM trip_stops ts WHERE ts.trip_id = t.id AND ts.delivered_at IS NOT NULL) AS delivered_count,
           lp.lat, lp.lng, lp.recorded_at AS last_at
    FROM delivery_trips t
    JOIN locations lo ON lo.id = t.origin_location_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN LATERAL (
      SELECT p.lat, p.lng, p.recorded_at
      FROM trip_positions p WHERE p.trip_id = t.id
      ORDER BY p.id DESC LIMIT 1
    ) lp ON TRUE`;
}

interface HeadRow {
  id: number; number: string; status: string;
  origin_location_id: number; origin_code: string; origin_name: string;
  driver_name: string; driver_phone: string | null; vehicle: string | null; notes: string | null;
  driver_user_id: number | null;
  departed_at: Date | null; completed_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null;
  created_by_name: string | null; created_at: Date;
  stop_count: number; delivered_count: number;
  lat: string | number | null; lng: string | number | null; last_at: Date | null;
}

function mapHead(r: HeadRow): TripRow {  return {
    id: r.id,
    number: r.number,
    status: r.status as TripRow['status'],
    origin_location_id: r.origin_location_id,
    origin_code: r.origin_code,
    origin_name: r.origin_name,
    driver_name: r.driver_name,
    driver_phone: r.driver_phone,
    driver_user_id: r.driver_user_id == null ? null : Number(r.driver_user_id),
    vehicle: r.vehicle,
    notes: r.notes,
    departed_at: r.departed_at ? r.departed_at.toISOString() : null,
    completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    cancelled_at: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    cancel_reason: r.cancel_reason,
    created_by_name: r.created_by_name,
    created_at: r.created_at.toISOString(),
    stop_count: Number(r.stop_count ?? 0),
    delivered_count: Number(r.delivered_count ?? 0),
    last_position:
      r.lat != null && r.lng != null && r.last_at
        ? { lat: Number(r.lat), lng: Number(r.lng), recorded_at: r.last_at.toISOString() }
        : null,
  };
}

/** Query que corre en el cliente de la tx o en el pool global. */
function execFor<T extends import('pg').QueryResultRow>(client: PoolClient | null) {
  return (text: string, params?: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
}

async function loadStops(client: PoolClient | null, tripId: number): Promise<TripStopRow[]> {
  const run = execFor<Record<string, unknown>>(client);
  const r = await run(   `SELECT ts.id, ts.sequence, ts.location_id, lo.code AS location_code, lo.name AS location_name,
            ts.delivery_id, ts.transfer_id, ts.pending_delivery_id,
            ts.doc_type, ts.reference, ts.customer_name, ts.address,
            ts.delivered_at, du.full_name AS delivered_by_name, ts.notes
     FROM trip_stops ts
     LEFT JOIN locations lo ON lo.id = ts.location_id
     LEFT JOIN users du ON du.id = ts.delivered_by
     WHERE ts.trip_id = $1
     ORDER BY ts.sequence`,
    [tripId]
  );
  return r.rows.map((s: Record<string, unknown>) => ({
    id: Number(s.id),
    sequence: Number(s.sequence),
    location_id: s.location_id === null ? null : Number(s.location_id),
    location_code: (s.location_code as string | null) ?? null,
    location_name: (s.location_name as string | null) ?? null,
    delivery_id: s.delivery_id === null ? null : Number(s.delivery_id),
    transfer_id: s.transfer_id === null ? null : Number(s.transfer_id),
    pending_delivery_id: s.pending_delivery_id === null ? null : Number(s.pending_delivery_id),
    doc_type: s.doc_type as StopDocType,
    reference: s.reference as string,
    customer_name: (s.customer_name as string | null) ?? null,
    address: (s.address as string | null) ?? null,
    delivered_at: s.delivered_at ? (s.delivered_at as Date).toISOString() : null,
    delivered_by_name: (s.delivered_by_name as string | null) ?? null,
    notes: (s.notes as string | null) ?? null,
  }));
}

/* ============================ LISTADO / DETALLE ============================ */

export async function listTrips(
  user: AuthUser,
  filters: { status?: string; originLocationId?: number; onlyMine?: boolean; page: number; pageSize: number; offset: number }
): Promise<{ trips: TripRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    where.push(`t.status = $${params.length}::trip_status`);
  }
  if (filters.originLocationId) {
    params.push(filters.originLocationId);
    where.push(`t.origin_location_id = $${params.length}`);
  }
  if (user.role !== 'ADMIN' && user.restrictToLocation) {
    if (!user.locationId) {
      throw ApiError.forbidden('Tu usuario está restringido a una ubicación pero no tiene ninguna asignada.');
    }
    params.push(user.locationId);
    const n = params.length;
    where.push(
      `(t.origin_location_id = $${n} OR t.driver_user_id = $${n} OR EXISTS (
          SELECT 1 FROM trip_stops ts WHERE ts.trip_id = t.id AND ts.location_id = $${n}))`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM delivery_trips t ${whereSql}`,
    params
  );

  params.push(filters.pageSize, filters.offset);
  const rows = await query<HeadRow>(
    `${tripHeadSelect()}
     ${whereSql}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { trips: rows.rows.map(mapHead), total: Number(count.rows[0].total) };
}

/** Verifica que el usuario (restringido) tenga acceso a este viaje. */
async function assertTripVisible(user: AuthUser, tripId: number, client?: PoolClient): Promise<void> {
  if (user.role === 'ADMIN' || !user.restrictToLocation) return;
  if (!user.locationId) {
    throw ApiError.forbidden('Tu usuario está restringido a una ubicación pero no tiene ninguna asignada.');
  }
  const run = execFor<{ ok: boolean }>(client ?? null);
  const r = await run(
    `SELECT (t.origin_location_id = $2 OR t.driver_user_id = $2
             OR EXISTS (SELECT 1 FROM trip_stops ts WHERE ts.trip_id = t.id AND ts.location_id = $2)) AS ok
     FROM delivery_trips t WHERE t.id = $1`,
    [tripId, user.locationId]
  );
  if (!r.rows[0]?.ok) throw ApiError.forbidden('Solo podés ver viajes de tu ubicación.');
}

export async function getTrip(user: AuthUser, tripId: number): Promise<TripRow> {
  const head = await query<HeadRow>(`${tripHeadSelect()} WHERE t.id = $1`, [tripId]);
  if (!head.rows[0]) throw ApiError.notFound('Viaje no encontrado');
  await assertTripVisible(user, tripId);
  const trip = mapHead(head.rows[0]);
  trip.stops = await loadStops(null, tripId);
  return trip;
}

/** Ruta GPS de un viaje (ordenada, para dibujar la polyline). */
export async function getTripTrack(
  user: AuthUser,
  tripId: number,
  limit = 500
): Promise<{ points: { lat: number; lng: number; recorded_at: string }[] }> {
  await assertTripVisible(user, tripId);
  const capped = Math.min(Math.max(1, limit), 2000);
  const r = await query<{ lat: string; lng: string; recorded_at: Date }>(
    `SELECT lat, lng, recorded_at
     FROM (SELECT lat, lng, recorded_at FROM trip_positions
           WHERE trip_id = $1 ORDER BY id DESC LIMIT $2) newest
     ORDER BY recorded_at ASC, lat ASC`,
    [tripId, capped]
  );
  return {
    points: r.rows.map((p) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      recorded_at: p.recorded_at.toISOString(),
    })),
  };
}

/* ============================ DOCUMENTOS DISPONIBLES ============================ */

/** Documentos que pueden subir a un viaje que sale de `originLocationId`. */
export async function getAvailableDocs(user: AuthUser, originLocationId: number) {
  assertLocationAccess(user, originLocationId);

  // Un doc no puede estar en DOS viajes abiertos a la vez
  const activeBlock = (alias: string) => `
    AND NOT EXISTS (
      SELECT 1 FROM trip_stops ts
      JOIN delivery_trips t2 ON t2.id = ts.trip_id
      WHERE t2.status IN (${ACTIVE_STATES})
        AND ${alias})`;

  const [deliveries, transfers, pending] = await Promise.all([
    query(
      `SELECT d.id, d.number, d.status::text AS status, d.invoice_number, d.created_at
       FROM deliveries d
       WHERE d.status IN ('CONFIRMADO', 'PARCIAL') AND d.location_id = $1
         ${activeBlock('ts.delivery_id = d.id')}
       ORDER BY d.created_at DESC LIMIT 50`,
      [originLocationId]
    ),
    query(
      `SELECT t.id, t.number, t.status::text AS status,
              t.destination_location_id, lo.name AS destination_name, t.created_at
       FROM transfers t
       JOIN locations lo ON lo.id = t.destination_location_id
       WHERE t.status = 'EN_TRANSITO' AND t.origin_location_id = $1
         ${activeBlock('ts.transfer_id = t.id')}
       ORDER BY t.created_at DESC LIMIT 50`,
      [originLocationId]
    ),
    query(
      `SELECT pd.id, pd.number, pd.status::text AS status,
              pd.pickup_location_id, plo.name AS pickup_location_name,
              pd.customer_name, pd.created_at
       FROM pending_deliveries pd
       JOIN locations plo ON plo.id = pd.pickup_location_id
       WHERE pd.status IN ('EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')
         AND EXISTS (
           SELECT 1 FROM pending_delivery_items pdi
           WHERE pdi.pending_delivery_id = pd.id AND pdi.source_location_id = $1)
         ${activeBlock('ts.pending_delivery_id = pd.id')}
       ORDER BY pd.created_at DESC LIMIT 50`,
      [originLocationId]
    ),
  ]);

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    deliveries: deliveries.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, invoice_number: r.invoice_number, created_at: iso(r.created_at) })),
    transfers: transfers.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, destination_location_id: r.destination_location_id, destination_name: r.destination_name, created_at: iso(r.created_at) })),
    pendingDeliveries: pending.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, pickup_location_id: r.pickup_location_id, pickup_location_name: r.pickup_location_name, customer_name: r.customer_name, created_at: iso(r.created_at) })),
  };
}

/** Resuelve y valida un documento como parada del viaje que sale de `origin`. */
async function resolveStop(
  client: PoolClient,
  origin: number,
  stop: StopInput
): Promise<{ location_id: number | null; reference: string; customer_name: string | null }> {
  const docId = stop.docId;

  // El doc no puede estar ya en un viaje abierto
  const busy = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM trip_stops ts
     JOIN delivery_trips t2 ON t2.id = ts.trip_id
     WHERE t2.status IN ('EN_PREPARACION', 'EN_RUTA')
       AND ((ts.delivery_id = $1 AND 'DELIVERY' = $2::text)
         OR (ts.transfer_id = $1 AND 'TRANSFER' = $2::text)
         OR (ts.pending_delivery_id = $1 AND 'PENDING_DELIVERY' = $2::text))`,
    [docId, stop.docType]
  );
  if (Number(busy.rows[0].count) > 0) {
    throw ApiError.conflict(
      `El documento ya está en otro viaje activo. Sacalo de ese viaje primero.`
    );
  }

  if (stop.docType === 'DELIVERY') {
    const r = await client.query<{ number: string; status: string; location_id: number }>(
      `SELECT number, status::text AS status, location_id FROM deliveries WHERE id = $1`,
      [docId]
    );
    if (!r.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    if (!['CONFIRMADO', 'PARCIAL'].includes(r.rows[0].status as string)) {
      throw ApiError.conflict('Solo pueden ir al viaje entregas CONFIRMADAS o PARCIALES.');
    }
    if (Number(r.rows[0].location_id) !== Number(origin)) {
      throw ApiError.badRequest('La entrega debe corresponder a la sucursal de salida del viaje.');
    }
    return { location_id: null, reference: r.rows[0].number, customer_name: stop.customerName?.trim() || null };
  }

  if (stop.docType === 'TRANSFER') {
    const r = await client.query<{ number: string; status: string; origin_location_id: number; destination_location_id: number }>(
      `SELECT number, status::text AS status, origin_location_id, destination_location_id FROM transfers WHERE id = $1`,
      [docId]
    );
    if (!r.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
    if (r.rows[0].status !== 'EN_TRANSITO') {
      throw ApiError.conflict('Solo pueden ir al viaje transferencias EN_TRANSITO.');
    }
    if (Number(r.rows[0].origin_location_id) !== Number(origin)) {
      throw ApiError.badRequest('La transferencia debe salir de la sucursal de origen del viaje.');
    }
    return { location_id: Number(r.rows[0].destination_location_id), reference: r.rows[0].number, customer_name: null };
  }

  // PENDING_DELIVERY
  const r = await client.query<{ number: string; status: string; pickup_location_id: number; customer_name: string | null }>(
    `SELECT number, status::text AS status, pickup_location_id, customer_name
     FROM pending_deliveries WHERE id = $1`,
    [docId]
  );
  if (!r.rows[0]) throw ApiError.notFound('Orden de retiro no encontrada');
  if (!['EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL'].includes(r.rows[0].status)) {
    throw ApiError.conflict('Esa orden de retiro no está activa para transportar.');
  }
  const fromOrigin = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM pending_delivery_items
     WHERE pending_delivery_id = $1 AND source_location_id = $2`,
    [docId, origin]
  );
  if (Number(fromOrigin.rows[0].count) === 0) {
    throw ApiError.badRequest('La mercadería de esa orden no sale de la sucursal de origen del viaje.');
  }
  return {
    location_id: Number(r.rows[0].pickup_location_id),
    reference: r.rows[0].number,
    customer_name: stop.customerName?.trim() || r.rows[0].customer_name,
  };
}

/* ============================ ALTA / EDICIÓN ============================ */

export async function createTrip(user: AuthUser, ip: string | undefined, input: CreateTripInput): Promise<TripRow> {
  assertLocationAccess(user, input.originLocationId);
  if (input.stops.length === 0) throw ApiError.badRequest('El viaje necesita al menos una parada.');

  const tripId = await withTx(async (c) => {
    const origin = input.originLocationId;
    const driverPhone = input.driverPhone?.trim() || null;
    const vehicle = input.vehicle?.trim() || null;
    const notes = input.notes?.trim() || null;

    // Validar TODAS las paradas antes de insertar (falla temprano si algún
    // doc no corresponde, sin dejar el viaje a medio armar)
    const resolved = [];
    for (const s of input.stops) {
      resolved.push(await resolveStop(c, origin, s));
    }

    const number = await nextDocNumber(c, 'trip');
    const ins = await c.query<{ id: number }>(
      `INSERT INTO delivery_trips (number, origin_location_id, driver_name, driver_phone, vehicle, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [number, origin, input.driverName.trim(), driverPhone, vehicle, notes, user.id]
    );
    const id = ins.rows[0].id;

    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const s = input.stops[i];
      await c.query(
        `INSERT INTO trip_stops (trip_id, sequence, location_id, delivery_id, transfer_id, pending_delivery_id,
                                 doc_type, reference, customer_name, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id, i + 1, r.location_id,
          s.docType === 'DELIVERY' ? s.docId : null,
          s.docType === 'TRANSFER' ? s.docId : null,
          s.docType === 'PENDING_DELIVERY' ? s.docId : null,
          s.docType, r.reference, r.customer_name, s.address?.trim() || null,
        ]
      );
    }

    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_TRIP_CREATE', entity: 'delivery_trip', entityId: id,
      details: { number, origin: origin, stops: resolved.map((r) => r.reference) }, ip,
    });
    return id;
  });

  const head = await query<HeadRow>(`${tripHeadSelect()} WHERE t.id = $1`, [tripId]);
  const trip = mapHead(head.rows[0]);
  trip.stops = await loadStops(null, tripId);
  return trip;
}

async function loadActiveTrip(c: PoolClient, tripId: number): Promise<{ id: number; status: string; origin_location_id: number; number: string; driver_user_id: number | null }> {
  const r = await c.query<{ id: number; status: string; origin_location_id: number; number: string; driver_user_id: number | null }>(
    `SELECT t.id, t.status::text AS status, t.origin_location_id, t.number, t.driver_user_id
     FROM delivery_trips t WHERE t.id = $1 FOR UPDATE`,
    [tripId]
  );
  if (!r.rows[0]) throw ApiError.notFound('Viaje no encontrado');
  return r.rows[0];
}

function assertActive(status: string): void {
  if (status === 'COMPLETADO' || status === 'CANCELADO') {
    throw ApiError.conflict('El viaje ya está cerrado: no admite modificaciones.');
  }
}

export async function updateTrip(user: AuthUser, ip: string | undefined, tripId: number, input: UpdateTripInput): Promise<void> {
  await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    assertActive(trip.status);
    assertLocationAccess(user, trip.origin_location_id);

    await c.query(
      `UPDATE delivery_trips SET
         driver_name = COALESCE(NULLIF($2, ''), driver_name),
         driver_phone = COALESCE($3, driver_phone),
         vehicle = COALESCE($4, vehicle),
         notes = COALESCE($5, notes)
       WHERE id = $1`,
      [tripId, input.driverName?.trim() ?? '', input.driverPhone?.trim() || null, input.vehicle?.trim() || null, input.notes?.trim() || null]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_TRIP_EDIT', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number, ...input }, ip,
    });
  });
}

export async function addStop(user: AuthUser, ip: string | undefined, tripId: number, stop: StopInput): Promise<TripStopRow[]> {
  const stops = await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    assertActive(trip.status);
    assertLocationAccess(user, trip.origin_location_id);

    const resolved = await resolveStop(c, trip.origin_location_id, stop);
    const seq = await c.query<{ n: number }>(
      `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS n FROM trip_stops WHERE trip_id = $1`,
      [tripId]
    );
    await c.query(
      `INSERT INTO trip_stops (trip_id, sequence, location_id, delivery_id, transfer_id, pending_delivery_id,
                               doc_type, reference, customer_name, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tripId, seq.rows[0].n, resolved.location_id,
        stop.docType === 'DELIVERY' ? stop.docId : null,
        stop.docType === 'TRANSFER' ? stop.docId : null,
        stop.docType === 'PENDING_DELIVERY' ? stop.docId : null,
        stop.docType, resolved.reference, resolved.customer_name, stop.address?.trim() || null,
      ]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_STOP_ADD', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number, reference: resolved.reference }, ip,
    });
    return loadStops(c, tripId);
  });
  return stops;
}

export async function removeStop(user: AuthUser, ip: string | undefined, tripId: number, stopId: number): Promise<TripStopRow[]> {
  const stops = await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    assertActive(trip.status);
    assertLocationAccess(user, trip.origin_location_id);

    const del = await c.query<{ id: number; reference: string }>(
      `DELETE FROM trip_stops WHERE id = $2 AND trip_id = $1 RETURNING id, reference`,
      [tripId, stopId]
    );
    if (!del.rows[0]) throw ApiError.notFound('Parada no encontrada en este viaje');

    // Re-secuenciar 1..n
    await c.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sequence) AS rn
         FROM trip_stops WHERE trip_id = $1
       )
       UPDATE trip_stops ts SET sequence = o.rn
       FROM ordered o WHERE o.id = ts.id`,
      [tripId]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_STOP_REMOVE', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number, reference: del.rows[0].reference }, ip,
    });
    return loadStops(c, tripId);
  });
  return stops;
}

/* ============================ OPERACIÓN EN RUTA ============================ */

export async function departTrip(user: AuthUser, ip: string | undefined, tripId: number): Promise<void> {
  await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    if (trip.status !== 'EN_PREPARACION') {
      throw ApiError.conflict('El viaje no está en preparación.');
    }
    const stops = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM trip_stops WHERE trip_id = $1`, [tripId]
    );
    if (Number(stops.rows[0].n) === 0) throw ApiError.badRequest('El viaje no tiene paradas todavía.');
    await c.query(
      `UPDATE delivery_trips SET status = 'EN_RUTA', departed_at = now() WHERE id = $1`, [tripId]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_TRIP_DEPART', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number }, ip,
    });
  });
}

export async function completeStop(
  user: AuthUser, ip: string | undefined, tripId: number, stopId: number, notes?: string | null
): Promise<{ allDelivered: boolean }> {
  await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    if (trip.status !== 'EN_RUTA') {
      throw ApiError.conflict('Solo se pueden marcar paradas de un viaje EN_RUTA.');
    }
    // Operación de chofer: tracking.gps o tracking.write. requirePerm en la ruta.
    const upd = await c.query<{ id: number; delivered_at: Date | null }>(
      `UPDATE trip_stops SET delivered_at = now(), delivered_by = $3, notes = COALESCE($4, notes)
       WHERE id = $2 AND trip_id = $1 AND delivered_at IS NULL
       RETURNING id, delivered_at`,
      [tripId, stopId, user.id, notes?.trim() || null]
    );
    if (!upd.rows[0]) {
      const exists = await c.query(`SELECT 1 FROM trip_stops WHERE id = $1 AND trip_id = $2`, [stopId, tripId]);
      if (exists.rowCount === 0) throw ApiError.notFound('Parada no encontrada en este viaje');
      throw ApiError.conflict('Esa parada ya fue entregada.');
    }
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_STOP_DELIVERED', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number, stopId }, ip,
    });
  });
  const pend = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM trip_stops WHERE trip_id = $1 AND delivered_at IS NULL`, [tripId]
  );
  return { allDelivered: Number(pend.rows[0].n) === 0 };
}

export async function completeTrip(user: AuthUser, ip: string | undefined, tripId: number): Promise<void> {
  await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    if (trip.status !== 'EN_RUTA') throw ApiError.conflict('El viaje no está en ruta.');
    const pend = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM trip_stops WHERE trip_id = $1 AND delivered_at IS NULL`, [tripId]
    );
    if (Number(pend.rows[0].n) > 0) {
      throw ApiError.conflict('Faltan paradas por entregar. Marcálas completadas primero.');
    }
    await c.query(
      `UPDATE delivery_trips SET status = 'COMPLETADO', completed_at = now() WHERE id = $1`, [tripId]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_TRIP_COMPLETE', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number }, ip,
    });
  });
}

export async function cancelTrip(user: AuthUser, ip: string | undefined, tripId: number, reason: string): Promise<void> {
  await withTx(async (c) => {
    const trip = await loadActiveTrip(c, tripId);
    if (!['EN_PREPARACION', 'EN_RUTA'].includes(trip.status)) {
      throw ApiError.conflict('El viaje ya está cerrado.');
    }
    await c.query(
      `UPDATE delivery_trips SET status = 'CANCELADO', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [tripId, reason]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_TRIP_CANCEL', entity: 'delivery_trip', entityId: tripId,
      details: { number: trip.number, reason }, ip,
    });
  });
}

/* ============================ GPS ============================ */

const MIN_POSITION_SECONDS = 8; // throttle: no guardar pings mareantes
const MAX_POSITIONS_PER_TRIP = 5000;

export async function addPosition(
  user: AuthUser, tripId: number, input: PositionInput
): Promise<{ skipped: boolean }> {
  // Permiso grueso ya chequeado en la ruta (tracking.gps); caller no-chofer OK
  // (la web de la sucursal tambien puede reportar desde una tablet de reparto).
  await assertTripVisible(user, tripId);
  const state = await query<{ status: string }>(
    `SELECT status::text AS status FROM delivery_trips WHERE id = $1`, [tripId]
  );
  if (!state.rows[0]) throw ApiError.notFound('Viaje no encontrado');
  if (state.rows[0].status !== 'EN_RUTA') return { skipped: true };

  const stored = await maybeInsertTripPosition(tripId, input, user.id);
  return { skipped: !stored };
}

/* ============================ COMPARTIR UBICACIÓN CONTINUA (025) ==========
 *
 * El chofer acepta compartir UNA VEZ y su posición llega hasta que cierra
 * sesión (el cliente guarda el flag y lo corta en el logout). El backend:
 *  - guarda las posiciones en driver_positions (con tope y throttle),
 *  - si tiene viaje EN_RUTA asignado, espeja el punto en trip_positions para
 *    que el mapa/recorrido del viaje siga funcionando intacto,
 *  - respeta el HORARIO LABORAL configurado por el administrador
 *    (app_settings key 'gps_schedule'); fuera de horario descarta pings.
 */

/** ¿Dentro del horario laboral configurado? (NULL/ausente = sin restricción)
 *  Evaluado por SQL con la zona horaria de la empresa, NO con la hora del
 *  server (Hostinger corre en UTC: "hoy" no cierra a las 21:00). */
async function shareWindow(): Promise<{ restricted: boolean; within: boolean; schedule: unknown }> {
  // dow: 0=domingo..6=sábado. days en el JSON son enteros 0..6.
  // Ventana cruce de medianoche (end < start): local >= start OR local <= end.
  const r = await query<{ enabled: boolean; days_ok: boolean; time_ok: boolean; value: unknown }>(
    `WITH local AS (
        SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::int AS dow,
               (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::time AS t
      ),
      cfg AS (
        SELECT value FROM app_settings WHERE key = 'gps_schedule'
      )
      SELECT
        COALESCE((SELECT (value->>'enabled')::bool FROM cfg), false) AS enabled,
        COALESCE((SELECT (value->'days') @> to_jsonb(local.dow) FROM cfg, local), false) AS days_ok,
        COALESCE((
          SELECT CASE
            WHEN value->>'start' IS NULL OR value->>'end' IS NULL THEN true
            WHEN (value->>'end')::time >= (value->>'start')::time
              THEN (value->>'start')::time <= local.t AND local.t <= (value->>'end')::time
            ELSE local.t >= (value->>'start')::time OR local.t <= (value->>'end')::time
          END
          FROM cfg, local), false) AS time_ok,
        (SELECT value FROM cfg) AS value
      FROM local`,
    []
  );
  const row = r.rows[0];
  if (!row?.enabled) {
    return { restricted: false, within: true, schedule: row?.value ?? null };
  }
  const within = Boolean(row.days_ok && row.time_ok);
  return { restricted: true, within, schedule: row.value };
}

const MAX_ACCURACY_M = 60; // se descartan fixes peores que esto (error de cuadras)
const SHARE_LIVE_SECONDS = 15 * 60; // comparte "vivo" hasta 15 min sin pings
const MAX_DRIVER_POSITIONS = 10000;

export interface ShareInfo {
  active: boolean;
  started_at: string | null;
  schedule: unknown;
  restricted: boolean;
  within: boolean;
}

/** Inicia la sesión de compartido del usuario (cierra la previa). */
export async function startShare(user: AuthUser, ip: string | undefined): Promise<ShareInfo> {
  await withTx(async (c) => {
    await c.query(
      `UPDATE gps_shares SET ended_at = now(), end_reason = 'replace'
       WHERE user_id = $1 AND ended_at IS NULL`,
      [user.id]
    );
    const ins = await c.query(
      `INSERT INTO gps_shares (user_id) VALUES ($1) RETURNING id`,
      [user.id]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_SHARE_START', entity: 'gps_share', entityId: ins.rows[0].id,
      details: {}, ip,
    });
  });
  const s = await shareWindow();
  return {
    active: true, started_at: null,
    schedule: s.schedule, restricted: s.restricted, within: s.within,
  };
}

/** Corta la sesión del usuario (botón o logout). */
export async function stopShare(user: AuthUser, ip: string | undefined, reason: 'user' | 'logout'): Promise<void> {
  await withTx(async (c) => {
    await c.query(
      `UPDATE gps_shares SET ended_at = now(), end_reason = $2
       WHERE user_id = $1 AND ended_at IS NULL`,
      [user.id, reason]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRACKING_SHARE_STOP', entity: 'gps_share',
      details: { reason }, ip,
    });
  });
}

/** Estado de MI compartido (para la píldora del chofer). */
export async function getShareStatus(user: AuthUser): Promise<ShareInfo> {
  const s = await query<{ started_at: Date }>(
    `SELECT started_at FROM gps_shares WHERE user_id = $1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  const w = await shareWindow();
  return {
    active: s.rows[0] != null,
    started_at: s.rows[0]?.started_at ? s.rows[0].started_at.toISOString() : null,
    schedule: w.schedule,
    restricted: w.restricted,
    within: w.within,
  };
}

/** Inserta (con throttle) un punto del viaje: reutilizado por el espejo desde
 *  el compartido por usuario y por el endpoint legacy por viaje. */
async function maybeInsertTripPosition(tripId: number, pos: PositionInput, userId: number): Promise<boolean> {
  const last = await query<{ recorded_at: Date }>(
    `SELECT recorded_at FROM trip_positions WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tripId]
  );
  if (last.rows[0]) {
    const age = (Date.now() - new Date(last.rows[0].recorded_at).getTime()) / 1000;
    if (age < MIN_POSITION_SECONDS) return false;
  }
  await query(
    `INSERT INTO trip_positions (trip_id, lat, lng, accuracy, speed, heading, recorded_at, source_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [tripId, round6(pos.lat), round6(pos.lng), pos.accuracy ?? null, pos.speed ?? null, pos.heading ?? null, userId]
  );
  if (Math.random() < 0.02) {
    await query(
      `DELETE FROM trip_positions
       WHERE id IN (SELECT id FROM trip_positions WHERE trip_id = $1 ORDER BY id DESC OFFSET $2)`,
      [tripId, MAX_POSITIONS_PER_TRIP]
    );
  }
  return true;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Posición del usuario compartiendo (independiente del viaje). */
export async function addSharedPosition(
  user: AuthUser, input: PositionInput
): Promise<{ skipped: boolean; reason?: string }> {
  const w = await shareWindow();
  if (w.restricted && !w.within) {
    return { skipped: true, reason: 'fuera_de_horario' };
  }
  // Precisión: si el fix viene con error peor que MAX_ACCURACY_M (~una cuadra
  // y media), se descarta en vez de mover el chofer de cuadra con el GPS
  // todavía sin converger.
  if (input.accuracy != null && input.accuracy > MAX_ACCURACY_M) {
    return { skipped: true, reason: 'senial_debil' };
  }

  // Sesión implicita: si el cliente reanuda tras recargar sin haber pasado
  // por start, la volvemos a activar (no perdemos la decisión del usuario).
  const has = await query<{ id: number }>(
    `SELECT id FROM gps_shares WHERE user_id = $1 AND ended_at IS NULL LIMIT 1`, [user.id]
  );
  let shareId = has.rows[0]?.id as number | undefined;
  if (shareId == null) {
    const ins = await query<{ id: number }>(
      `INSERT INTO gps_shares (user_id) VALUES ($1) RETURNING id`, [user.id]
    );
    shareId = ins.rows[0].id;
  }

  // ¿Hay viaje EN_RUTA asignado a este usuario? → espejar punto al viaje
  const trips = await query<{ id: number }>(
    `SELECT t.id FROM delivery_trips t
     WHERE t.driver_user_id = $1 AND t.status = 'EN_RUTA'`,
    [user.id]
  );

  const lat = round6(input.lat);
  const lng = round6(input.lng);
  let mirrored = 0;
  for (const t of trips.rows.filter((r) => r.id != null)) {
    const ok = await maybeInsertTripPosition(Number(t.id), { ...input, lat, lng }, user.id);
    if (ok) mirrored++;
  }

  await query(
    `INSERT INTO driver_positions (user_id, trip_id, lat, lng, accuracy, speed, heading, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      user.id, mirrored > 0 ? Number(trips.rows[0].id) : null,
      lat, lng, input.accuracy ?? null, input.speed ?? null, input.heading ?? null,
    ]
  );
  await query(`UPDATE gps_shares SET last_ping_at = now() WHERE id = $1`, [shareId!]);

  // Limpieza vaga del feed viejo (mismo patrón vago de trip_positions)
  if (Math.random() < 0.02) {
    await query(
      `DELETE FROM driver_positions
       WHERE id IN (SELECT id FROM driver_positions ORDER BY id DESC OFFSET $1)`,
      [MAX_DRIVER_POSITIONS]
    );
    await query(
      `UPDATE gps_shares SET ended_at = now(), end_reason = 'logout'
       WHERE ended_at IS NULL AND COALESCE(last_ping_at, started_at) < now() - interval '2 days'`
    );
  }
  return { skipped: false };
}

/** Ultima posición por usuario de compartidos activos (< 15 min sin ping). */
export async function getDriverLive(user: AuthUser): Promise<{
  drivers: { user_id: number; full_name: string; lat: number; lng: number; accuracy: number | null; recorded_at: string; share_started_at: string }[];
}> {
  // Admin ve todos; sucursal restringida ve solo choferes "suyos": su
  // ubicación default o de sus viajes propios/paradas en su ubicación.
  const mineOnly = user.role !== 'ADMIN' && user.restrictToLocation && user.locationId != null;
  const params: unknown[] = [SHARE_LIVE_SECONDS];
  let whereUser = '';
  if (mineOnly) {
    params.push(user.locationId);
    whereUser = ` AND (u.default_location_id = $${params.length}
      OR EXISTS (SELECT 1 FROM delivery_trips t
                 WHERE t.driver_user_id = s.user_id AND t.status = 'EN_RUTA'
                   AND (t.origin_location_id = $${params.length}
                        OR EXISTS (SELECT 1 FROM trip_stops ts
                                   WHERE ts.trip_id = t.id AND ts.location_id = $${params.length}))))`;
  }
  const r = await query(
    `SELECT s.user_id, s.started_at, u.full_name, p.lat, p.lng, p.accuracy, p.recorded_at
     FROM gps_shares s
     JOIN users u ON u.id = s.user_id
     JOIN LATERAL (
       SELECT lat, lng, accuracy, recorded_at
       FROM driver_positions dp WHERE dp.user_id = s.user_id
       ORDER BY dp.id DESC LIMIT 1
     ) p ON TRUE
     WHERE s.ended_at IS NULL
       AND (COALESCE(s.last_ping_at, s.started_at)) > now() - ($1 * interval '1 second')${whereUser}`,
    params
  );
  return {
    drivers: r.rows.map((d) => ({
      user_id: Number(d.user_id),
      full_name: String(d.full_name),
      lat: Number(d.lat),
      lng: Number(d.lng),
      accuracy: d.accuracy != null ? Number(d.accuracy) : null,
      recorded_at: (d.recorded_at as Date).toISOString(),
      share_started_at: (d.started_at as Date).toISOString(),
    })),
  };
}

/** Horario laboral: leer (sin cache; es una query chicle por cada uso). */
export async function getSchedule(): Promise<{ schedule: unknown; restricted: boolean; within: boolean }> {
  const w = await shareWindow();
  return { schedule: w.schedule, restricted: w.restricted, within: w.within };
}

export async function saveSchedule(
  userId: number, ip: string | undefined,
  input: { enabled: boolean; days: number[]; start: string; end: string }
): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ('gps_schedule', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now(), updated_by = $2`,
    [{ ...input }, userId]
  );
}

/* ============================ MAPA EN VIVO ============================ */

/** Viajes activos con su última posición y paradas: feed del mapa. */
export async function getLive(user: AuthUser): Promise<{ trips: TripRow[]; drivers: Awaited<ReturnType<typeof getDriverLive>>['drivers'] }> {
  const list = await listTrips(user, {
    status: 'EN_RUTA', page: 1, pageSize: 100, offset: 0,
  });
  const trips: TripRow[] = [];
  for (const t of list.trips) {
    t.stops = await loadStops(null, t.id);
    trips.push(t);
  }
  const { drivers } = await getDriverLive(user);
  return { trips, drivers };
}
