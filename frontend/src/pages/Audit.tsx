import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { AuditRow } from '../types';
import { Badge, Card, Input, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

const ACTION_COLORS: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'gray'> = {
  LOGIN: 'gray',
  DELIVERY_CONFIRM: 'red',
  DELIVERY_VOID: 'red',
  ENTRY_CONFIRM: 'green',
  ENTRY_VOID: 'red',
  TRANSFER_CREATE: 'blue',
  TRANSFER_RECEIVE: 'violet',
  TRANSFER_VOID: 'red',
  COUNT_APPLY: 'amber',
  PRODUCT_CREATE: 'green',
  PRODUCT_UPDATE: 'blue',
  PRODUCT_IMPORT: 'blue',
  USER_CREATE: 'violet',
  USER_UPDATE: 'violet',
  USER_RESET_PASSWORD: 'violet',
};

export default function Audit() {
  const toast = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ logs: AuditRow[]; total: number }>(`/audit${qs({ action, entity, page, pageSize: 30 })}`);
      setRows(res.logs);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, entity, page]);

  useEffect(() => { void load(); }, [load]);

  const columns: Column<AuditRow>[] = [
    { key: 'created_at', label: 'Fecha', sortable: true, render: (r) => fmtDateTime(r.created_at) },
    { key: 'user_name', label: 'Usuario', render: (r) => r.user_name ?? r.username ?? '—' },
    { key: 'action', label: 'Acción', render: (r) => <Badge color={ACTION_COLORS[r.action] ?? 'gray'}>{r.action}</Badge> },
    { key: 'entity', label: 'Entidad', render: (r) => `${r.entity}${r.entity_id ? ` #${r.entity_id}` : ''}` },
    {
      key: 'details', label: 'Detalle',
      render: (r) => {
        if (!r.details) return '—';
        const s = JSON.stringify(r.details);
        return <span className="max-w-[280px] truncate text-xs text-slate-400" title={s}>{s}</span>;
      },
    },
    { key: 'ip', label: 'IP', render: (r) => <span className="font-mono text-xs text-slate-400">{r.ip ?? '—'}</span> },
  ];

  return (
    <div>
      <PageHeader title="Auditoría" subtitle={`${total} operaciones sensibles registradas`} />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar acción (ej: DELIVERY)…"
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            className="min-w-[200px] flex-1"
          />
          <Select value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} className="w-44">
            <option value="">Todas las entidades</option>
            <option value="delivery">Entregas</option>
            <option value="entry">Entradas</option>
            <option value="transfer">Transferencias</option>
            <option value="count">Inventarios</option>
            <option value="product">Productos</option>
            <option value="user">Usuarios</option>
            <option value="location">Ubicaciones</option>
          </Select>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          pageSize={30}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="Sin registros de auditoría"
        />
      </Card>
    </div>
  );
}
