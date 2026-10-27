/**
 * DETALLE DE VIAJE — tooltips/operación del reparto:
 *  - Datos del viaje y flujo de estado (Iniciar reparto / Completar / Cancelar)
 *  - Paradas con "Marcar entregado" (chofer) y alta/baja de paradas (encargado)
 *  - Mapa Leaflet con el recorrido GPS (polyline) y posición actual
 *  - Botón "Compartir ubicación": watchPosition del navegador para el chofer;
 *    reporta un punto a los ~12s si hubo movimiento, y se apaga solo.
 */
import { useCallback, useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Trip, TripStop, AvailableDocs, StopDocType } from '../types';
import { tripStatusStyle } from '../types';
import {
  api, getTrip, getTripTrack, departTrip, completeTrip, cancelTrip, markStopDelivered,
  addTripStop, removeTripStop, updateTrip, postTripPosition, getAvailableDocs,
} from '../lib/api';
import { fmtDateTime, fmtDateTimeShort } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, FormRow, Input, Modal, PageHeader, Select, Spinner, useConfirm, Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import MapView, { type MapMarker, type MapPathPoint } from '../components/MapView';
import { getGpsState, subscribe as subscribeGps, startSharing, stopUser } from '../lib/gpsShare';

const REFRESH_MS = 15000;

export default function RepartoDetail() {
  const { id } = useParams();
  const tripId = Number(id);
  const toast = useToast();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can } = useAuth();

  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [track, setTrack] = useState<MapPathPoint[]>([]);
  const [busyAction, setBusyAction] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [addStopOpen, setAddStopOpen] = useState(false);

  const [editForm, setEditForm] = useState({ driverName: '', driverPhone: '', vehicle: '', notes: '' });

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const t = await getTrip(tripId);
      setTrip(t);
      try {
        const tk = await getTripTrack(tripId);
        setTrack(tk.points);
      } catch { /* track sin posiciones o sin permiso: seguimos */ }
    } catch (e) {
      if (!silent) toast.error((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Auto-refresh mientras el viaje está en ruta (chofer moviéndose)
  useEffect(() => {
    if (!trip || trip.status !== 'EN_RUTA') return;
    const t = window.setInterval(() => void refresh(true), REFRESH_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.status]);

  async function action(name: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusyAction(name);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      await refresh(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyAction('');
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!trip) return <div className="py-16 text-center text-slate-500">No se pudo cargar el viaje.</div>;

  const style = tripStatusStyle(trip.status);
  const enRuta = trip.status === 'EN_RUTA';
  const preparando = trip.status === 'EN_PREPARACION';
  const alcanzadas = (trip.delivered_count ?? 0) === (trip.stop_count ?? 0) && (trip.stop_count ?? 0) > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Viaje ${trip.number}`}
        subtitle={`Chofer: ${trip.driver_name}${trip.vehicle ? ` · ${trip.vehicle}` : ''}`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => navigate('/repartos')}>← Volver</Button>
        }
      />

      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
        <div>
          <div className="text-xs uppercase text-slate-400">Estado</div>
          <Badge color={style.color}>{style.label}</Badge>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-400">Origen</div>
          <div className="font-semibold">{trip.origin_code} · {trip.origin_name}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-400">Paradas</div>
          <div className={`font-semibold ${alcanzadas ? 'text-emerald-700' : ''}`}>{trip.delivered_count}/{trip.stop_count}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-400">Salió</div>
          <div>{fmtDateTime(trip.departed_at)}</div>
        </div>
        {trip.completed_at && (
          <div>
            <div className="text-xs uppercase text-slate-400">Completado</div>
            <div>{fmtDateTime(trip.completed_at)}</div>
          </div>
        )}
        {trip.cancel_reason && (
          <div>
            <div className="text-xs uppercase text-slate-400">Anulado</div>
            <div className="text-red-700">{trip.cancel_reason}</div>
          </div>
        )}
      </Card>

      {trip.notes && (
        <Card className="p-3 text-sm text-slate-600"><span className="font-semibold">Notes:</span> {trip.notes}</Card>
      )}

      {/* Acciones del flujo */}
      <div className="no-print flex flex-wrap items-center gap-2">
        {preparando && can('tracking.gps') && (
          <Button variant="success" loading={busyAction === 'depart'}
            onClick={() =>
              confirm({
                title: 'Iniciar reparto',
                message: `El viaje sale de ${trip.origin_name} con ${trip.stop_count} paradas. Pasará a EN_RUTA y quedará visible en el mapa en vivo.`,
                confirmLabel: 'Iniciar',
                onConfirm: async () => {
                  await departTrip(trip.id);
                  await refresh(true);
                  toast.success('Viaje en ruta');
                },
              })
            }
          >
            Iniciar reparto
          </Button>
        )}
        {enRuta && alcanzadas && can('tracking.gps') && (
          <Button variant="primary" loading={busyAction === 'complete'} onClick={() => action('complete', () => completeTrip(trip.id), 'Viaje completado')}>
            Completar viaje
          </Button>
        )}
        {enRuta && <GpsSharer />}
        {preparando && can('tracking.write') && (
          <Button variant="secondary" onClick={() => { setEditForm({ driverName: trip.driver_name, driverPhone: trip.driver_phone ?? '', vehicle: trip.vehicle ?? '', notes: trip.notes ?? '' }); setEditOpen(true); }}>
            Editar datos
          </Button>
        )}
        {(preparando || enRuta) && can('tracking.write') && (
          <>
            <Button variant="secondary" onClick={() => setAddStopOpen(true)}>+ Agregar parada</Button>
            <Button variant="danger" onClick={() => setCancelOpen(true)}>Anular viaje</Button>
          </>
        )}
        {trip.created_by_name && <span className="ml-auto text-xs text-slate-400">Creado por {trip.created_by_name} · {fmtDateTimeShort(trip.created_at)}</span>}
      </div>

      {/* Paradas */}
      <Card>
        <div className="border-b border-slate-200 p-4">
          <h3 className="font-bold text-brand-800">Paradas de la ruta</h3>
        </div>
        <ol className="divide-y divide-slate-100 px-2">
          {trip.stops?.map((s) => (
            <StopRow key={s.id} stop={s} tripId={trip.id} enRuta={enRuta} preparando={preparando}
              busy={busyAction === `stop-${s.id}`}
              onDeliver={() => action(`stop-${s.id}`, async () => { await markStopDelivered(trip.id, s.id); }, `Parada ${s.sequence} entregada`)}
              onRemove={() => action(`stop-${s.id}`, async () => { await removeTripStop(trip.id, s.id); }, 'Parada quitada del viaje')}
            />
          ))}
        </ol>
      </Card>

      {/* Mapa del recorrido */}
      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="font-bold text-brand-800">Recorrido GPS</h3>
          <span className="text-xs text-slate-400">
            {trip.last_position ? `Última posición hace ${relative(trip.last_position.recorded_at)}` : 'Sin posiciones registradas'}
          </span>
        </div>
        <TripMap trip={trip} track={track} />
      </Card>

      {/* Modales */}
      <CancelModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onSubmit={async (reason) => { setCancelOpen(false); await action('cancel', () => cancelTrip(trip.id, reason), 'Viaje anulado'); }}
      />

      <EditTripModal
        open={editOpen}
        form={editForm}
        setForm={setEditForm}
        onClose={() => setEditOpen(false)}
        onSubmit={async () => {
          setEditOpen(false);
          await action('edit', () => updateTrip(trip.id, {
            driverName: editForm.driverName,
            driverPhone: editForm.driverPhone || null,
            vehicle: editForm.vehicle || null,
            notes: editForm.notes || null,
          }), 'Viaje actualizado');
        }}
      />

      {addStopOpen && (
        <AddStopModal
          tripId={trip.id}
          originLocationId={trip.origin_location_id}
          existing={trip.stops ?? []}
          onClose={() => setAddStopOpen(false)}
          onAdded={() => { setAddStopOpen(false); void refresh(true); }}
        />
      )}
    </div>
  );
}

/* ============================== paradas ============================== */

function StopRow({ stop: s, tripId, enRuta, preparando, busy, onDeliver, onRemove }: {
  stop: TripStop; tripId: number; enRuta: boolean; preparando: boolean;
  busy: boolean; onDeliver: () => void; onRemove: () => void;
}) {
  const { can } = useAuth();
  const docLabel = s.doc_type === 'DELIVERY' ? 'Pedido' : s.doc_type === 'TRANSFER' ? 'Transferencia' : 'Retiro';
  const destino = s.location_name ? `${s.location_code ? `${s.location_code} · ` : ''}${s.location_name}` : (s.customer_name ?? s.address ?? '—');

  return (
    <li className="flex flex-wrap items-start gap-3 rounded-lg p-3 hover:bg-slate-50">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${s.delivered_at ? 'bg-emerald-600 text-white' : 'bg-brand-700 text-white'}`}>
        {s.delivered_at ? '✓' : s.sequence}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-800">{s.reference}</span>
          <Badge color={s.doc_type === 'TRANSFER' ? 'violet' : s.doc_type === 'PENDING_DELIVERY' ? 'amber' : 'blue'}>{docLabel}</Badge>
          {s.delivered_at ? (
            <span className="text-xs font-semibold text-emerald-700">Entregada · {fmtDateTimeShort(s.delivered_at)}{s.delivered_by_name ? ` (${s.delivered_by_name})` : ''}</span>
          ) : enRuta && <span className="text-xs text-amber-700 font-medium">Pendiente</span>}
        </div>
        <div className="mt-0.5 text-sm text-slate-600">
          {s.location_id ? <>Sucursal: <b>{destino}</b></> : <>Cliente: <b>{s.customer_name ?? '—'}</b>{s.address ? <> · Dirección: {s.address}</> : null}</>}
        </div>
        {s.notes && <div className="text-xs text-slate-400">Nota: {s.notes}</div>}
      </div>
      <div className="flex shrink-0 gap-1">
        {enRuta && !s.delivered_at && can('tracking.gps') && (
          <Button variant="success" size="sm" loading={busy} onClick={onDeliver}>Entregada</Button>
        )}
        {preparando && can('tracking.write') && (
          <Button variant="ghost" size="sm" onClick={onRemove}>Quitar</Button>
        )}
      </div>
    </li>
  );
}

function TripMap({ trip, track }: { trip: Trip; track: MapPathPoint[] }) {
  const markers: MapMarker[] = [];
  if (trip.last_position) {
    markers.push({
      id: `trip-${trip.id}`,
      lat: trip.last_position.lat,
      lng: trip.last_position.lng,
      tone: 'vehicle',
      focus: true,
      tooltip: `${trip.number} · ${trip.driver_name}`,
      popup: `<b>${trip.number}</b> — ${trip.driver_name}<br/><i>${fmtDateTimeShort(trip.last_position.recorded_at)}</i>`,
    });
  }
  if (markers.length === 0 && track.length === 0) {
    return <div className="flex h-[380px] items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400">El mapa aparece cuando el chofer comparta su ubicación</div>;
  }
  return <MapView markers={markers} path={track} followKey={`trip-${trip.id}`} height="h-[380px]" />;
}

/* ============================== GPS del chofer ============================== */

/** El compartido ahora es CONTINUO A NIVEL USUARIO (lib/gpsShare): aceptás
 *  una vez y la posición sigue hasta cerrar sesión, aunque cambies de página.
 *  Si tenés un viaje EN_RUTA asignado, el servidor espeja tus puntos al
 *  viaje automáticamente; no hace falta targetear tripId desde el cliente. */
function GpsSharer() {
  const toast = useToast();
  const gps = useSyncExternalStore(subscribeGps, getGpsState);

  async function start() {
    try {
      await startSharing();
      toast.success('Compartiendo ubicación hasta que cierres sesión');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function stop() {
    await stopUser();
    toast.info('Compartido de ubicación detenido');
  }
  const sharing = gps.state === 'active' || gps.state === 'paused' || gps.state === 'starting';
  const paused = gps.state === 'paused';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {sharing ? (
        <>
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${
            paused ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-blue-50 text-blue-700 ring-blue-200'
          }`}>
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${paused ? 'bg-amber-400' : 'bg-blue-400'} opacity-75`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${paused ? 'bg-amber-500' : 'bg-blue-600'}`} />
            </span>
            {paused
              ? 'GPS en pausa (fuera de horario laboral)'
              : `GPS activo${gps.lastSentAt ? ` · enviado ${fmtDateTimeShort(new Date(gps.lastSentAt))}` : ''}${
                  gps.lastAccuracy ? ` · ±${Math.round(gps.lastAccuracy)}m` : ''}`}
          </span>
          <Button variant="secondary" size="sm" onClick={stop}>Detener</Button>
        </>
      ) : (
        <Button variant="primary" onClick={start} title="La ubicación sigue compartiéndose hasta que cierres sesión">
          📍 Compartir mi ubicación
        </Button>
      )}
      {gps.state === 'error' && <span className="text-xs text-red-600">{gps.message}</span>}
      {!sharing && gps.state === 'off' && gps.message && <span className="text-xs text-amber-600">{gps.message}</span>}
    </div>
  );
}

/* ============================== modales ============================== */

function relative(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

function CancelModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Anular viaje" width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Volver</Button>
          <Button variant="danger" onClick={() => onSubmit(reason)} disabled={reason.trim().length < 5}>Anular viaje</Button>
        </>
      }>
      <Field label="Motivo de la anulación" required hint="Mínimo 5 caracteres. Queda registrado en la auditoría.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
      </Field>
    </Modal>
  );
}

function EditTripModal({ open, onClose, form, setForm, onSubmit }: {
  open: boolean; onClose: () => void;
  form: { driverName: string; driverPhone: string; vehicle: string; notes: string };
  setForm: (f: { driverName: string; driverPhone: string; vehicle: string; notes: string }) => void;
  onSubmit: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Editar datos del viaje"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={onSubmit}>Guardar</Button>
        </>
      }>
      <FormRow cols={2}>
        <Field label="Chofer" required>
          <Input value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
        </Field>
        <Field label="Teléfono">
          <Input value={form.driverPhone} onChange={(e) => setForm({ ...form, driverPhone: e.target.value })} />
        </Field>
      </FormRow>
      <FormRow cols={2}>
        <Field label="Vehículo">
          <Input value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} />
        </Field>
        <Field label="Notas">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </FormRow>
    </Modal>
  );
}

function AddStopModal({ tripId, originLocationId, existing, onClose, onAdded }: {
  tripId: number; originLocationId: number; existing: TripStop[]; onClose: () => void; onAdded: () => void;
}) {
  const toast = useToast();
  const [avail, setAvail] = useState<AvailableDocs | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StopDocType | ''>('');
  const [saving, setSaving] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [address, setAddress] = useState('');

  useEffect(() => {
    getAvailableDocs(originLocationId)
      .then(setAvail)
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originLocationId]);

  async function add(docType: StopDocType, docId: number) {
    setSaving(docId);
    try {
      await addTripStop(tripId, { docType, docId, customerName: customerName || null, address: address || null });
      toast.success('Parada agregada al viaje');
      setCustomerName(''); setAddress('');
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const busy = existing.map((s) => `${s.doc_type}-${s.doc_type === 'DELIVERY' ? s.delivery_id : s.doc_type === 'TRANSFER' ? s.transfer_id : s.pending_delivery_id}`);

  return (
    <Modal open onClose={onClose} title="Agregar parada al viaje" width="lg">
      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="space-y-3">
          <Field label="Tipo de documento">
            <Select value={selected} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelected(e.target.value as StopDocType | '')}>
              <option value="">Seleccionar tipo…</option>
              {(avail?.deliveries.length ?? 0) > 0 && <option value="DELIVERY">Pedidos (entregas a domicilio)</option>}
              {(avail?.transfers?.length ?? 0) > 0 && <option value="TRANSFER">Transferencias</option>}
              {(avail?.pendingDeliveries?.length ?? 0) > 0 && <option value="PENDING_DELIVERY">Ordenes de retiro</option>}
            </Select>
          </Field>

          {(selected === 'DELIVERY' || selected === 'PENDING_DELIVERY') && (
            <FormRow cols={2}>
              <Field label="Cliente (opcional)">
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </Field>
              <Field label="Dirección (opcional)">
                <Input value={address} onChange={(e) => setAddress(e.target.value)} />
              </Field>
            </FormRow>
          )}

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {selected === 'DELIVERY' && (avail?.deliveries ?? []).map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-sm">
                <span className="font-semibold">{d.number}</span>
                <Badge color="blue">{d.status}</Badge>
                <span className="ml-auto">
                  {busy.includes(`DELIVERY-${d.id}`) ? (
                    <Badge color="gray">Ya está</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" loading={saving === d.id} onClick={() => add('DELIVERY', d.id)}>Agregar</Button>
                  )}
                </span>
              </div>
            ))}
            {selected === 'TRANSFER' && (avail?.transfers ?? []).map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-sm">
                <span className="font-semibold">{t.number}</span>
                <Badge color="blue">{t.status}</Badge>
                <span className="text-slate-600">→ {t.destination_name}</span>
                <span className="ml-auto">
                  {busy.includes(`TRANSFER-${t.id}`) ? (
                    <Badge color="gray">Ya está</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" loading={saving === t.id} onClick={() => add('TRANSFER', t.id)}>Agregar</Button>
                  )}
                </span>
              </div>
            ))}
            {selected === 'PENDING_DELIVERY' && (avail?.pendingDeliveries ?? []).map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-sm">
                <span className="font-semibold">{p.number}</span>
                <Badge color="blue">{p.status}</Badge>
                <span className="text-slate-600">retira en {p.pickup_location_name}{p.customer_name ? ` · ${p.customer_name}` : ''}</span>
                <span className="ml-auto">
                  {busy.includes(`PENDING_DELIVERY-${p.id}`) ? (
                    <Badge color="gray">Ya está</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" loading={saving === p.id} onClick={() => add('PENDING_DELIVERY', p.id)}>Agregar</Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
