import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, Field, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

/** Fila de GET /api/reconciliation/history (tabla reconciliation_logs + location_name). */
interface ReconciliationLogRow {
  id: number;
  location_id: number | null;
  check_type: 'BALANCE_VS_MOVEMENTS' | 'TRANSFER_GAP' | 'PENDING_DELIVERY_STALE' | 'NEGATIVE_STOCK' | 'ORPHAN_MOVEMENT';
  status: 'OK' | 'WARNING' | 'ERROR' | 'FIXED';
  expected_value: string | number | null;
  actual_value: string | number | null;
  difference: string | number | null;
  details: Record<string, unknown> | null;
  fixed_by: number | null;
  fixed_at: string | null;
  run_at: string;
  location_name?: string | null;
}

const STATUS_META: Record<ReconciliationLogRow['status'], { label: string; color: 'green' | 'amber' | 'red' | 'blue' }> = {
  OK: { label: 'OK', color: 'green' },
  WARNING: { label: 'Advertencia', color: 'amber' },
  ERROR: { label: 'Error', color: 'red' },
  FIXED: { label: 'Corregido', color: 'blue' },
};

const CHECK_LABEL: Record<string, string> = {
  BALANCE_VS_MOVEMENTS: 'Saldos vs movimientos',
  TRANSFER_GAP: 'Transferencias en tránsito',
  PENDING_DELIVERY_STALE: 'Entregas pendientes estancadas',
  NEGATIVE_STOCK: 'Stock negativo',
  ORPHAN_MOVEMENTS: 'Movimientos huérfanos',
};

function detailSummary(d: Record<string, unknown> | null): string {
  if (!d || Object.keys(d).length === 0) return '';
  const parts: string[] = [];
  if (d.productName) parts.push(String(d.productName) + (d.productCode ? ` (${d.productCode})` : ''));
  if (d.number) parts.push(`#${d.number}`);
  if (d.barcode) parts.push(`código ${d.barcode}`);
  if (d.daysPending) parts.push(`${d.daysPending} días pendiente`);
  if (d.movementId) parts.push(`movimiento #${d.movementId}`);
  if (d.type) parts.push(String(d.type));
  if (parts.length === 0) {
    return Object.entries(d)
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 60)}`)
      .join(' · ');
  }
  return parts.join(' · ');
}

export default function Reconciliation() {
  const toast = useToast();

  const [logs, setLogs] = useState<ReconciliationLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState('');
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);

  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ totalChecks: number; totalIssues: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ logs: ReconciliationLogRow[]; total: number }>(
        `/reconciliation/history${qs({ locationId, status, page, pageSize: 20 })}`
      );
      setLogs(res.logs);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, status, page]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<{ locations: Array<{ id: number; name: string }> }>('/locations')
      .then((r) => setLocations(r.locations))
      .catch(() => {});
  }, []);

  async function run() {
    setRunning(true);
    setLastRun(null);
    try {
      const body = locationId ? { locationId: Number(locationId) } : {};
      const res = await api<{ totalChecks: number; totalIssues: number }>('/reconciliation/run', {
        method: 'POST',
        body,
      });
      setLastRun(res);
      if (res.totalIssues === 0) toast.success('Conciliación sin inconsistencias 👍');
      else toast.error(`Conciliación con ${res.totalIssues} inconsistencia(s): revisá el historial`);
      setPage(1);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const columns: Column<ReconciliationLogRow>[] = [
    { key: 'run_at', label: 'Fecha', render: (l) => <span className="text-slate-600">{fmtDateTime(l.run_at)}</span> },
    {
      key: 'location', label: 'Ubicación',
      render: (l) => <span className="text-slate-600">{l.location_name ?? <span className="text-slate-400">Global</span>}</span>,
    },
    {
      key: 'check_type', label: 'Control',
      render: (l) => <span className="text-sm text-slate-700">{CHECK_LABEL[l.check_type] ?? l.check_type}</span>,
    },
    {
      key: 'status', label: 'Resultado',
      render: (l) => {
        const m = STATUS_META[l.status];
        return <Badge color={m.color}>{m.label}</Badge>;
      },
    },
    {
      key: 'values', label: 'Esperado / Real',
      render: (l) => (
        <span className="font-mono text-xs text-slate-600">
          {l.expected_value ?? '—'} / {l.actual_value ?? '—'}
          {l.difference != null && Number(l.difference) !== 0 && (
            <span className="ml-1 font-semibold text-red-500">({Number(l.difference) > 0 ? '+' : ''}{Number(l.difference)})</span>
          )}
        </span>
      ),
    },
    {
      key: 'details', label: 'Detalle',
      render: (l) => {
        const s = detailSummary(l.details);
        return s ? <span className="text-xs text-slate-500">{s}</span> : <span className="text-slate-300">—</span>;
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Reconciliación"
        subtitle="Chequeos de integridad del stock: saldos vs movimientos, transferencias en tránsito, entregas estancadas, stock negativo y movimientos huérfanos"
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()}>↻ Actualizar</Button>
            <Button loading={running} onClick={() => void run()}>
                {running ? 'Ejecutando…' : locationId ? '▶ Conciliar ubicación' : '▶ Conciliar todo'}
              </Button>
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Ubicación">
            <Select value={locationId} onChange={(e) => { setLocationId(e.target.value); setPage(1); }} className="w-56">
              <option value="">Todas / global</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Resultado">
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-48">
              <option value="">Todos</option>
              <option value="OK">OK</option>
              <option value="WARNING">Advertencia</option>
              <option value="ERROR">Error</option>
              <option value="FIXED">Corregido</option>
            </Select>
          </Field>
        </div>
      </Card>

      {lastRun && (
        <Card className={`mb-4 p-3 ${lastRun.totalIssues === 0 ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
          <p className="text-sm">
            Última corrida: <strong>{lastRun.totalChecks}</strong> controles ·{' '}
            <strong className={lastRun.totalIssues === 0 ? 'text-green-700' : 'text-amber-700'}>
              {lastRun.totalIssues} inconsistencia{lastRun.totalIssues === 1 ? '' : 's'}
            </strong>
            {lastRun.totalIssues > 0 && ' — cada inconsistencia genera además una alerta para ADMIN/ENCARGADO'}
          </p>
        </Card>
      )}

      <Card>
        <DataTable
          columns={columns}
          rows={logs}
          rowKey={(l) => l.id}
          loading={loading}
          pageSize={20}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="Sin historial"
          emptyHint="Ejecutá una conciliación para generar los primeros chequeos de integridad"
        />
      </Card>
    </div>
  );
}
