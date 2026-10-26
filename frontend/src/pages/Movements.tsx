import { useCallback, useEffect, useState } from 'react';
import { api, downloadCsv, qs } from '../lib/api';
import { exportCSV, fmtDateTime, fmtQty, todayISO } from '../lib/format';
import type { Location, Movement } from '../types';
import { Badge, Button, Card, Input, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

const TYPES: { value: string; label: string }[] = [
  { value: '', label: 'Todos los tipos' },
  { value: 'ENTRADA', label: 'Entrada' },
  { value: 'SALIDA', label: 'Salida (entrega)' },
  { value: 'TRANS_SALIDA', label: 'Envío a transferencia' },
  { value: 'TRANS_ENTRADA', label: 'Recepción de transferencia' },
  { value: 'AJUSTE_POS', label: 'Ajuste positivo' },
  { value: 'AJUSTE_NEG', label: 'Ajuste negativo' },
];

const TYPE_META: Record<string, { label: string; color: 'green' | 'red' | 'amber' | 'blue' | 'violet' }> = {
  ENTRADA: { label: 'Entrada', color: 'green' },
  SALIDA: { label: 'Salida', color: 'red' },
  AJUSTE_POS: { label: 'Ajuste +', color: 'amber' },
  AJUSTE_NEG: { label: 'Ajuste −', color: 'amber' },
  TRANS_SALIDA: { label: 'Envío', color: 'blue' },
  TRANS_ENTRADA: { label: 'Recepción', color: 'violet' },
};

const REF_LABEL: Record<string, string> = {
  DELIVERY: 'Entrega',
  ENTRY: 'Entrada',
  TRANSFER: 'Transfer.',
  COUNT: 'Inventario',
  MANUAL: 'Manual',
};

export default function Movements() {
  const toast = useToast();
  const [rows, setRows] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [locationId, setLocationId] = useState('');
  const [type, setType] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [users, setUsers] = useState<{ id: number; full_name: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ movements: Movement[]; total: number }>(
        `/movements${qs({ q, locationId, type, userId, from, to, page, pageSize: 30 })}`
      );
      setRows(res.movements);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, locationId, type, userId, from, to, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    api<{ users: { id: number; full_name: string }[] }>('/movements/users').then((r) => setUsers(r.users)).catch(() => {});
  }, []);

  function clearFilters() {
    setQ(''); setLocationId(''); setType(''); setUserId(''); setFrom(''); setTo('');
    setPage(1);
  }

  const columns: Column<Movement>[] = [
    { key: 'created_at', label: 'Fecha y hora', sortable: true, render: (m) => fmtDateTime(m.created_at) },
    {
      key: 'product_name', label: 'Producto', sortable: true,
      render: (m) => (
        <div>
          <div className="font-medium text-slate-700">{m.product_name}</div>
          <div className="font-mono text-xs text-slate-400">{m.product_code}</div>
        </div>
      ),
    },
    { key: 'location_name', label: 'Ubicación', render: (m) => m.location_name },
    {
      key: 'type', label: 'Tipo', render: (m) => {
        const meta = TYPE_META[m.type] ?? { label: m.type, color: 'green' as const };
        return <Badge color={meta.color}>{meta.label}</Badge>;
      },
    },
    {
      key: 'quantity', label: 'Cant.', align: 'right', sortable: true,
      render: (m) => {
        const negative = ['SALIDA', 'AJUSTE_NEG', 'TRANS_SALIDA'].includes(m.type);
        return (
          <span className={`font-semibold ${negative ? 'text-red-600' : 'text-emerald-600'}`}>
            {negative ? '−' : '+'}{fmtQty(m.quantity)} {m.unit.toLowerCase()}
          </span>
        );
      },
    },
    {
      key: 'balance_after', label: 'Saldo →', align: 'right',
      render: (m) => <span className="text-slate-500">{fmtQty(m.balance_before)} → <strong className="text-slate-700">{fmtQty(m.balance_after)}</strong></span>,
    },
    {
      key: 'reference_number', label: 'Documento',
      render: (m) => (
        m.reference_number
          ? <span className="font-mono text-xs text-brand-600">{REF_LABEL[m.reference_type] ?? ''} {m.reference_number}</span>
          : '—'
      ),
    },
    { key: 'user_name', label: 'Usuario', render: (m) => m.user_name },
  ];

  return (
    <div>
      <PageHeader
        title="Historial de movimientos"
        subtitle={`${total} movimientos registrados`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() =>
                exportCSV(
                  'movimientos.csv',
                  ['Fecha', 'Producto', 'Código', 'Ubicación', 'Tipo', 'Cantidad', 'Saldo anterior', 'Saldo posterior', 'Documento', 'Usuario', 'Motivo'],
                  rows.map((m) => [fmtDateTime(m.created_at), m.product_name, m.product_code, m.location_name, m.type, m.quantity, m.balance_before, m.balance_after, m.reference_number, m.user_name, m.reason])
                )
              }
            >
              ⬇ Exportar página
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Libro completo (hasta 10.000 filas) con los MISMOS filtros activos
                toast.info('Generando CSV completo…');
                downloadCsv(
                  `/movements/export.csv${qs({ q, locationId, type, userId, from, to })}`,
                  'movimientos-completo.csv'
                ).then(() => toast.success('CSV descargado')).catch((e) => toast.error((e as Error).message));
              }}
              title="Descarga todo el libro de movimientos (hasta 10.000 filas) aplicando los filtros de esta pantalla"
            >
              ⬇ Exportar todo
            </Button>
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Producto, documento o motivo…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="min-w-[180px] flex-1" />
          <Select value={locationId} onChange={(e) => { setLocationId(e.target.value); setPage(1); }} className="w-44">
            <option value="">Todas las ubicaciones</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-52">
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Select value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} className="w-44">
            <option value="">Todos los usuarios</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <div className="flex items-center gap-1 text-xs text-slate-400">
            Desde
            <Input type="date" max={todayISO()} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-36" />
            Hasta
            <Input type="date" max={todayISO()} value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-36" />
          </div>
          <Button variant="ghost" size="sm" onClick={clearFilters}>Limpiar</Button>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(m) => m.id}
          loading={loading}
          pageSize={30}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay movimientos"
          emptyHint="Probá ajustar los filtros"
        />
      </Card>
    </div>
  );
}
