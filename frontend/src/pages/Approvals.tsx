import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, PageHeader, Select, Textarea, Modal } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

/** Fila de GET /api/approvals/requests (snake/db sin normalizar + requested_by_name). */
interface ApprovalRequestRow {
  id: number;
  rule_id: number;
  entity_type: string;
  entity_id: number;
  entity_number: string;
  requested_by: number;
  requested_at: string;
  status: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'EXPIRADO' | 'CANCELADO';
  context: Record<string, unknown> | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  expires_at: string | null;
  requested_by_name: string;
}

const STATUS_META: Record<ApprovalRequestRow['status'], { label: string; color: 'red' | 'green' | 'amber' | 'gray' | 'blue' }> = {
  PENDIENTE: { label: 'Pendiente', color: 'red' },
  APROBADO: { label: 'Aprobado', color: 'green' },
  RECHAZADO: { label: 'Rechazado', color: 'gray' },
  EXPIRADO: { label: 'Expirado', color: 'amber' },
  CANCELADO: { label: 'Cancelado', color: 'blue' },
};

const ENTITY_LABEL: Record<string, string> = {
  ENTRY: 'Entrada',
  DELIVERY: 'Entrega',
  TRANSFER: 'Transferencia',
  COUNT: 'Inventario',
  VOID: 'Anulación',
  STOCK_ADJUST: 'Ajuste de stock',
};

/** Enlace al documento original para resolverlo tras aprobar. */
function documentLink(r: ApprovalRequestRow): { to: string; label: string } | null {
  switch (r.entity_type) {
    case 'ENTRY': return { to: '/entradas', label: 'Ver entradas →' };
    case 'DELIVERY': return r.entity_id ? { to: `/entregas/${r.entity_id}`, label: `Entrega ${r.entity_number} →` } : null;
    case 'TRANSFER': return { to: '/transferencias', label: 'Ver transferencias →' };
    case 'COUNT': return { to: '/inventarios', label: 'Ver inventarios →' };
    default: return null;
  }
}

const CONTEXT_FIELDS: Record<string, string> = {
  qty_sum: 'Cantidad total',
  adjustments_count: 'Ajustes',
  lines_count: 'Productos',
  location_id: 'Ubicación',
  reason: 'Motivo',
};

function ContextSummary({ context }: { context: Record<string, unknown> | null }) {
  if (!context || Object.keys(context).length === 0) {
    return <p className="text-sm text-slate-400">Sin datos de contexto.</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {Object.entries(CONTEXT_FIELDS)
        .filter(([k]) => k in context)
        .map(([k, label]) => (
          <li key={k} className="flex justify-between gap-4">
            <span className="text-slate-400">{label}</span>
            <span className="font-medium text-slate-700">{String(context[k]).slice(0, 200)}</span>
          </li>
        ))}
      {/* Campos restantes que no están en el mapeo (p. ej. items) */}
      {Object.keys(context)
        .filter((k) => !(k in CONTEXT_FIELDS))
        .map((k) => (
          <li key={k} className="flex justify-between gap-4">
            <span className="text-slate-400">{k}</span>
            <span className="font-mono text-xs text-slate-500">{JSON.stringify(context[k]).slice(0, 120)}</span>
          </li>
        ))}
    </ul>
  );
}

export default function Approvals() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const [rows, setRows] = useState<ApprovalRequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('PENDIENTE');
  const [entityType, setEntityType] = useState('');
  const [acting, setActing] = useState<number | null>(null);

  const [detail, setDetail] = useState<ApprovalRequestRow | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [notes, setNotes] = useState('');
  const [resolving, setResolving] = useState(false);

  const canApprove = can('approvals.approve');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ requests: ApprovalRequestRow[]; total: number }>(
        `/approvals/requests${qs({ status, entityType, page, pageSize: 20 })}`
      );
      setRows(res.requests);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, entityType, page]);

  useEffect(() => { void load(); }, [load]);

  async function resolve() {
    if (!detail || !decision) return;
    setResolving(true);
    try {
      await api(`/approvals/requests/${detail.id}/resolve`, {
        method: 'POST',
        body: { action: decision, notes: notes.trim() || undefined },
      });
      toast.success(decision === 'APPROVE' ? 'Solicitud aprobada: ya podés confirmar el documento' : 'Solicitud rechazada');
      setDetail(null);
      setDecision(null);
      setNotes('');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function cancel(r: ApprovalRequestRow) {
    setActing(r.id);
    try {
      await api(`/approvals/requests/${r.id}/cancel`, { method: 'POST', body: {} });
      toast.success('Solicitud cancelada');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  const columns: Column<ApprovalRequestRow>[] = [
    {
      key: 'entity_type', label: 'Documento',
      render: (r) => (
        <div>
          <Badge color="blue">{ENTITY_LABEL[r.entity_type] ?? r.entity_type}</Badge>
          <div className="mt-1 font-mono text-xs font-semibold text-brand-700">{r.entity_number}</div>
        </div>
      ),
    },
    {
      key: 'requested_by_name', label: 'Solicitado por',
      render: (r) => (
        <div>
          <div className="text-slate-700">{r.requested_by_name}</div>
          <div className="text-xs text-slate-400">{fmtDateTime(r.requested_at)}</div>
        </div>
      ),
    },
    {
      key: 'expires_at', label: 'Vence',
      render: (r) => r.expires_at
        ? <span className={new Date(r.expires_at) < new Date() ? 'text-red-500' : 'text-slate-500'}>{fmtDateTime(r.expires_at)}</span>
        : <span className="text-slate-300">—</span>,
    },
    {
      key: 'status', label: 'Estado',
      render: (r) => {
        const m = STATUS_META[r.status];
        return <Badge color={m.color}>{m.label}</Badge>;
      },
    },
    { key: 'resolution_notes', label: 'Resolución', render: (r) => r.resolution_notes ? <span className="text-slate-500">{r.resolution_notes}</span> : <span className="text-slate-300">—</span> },
    {
      key: 'actions', label: 'Acciones', render: (r) => {
        if (r.status === 'PENDIENTE' && canApprove) {
          return (
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="success" onClick={() => { setDetail(r); setDecision('APPROVE'); setNotes(''); }}>✅ Aprobar</Button>
              <Button size="sm" variant="danger" onClick={() => { setDetail(r); setDecision('REJECT'); setNotes(''); }}>✗ Rechazar</Button>
              <Button size="sm" variant="ghost" disabled={acting === r.id} onClick={() => void cancel(r)}>Cancelar</Button>
            </div>
          );
        }
        return (
          <Button size="sm" variant="secondary" onClick={() => { setDetail(r); setDecision(null); setNotes(''); }}>
            Detalle
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Aprobaciones"
        subtitle="Solicitudes de aprobación generadas por reglas de negocio: entradas, entregas, transferencias e inventarios grandes"
        actions={<Button variant="secondary" onClick={() => void load()}>↻ Actualizar</Button>}
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-48">
            <option value="">Todos los estados</option>
            <option value="PENDIENTE">Pendientes</option>
            <option value="APROBADO">Aprobadas</option>
            <option value="RECHAZADO">Rechazadas</option>
            <option value="EXPIRADO">Expiradas</option>
            <option value="CANCELADO">Canceladas</option>
          </Select>
          <Select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} className="w-48">
            <option value="">Todo tipo de documento</option>
            <option value="ENTRY">Entradas</option>
            <option value="DELIVERY">Entregas</option>
            <option value="TRANSFER">Transferencias</option>
            <option value="COUNT">Inventarios</option>
            <option value="VOID">Anulaciones</option>
            <option value="STOCK_ADJUST">Ajustes de stock</option>
          </Select>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          pageSize={20}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay solicitudes"
          emptyHint={status === 'PENDIENTE' ? 'No tenés aprobaciones pendientes 👍' : 'Probá cambiar los filtros'}
        />
      </Card>

      {/* Detalle / decisión */}
      <Modal
        open={!!detail}
        onClose={() => { setDetail(null); setDecision(null); }}
        title={detail ? `Solicitud #${detail.id} — ${DETAIL_TITLE(detail)}` : 'Solicitud'}
        width="md"
        footer={
          decision ? (
            <>
              <Button variant="secondary" disabled={resolving} onClick={() => { setDetail(null); setDecision(null); }}>Cancelar</Button>
              {decision === 'APPROVE' ? (
                <Button variant="success" loading={resolving} onClick={() => void resolve()}>✅ Confirmar aprobación</Button>
              ) : (
                <Button variant="danger" loading={resolving} disabled={notes.trim().length < 5} onClick={() => void resolve()}>
                  Rechazar (mínimo 5 caracteres de motivo)
                </Button>
              )}
            </>
          ) : (
            <Button variant="secondary" onClick={() => { setDetail(null); }}>Cerrar</Button>
          )
        }
      >
        {detail && (
          <div className="space-y-3">
            {decision && (
              <p className={`rounded-lg p-2.5 text-sm ${decision === 'APPROVE' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                {decision === 'APPROVE'
                  ? 'Al aprobar, el documento queda listo para confirmar (stock aún no cambia).'
                  : 'Al rechazar, la solicitud queda cerrada: el borrador no podrá confirmarse hasta reconsiderar la regla.'}
              </p>
            )}
            <div className="rounded-lg bg-slate-50 p-3">
              <ContextSummary context={detail.context} />
            </div>
            {(() => {
              const link = documentLink(detail);
              return link
                ? <Link className="text-sm text-brand-600 hover:underline" to={link.to}>{link.label}</Link>
                : null;
            })()}
            {decision && (
              <Field label={decision === 'REJECT' ? 'Motivo del rechazo' : 'Notas (opcional)'} required={decision === 'REJECT'}>
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function DETAIL_TITLE(r: ApprovalRequestRow): string {
  return `${ENTITY_LABEL[r.entity_type] ?? r.entity_type} ${r.entity_number}`;
}
