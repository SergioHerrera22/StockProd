import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

/** Alerta tal como la devuelve GET /api/alerts (camelCase por mapAlert). */
interface AlertRow {
  id: number;
  code: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  entityType: string | null;
  entityId: number | null;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  status: 'PENDIENTE' | 'VISTA' | 'RESUELTA' | 'DESCARTADA';
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  ackByName?: string | null;
  resByName?: string | null;
}

const SEVERITY_META: Record<AlertRow['severity'], { label: string; color: 'red' | 'amber' | 'blue' }> = {
  CRITICAL: { label: 'Crítica', color: 'red' },
  WARNING: { label: 'Atención', color: 'amber' },
  INFO: { label: 'Info', color: 'blue' },
};

const STATUS_META: Record<AlertRow['status'], { label: string; color: 'red' | 'amber' | 'green' | 'gray' }> = {
  PENDIENTE: { label: 'Pendiente', color: 'red' },
  VISTA: { label: 'Vista', color: 'amber' },
  RESUELTA: { label: 'Resuelta', color: 'green' },
  DESCARTADA: { label: 'Descartada', color: 'gray' },
};

/** Enlace de destino según el origen de la alerta (clic directo a resolver). */
function entityLink(a: AlertRow): { to: string; label: string } | null {
  switch (a.entityType) {
    case 'DELIVERY': return a.entityId ? { to: `/entregas/${a.entityId}`, label: `Entrega #${a.entityId} →` } : null;
    case 'TRANSFER': return { to: '/transferencias', label: 'Transferencias →' };
    case 'PENDING_DELIVERY': return { to: '/reservas', label: 'Reservas de retiro →' };
    case 'ENTRY': return a.entityId ? { to: '/entradas', label: `Entrada #${a.entityId} →` } : null;
    case 'PRODUCT': return { to: '/productos', label: 'Productos →' };
    case 'LOCATION': return { to: '/ubicaciones', label: 'Ubicaciones →' };
    case 'USER': return { to: '/usuarios', label: 'Usuarios →' };
    default: return null;
  }
}

export default function Alerts() {
  const toast = useToast();
  const { can } = useAuth();
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('PENDIENTE');
  const [severity, setSeverity] = useState('');
  const [acting, setActing] = useState<number | null>(null);
  const canManage = can('alerts.manage');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ alerts: AlertRow[]; total: number }>(
        `/alerts${qs({ status, severity, page, pageSize: 20 })}`
      );
      setRows(res.alerts);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, severity, page]);

  useEffect(() => { void load(); }, [load]);

  async function act(a: AlertRow, action: 'acknowledge' | 'resolve' | 'dismiss') {
    setActing(a.id);
    try {
      await api(`/alerts/${a.id}/${action}`, { method: 'POST', body: {} });
      toast.success(action === 'acknowledge' ? 'Alerta marcada como vista' : action === 'resolve' ? 'Alerta resuelta' : 'Alerta descartada');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  const columns: Column<AlertRow>[] = [
    {
      key: 'severity', label: 'Gravedad', render: (a) => {
        const m = SEVERITY_META[a.severity] ?? { label: a.severity, color: 'blue' as const };
        return <Badge color={m.color}>{m.label}</Badge>;
      },
    },
    {
      key: 'title', label: 'Alerta', render: (a) => (
        <div className="max-w-[320px]">
          <div className="font-medium text-slate-700">{a.title}</div>
          <div className="text-xs text-slate-500">{a.message}</div>
        </div>
      ),
    },
    {
      key: 'origin', label: 'Origen', render: (a) => {
        const link = entityLink(a);
        if (!link) return <span className="text-slate-300">—</span>;
        return <Link className="text-brand-600 hover:underline" to={link.to}>{link.label}</Link>;
      },
    },
    {
      key: 'status', label: 'Estado', render: (a) => {
        const m = STATUS_META[a.status];
        return <Badge color={m.color}>{m.label}</Badge>;
      },
    },
    { key: 'created_at', label: 'Fecha', render: (a) => <span className="text-slate-500">{fmtDateTime(a.createdAt)}</span> },
    {
      key: 'actions', label: 'Acciones', render: (a) => {
        if (!canManage || a.status === 'RESUELTA' || a.status === 'DESCARTADA') {
          return <span className="text-slate-300">—</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {a.status === 'PENDIENTE' && (
              <Button size="sm" variant="ghost" disabled={acting === a.id} onClick={() => void act(a, 'acknowledge')}>
                Vista
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={acting === a.id} onClick={() => void act(a, 'resolve')}>
              Resolver
            </Button>
            <Button size="sm" variant="ghost" disabled={acting === a.id} onClick={() => void act(a, 'dismiss')}>
              Descartar
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Alertas"
        subtitle="Avisos del sistema: stock bajo, transferencias atrasadas, llegadas de mercadería y más"
        actions={
          <Button variant="secondary" onClick={() => void load()}>↻ Actualizar</Button>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
            <option value="">Todos los estados</option>
            <option value="PENDIENTE">Pendientes</option>
            <option value="VISTA">Vistas</option>
            <option value="RESUELTA">Resueltas</option>
            <option value="DESCARTADA">Descartadas</option>
          </Select>
          <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} className="w-40">
            <option value="">Toda gravedad</option>
            <option value="CRITICAL">Críticas</option>
            <option value="WARNING">Atención</option>
            <option value="INFO">Info</option>
          </Select>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          loading={loading}
          pageSize={20}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay alertas"
          emptyHint={status === 'PENDIENTE' ? 'No tenés alertas pendientes 👍' : 'Probá cambiar los filtros'}
        />
      </Card>
    </div>
  );
}
