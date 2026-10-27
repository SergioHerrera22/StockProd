/**
 * REPARTOS / TRANSPORTE — listado de viajes + mapa en vivo.
 * El admin ve todos los viajes; una sucursal restringida ve los de su
 * ubicación (el backend filtra con locationGuard). El mapa se refresca solo
 * cada 15s (polling, patrón de Users.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Trip, TripStatus } from '../types';
import { tripStatusStyle } from '../types';
import { api, qs, listTrips } from '../lib/api';
import { getGpsShareStatus, getGpsSchedule, startGpsShare, stopGpsShare, saveGpsSchedule, type GpsSchedule, type DriverLive } from '../lib/api';
import { getGpsState, subscribe as subscribeGps, startSharing, stopUser, type GpsShareState } from '../lib/gpsShare';
import { useSyncExternalStore } from 'react';
import { fmtDateTimeShort } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, PageHeader, Select, Spinner, Tabs, StatCard, EmptyState, Field, Input } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import MapView, { type MapMarker } from '../components/MapView';
import type { Location } from '../types';

const LIVE_REFRESH_MS = 15000;

/** Timestamp relativo simple: "hace 2 min" */
function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export default function Repartos() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [tab, setTab] = useState<'viajes' | 'mapa'>('viajes');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Repartos / Transporte"
        subtitle="Viajes de la camioneta con paradas y seguimiento GPS en vivo"
        actions={
          <>
            {can('tracking.gps') && <GpsShareControl />}
            {tab === 'viajes' && can('tracking.write') ? (
              <Button variant="primary" onClick={() => navigate('/repartos/nuevo')}>+ Nuevo viaje</Button>
            ) : undefined}
          </>
        }
      />

      <Tabs<'viajes' | 'mapa'>
        tabs={[
          { key: 'viajes', label: 'Viajes' },
          { key: 'mapa', label: 'Mapa en vivo' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'viajes' ? <ViajesTab /> : <LiveMapTab />}
    </div>
  );
}

/* ============================== COMPARTIR UBICACIÓN (persistente) ============== */

function GpsShareControl() {
  const toast = useToast();
  const gps = useSyncExternalStore(subscribeGps, getGpsState);
  const [info, setInfo] = useState<{ restricted: boolean; within: boolean } | null>(null);

  useEffect(() => {
    getGpsShareStatus().then((r) => setInfo({ restricted: r.restricted, within: r.within })).catch(() => {});
  }, []);

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
  return <GpsShareButton gps={gps} info={info} onStart={start} onStop={stop} />;
}

function GpsShareButton({ gps, info, onStart, onStop }: {
  gps: GpsShareState;
  info: { restricted: boolean; within: boolean } | null;
  onStart: () => void;
  onStop: () => void;
}) {
  if (gps.state === 'active' || gps.state === 'paused' || gps.state === 'starting') {
    const paused = gps.state === 'paused';
    return (
      <div className="flex items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${
          paused ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-blue-50 text-blue-700 ring-blue-200'
        }`}>
          <span className="relative flex h-2.5 w-2.5">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${paused ? 'bg-amber-400' : 'bg-blue-400'} opacity-75`} />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${paused ? 'bg-amber-500' : 'bg-blue-600'}`} />
          </span>
          {paused ? 'GPS en pausa (fuera de horario)' : 'GPS activo'}
        </span>
        <Button variant="secondary" size="sm" onClick={onStop}>Detener</Button>
      </div>
    );
  }
  if (gps.state === 'error') {
    return <span className="text-sm text-red-600" title={gps.message ?? undefined}>⚠️ GPS: {gps.message}</span>;
  }
  const fuera = info?.restricted && !info.within;
  return (
    <Button variant="primary" onClick={onStart} title="Comparte tu ubicación hasta que cierres sesión">
      📍 Compartir mi ubicación
      {fuera && <span className="ml-2 text-xs font-normal text-brand-100">(fuera de horario: queda en pausa)</span>}
    </Button>
  );
}

/* ============================== HORARIO LABORAL GPS (admin) ============== */

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function ScheduleEditor() {
  const toast = useToast();
  const [sched, setSched] = useState<GpsSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await withOldServer404(safeGetSchedule);
        setSched(r ?? { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' });
      } catch {
        setSched({ enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!sched) return;
    setSaving(true);
    try {
      const r = await saveGpsSchedule(sched);
      setSched(r.schedule ?? sched);
      setOpen(false);
      toast.success('Horario GPS guardado');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;
  if (!sched) return null;

  const diasTxt = sched.days.length ? sched.days.map((d) => DIAS[d]).join(' ') : 'sin días';

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-brand-800">🛎️ Horario de compartido GPS</div>
          <p className="text-xs text-slate-500">
            {sched.enabled ? `Se comparte ${diasTxt} de ${sched.start} a ${sched.end}` : 'Sin restricción: siempre activo'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Configurar</Button>
      </div>
      {open && (
        <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox" id="gps-authored" checked={sched.enabled}
              onChange={(e) => setSched({ ...sched, enabled: e.target.checked })}
            />
            <label htmlFor="gps-authored" className="text-sm font-medium">Limitar al horario laboral</label>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Días</div>
            <div className="flex gap-1.5">
              {DIAS.map((d, i) => {
                const on = sched.days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSched({ ...sched, days: on ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort((a, b) => a - b) })}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                      on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde">
              <Input type="time" value={sched.start} onChange={(e) => setSched({ ...sched, start: e.target.value })} />
            </Field>
            <Field label="Hasta" hint="Puede pasar de medianoche">
              <Input type="time" value={sched.end} onChange={(e) => setSched({ ...sched, end: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={save}>Guardar</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

async function safeGetSchedule(): Promise<GpsSchedule | null> {
  const r = await getGpsSchedule();
  return r.schedule ?? null;
}

async function withOldServer404(fn: () => Promise<GpsSchedule | null>): Promise<GpsSchedule | null> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null; // server sin 025
    throw e;
  }
}


/* ============================== LISTA DE VIAJES ============================== */

function ViajesTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState<Trip[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [originLocationId, setOriginLocationId] = useState(user?.locationId ? String(user.locationId) : '');
  const [locations, setLocations] = useState<Location[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listTrips({ status: status || undefined, originLocationId: originLocationId ? Number(originLocationId) : undefined, page, pageSize: 15 });
      setRows(res.trips);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, originLocationId, page]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  const columns: Column<Trip>[] = [
    { key: 'number', label: 'Viaje', render: (t) => <span className="font-semibold text-brand-800">{t.number}</span> },
    { key: 'status', label: 'Estado', render: (t) => { const s = tripStatusStyle(t.status); return <Badge color={s.color}>{s.label}</Badge>; } },
    { key: 'origin_name', label: 'Origen', value: (t) => t.origin_name, render: (t) => (t.origin_code ? `${t.origin_code} · ` : '') + (t.origin_name ?? '—') },
    { key: 'driver_name', label: 'Chofer', value: (t) => t.driver_name },
    { key: 'vehicle', label: 'Vehículo', value: (t) => t.vehicle ?? '' },
    {
      key: 'stops', label: 'Paradas', value: (t) => t.delivered_count ?? 0,
      render: (t) => {
        const done = t.delivered_count ?? 0;
        const tot = t.stop_count ?? 0;
        return <span className={done === tot && tot > 0 ? 'font-semibold text-emerald-700' : ''}>{done}/{tot}</span>;
      },
    },
    {
      key: 'last_position', label: 'GPS', value: (t) => t.last_position?.recorded_at ?? '',
      render: (t) =>
        t.last_position ? (
          <span className="text-blue-700 font-medium" title={t.last_position.lat + ', ' + t.last_position.lng}>
            📍 hace {ago(t.last_position.recorded_at)}
          </span>
        ) : (
          <span className="text-slate-400">sin señal</span>
        ),
    },
    {
      key: 'departed_at', label: 'Salió', value: (t) => t.departed_at ?? '',
      render: (t) => fmtDateTimeShort(t.departed_at),
    },
  ];

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-44">
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Estado</label>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            <option value="EN_PREPARACION">En preparación</option>
            <option value="EN_RUTA">En ruta</option>
            <option value="COMPLETADO">Completado</option>
            <option value="CANCELADO">Cancelado</option>
          </Select>
        </div>
        <div className="w-56">
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Sucursal de salida</label>
          <Select value={originLocationId} onChange={(e) => { setOriginLocationId(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
            ))}
          </Select>
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/repartos/${t.id}`)}
        loading={loading}
        emptyTitle="Sin viajes"
        emptyHint="Cuando se cargue un reparto (EN + transferencias + órdenes de retiro) aparece acá."
        pageSize={15}
        total={total}
        page={page}
        onPageChange={setPage}
      />
    </div>
  );
}

/* ============================== MAPA EN VIVO ============================== */

function LiveMapTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [drivers, setDrivers] = useState<DriverLive[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<{ trips: Trip[]; drivers?: DriverLive[] }>('/tracking/live');
      setTrips(r.trips);
      setDrivers(r.drivers ?? []);
    } catch (e) {
      if (!silent) toast.error((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(true), LIVE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const inRoute = trips.filter((t) => t.status === 'EN_RUTA');
  const preparing = trips.filter((t) => t.status === 'EN_PREPARACION');

  const markers: MapMarker[] = [];
  for (const t of trips) {
    if (!t.last_position) continue;
    const isSel = selected === t.id;
    markers.push({
      id: `trip-${t.id}`,
      lat: t.last_position.lat,
      lng: t.last_position.lng,
      tone: 'vehicle',
      focus: isSel,
      tooltip: `${t.number} · ${t.driver_name}`,
      popup:
        `<b>${t.number}</b> · ${t.driver_name}` +
        (t.vehicle ? ` (${t.vehicle})` : '') +
        `<br/>Se actualizó hace ${ago(t.last_position.recorded_at)}` +
        `<br/>Paradas entregadas: ${t.delivered_count}/${t.stop_count}` +
        `<br/><i>${t.origin_code ?? ''} · ${t.origin_name ?? ''}</i>`,
    });
  }

  // Choferes con compartido activo sin viaje EN_RUTA asignado: salen como
  // punto individual (con viaje activo su marca ya está como vehicle).
  const mapped = new Set(trips.map((t) => t.driver_user_id).filter(Boolean)) as Set<number>;
  for (const d of drivers.filter((x) => !mapped.has(x.user_id))) {
    markers.push({
      id: `driver-${d.user_id}`,
      lat: d.lat,
      lng: d.lng,
      tone: 'driver',
      accuracyM: d.accuracy,
      tooltip: `${d.full_name} (GPS)`,
      popup:
        `<b>🚗 ${d.full_name}</b><br/>Comparte GPS desde ${fmtDateTimeShort(d.share_started_at)}` +
        `<br/>Actualizado hace ${ago(d.recorded_at)}` +
        (d.accuracy ? `<br/><i>Precisión ±${Math.round(d.accuracy)}m</i>` : ''),
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      {/* Panel de viajes activos */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="En ruta" value={inRoute.length} icon="🚐" tone="default" />
          <StatCard label="Choferes con GPS" value={drivers.filter((d) => !mapped.has(d.user_id)).length} icon="🚗" />
        </div>

        {can('settings.write') && <ScheduleEditor />}

        {drivers.filter((d) => !mapped.has(d.user_id)).length > 0 && (
          <Card className="p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">🚗 Compartiendo ahora</div>
            {drivers.filter((d) => !mapped.has(d.user_id)).map((d) => (
              <div key={d.user_id} className="flex items-center justify-between py-0.5 text-sm">
                <span>{d.full_name}</span>
                <span className="text-xs text-slate-400">hace {ago(d.recorded_at)}</span>
              </div>
            ))}
          </Card>
        )}

        {loading ? (
          <div className="flex justify-center py-10"><Spinner size="lg" /></div>
        ) : trips.length === 0 ? (
          <EmptyState icon="🗺️" title="No hay repartos activos" hint="Los viajes EN_RUTA con GPS activo aparecen acá en tiempo real." />
        ) : (
          <div className="space-y-2">
            {trips.map((t) => {
              const s = tripStatusStyle(t.status);
              return (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`w-full rounded-xl border p-3 text-left transition-shadow hover:shadow-md ${
                    selected === t.id ? 'border-blue-400 ring-2 ring-blue-200 bg-blue-50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-brand-800">{t.number}</span>
                    <Badge color={s.color}>{s.label}</Badge>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    🚐 {t.driver_name}{t.vehicle ? ` · ${t.vehicle}` : ''}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                    <span>Paradas {t.delivered_count}/{t.stop_count}</span>
                    {t.last_position && <span className="text-blue-700 font-medium">📍 GPS hace {ago(t.last_position.recorded_at)}</span>}
                  </div>
                  {selected === t.id && (
                    <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
                      {t.stops?.slice(0, 6).map((st) => (
                        <div key={st.id} className="flex items-center justify-between gap-2 py-0.5">
                          <span className={st.delivered_at ? 'line-through text-slate-400' : ''}>
                            {st.sequence}. {st.reference} · {st.location_name ?? st.customer_name ?? st.address}
                          </span>
                          <span>{st.delivered_at ? '✓' : ''}</span>
                        </div>
                      ))}
                      {t.stops && t.stops.length > 6 && <div className="text-slate-400">…y {t.stops.length - 6} más</div>}
                      {user && can('tracking.read') && (
                        <button className="mt-1 font-semibold text-blue-700 hover:underline" onClick={(e) => { e.stopPropagation(); navigate(`/repartos/${t.id}`); }}>
                          Ver detalle →
                        </button>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-slate-400">Se actualiza automáticamente cada {LIVE_REFRESH_MS / 1000}s.</p>
      </div>

      {/* Mapa */}
      <Card className="p-3">
        {markers.length > 0 ? (
          <MapView markers={markers} followKey={selected ?? undefined} height="h-[560px]" />
        ) : (
          <div className="flex h-[560px] items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400">
            {loading ? <Spinner size="lg" /> : 'Sin posiciones GPS para mostrar todavía'}
          </div>
        )}
      </Card>
    </div>
  );
}
