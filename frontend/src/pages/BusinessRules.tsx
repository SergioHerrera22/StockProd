import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../store/auth';
import {
  Badge, Button, Card, Field, FormRow, Input, Modal, PageHeader, Select, Tabs, Textarea,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

const ENTITY_TYPES = ['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST'] as const;
const TRIGGER_EVENTS = [
  { value: 'BEFORE_CREATE', label: 'Al crear (borrador)' },
  { value: 'BEFORE_CONFIRM', label: 'Al confirmar (antes de tocar stock)' },
  { value: 'BEFORE_RECEIVE', label: 'Al recibir' },
  { value: 'BEFORE_VOID', label: 'Al anular' },
  { value: 'BEFORE_APPLY', label: 'Al aplicar (inventario)' },
  { value: 'BEFORE_ADJUST', label: 'Al ajustar' },
] as const;
const ENTITY_LABEL: Record<string, string> = {
  TRANSFER: 'Transferencia', DELIVERY: 'Entrega', ENTRY: 'Entrada',
  COUNT: 'Inventario', VOID: 'Anulación', STOCK_ADJUST: 'Ajuste de stock', PRODUCT: 'Producto',
};
const SEVERITY_META: Record<string, { label: string; color: 'blue' | 'amber' | 'red' }> = {
  INFO: { label: 'Info', color: 'blue' },
  WARNING: { label: 'Atención', color: 'amber' },
  BLOCKING: { label: 'Bloqueante', color: 'red' },
};
const METRIC_LABEL: Record<string, string> = {
  qty_sum: 'Cantidad total',
  value_sum: 'Valor total',
  lines_count: 'Cantidad de líneas',
  days_in_transit: 'Días en tránsito',
  pending_hours: 'Horas pendientes',
  stock_below_min: 'Stock por debajo del mínimo',
  void_count_per_user_day: 'Anulaciones por usuario/día',
};

interface RuleRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  entity_type: string;
  trigger_event: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  severity: string;
  is_active: boolean;
  created_at: string;
}

interface ThresholdRow {
  id: number;
  location_id: number | null;
  entity_type: string;
  metric: string;
  threshold_value: string | number;
  threshold_operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ';
  action: Record<string, unknown>;
  is_active: boolean;
}

const OP_LABEL: Record<ThresholdRow['threshold_operator'], string> = {
  GT: '> mayor a', GTE: '≥ mayor o igual a', LT: '< menor a', LTE: '≤ menor o igual a', EQ: '= igual a',
};

/** Traduce la condición JSON a lenguaje natural (claves _gt/_gte/_eq...). */
function conditionText(cond: Record<string, unknown>): string {
  if (!cond || Object.keys(cond).length === 0) return 'Siempre (todas las operaciones)';
  return Object.entries(cond)
    .map(([k, v]) => {
      if (k.endsWith('_gt')) return `${k.slice(0, -3)} > ${v}`;
      if (k.endsWith('_gte')) return `${k.slice(0, -4)} ≥ ${v}`;
      if (k.endsWith('_lt')) return `${k.slice(0, -3)} < ${v}`;
      if (k.endsWith('_lte')) return `${k.slice(0, -4)} ≤ ${v}`;
      if (k.endsWith('_eq')) return `${k.slice(0, -3)} = ${v}`;
      if (k.endsWith('_in')) return `${k.slice(0, -3)} en [${String(v)}]`;
      return `${k} = ${v}`;
    })
    .join(' y ');
}

function actionText(action: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (action?.require_approval) out.push('Exige aprobación (ENCARGADO o superior)');
  if (action?.alert) out.push(`Genera alerta${action?.alert_code ? ` (${action.alert_code})` : ''}`);
  if (action?.block) out.push('Bloquea la operación');
  return out.length ? out : ['Ninguna'];
}

// ===== Formulario de regla =====
interface RuleForm {
  id?: number;
  code: string;
  name: string;
  description: string;
  entityType: string;
  triggerEvent: string;
  severity: 'INFO' | 'WARNING' | 'BLOCKING';
  // "Si cantidad total > X"
  field: 'qty_sum' | 'lines_count' | 'value_sum';
  operator: '>' | '>=' | '=' ;
  threshold: string;
  requireApproval: boolean;
  alert: boolean;
  alertCode: string;
}

const EMPTY_RULE: RuleForm = {
  code: '', name: '', description: '', entityType: 'ENTRY', triggerEvent: 'BEFORE_CONFIRM',
  severity: 'WARNING', field: 'qty_sum', operator: '>', threshold: '', requireApproval: true, alert: false, alertCode: '',
};

function ruleToForm(r: RuleRow): RuleForm {
  const condition = r.condition ?? {};
  const [field, op] = Object.entries(condition).find(([k]) => k.endsWith('_gt') || k.endsWith('_gte') || k.endsWith('_eq')) ?? ['qty_sum', '_gt'];
  const ops: Record<string, RuleForm['operator']> = { _gt: '>', _gte: '>=', _eq: '=' };
  return {
    id: r.id, code: r.code, name: r.name, description: r.description ?? '',
    entityType: r.entity_type, triggerEvent: r.trigger_event,
    severity: (r.severity as RuleForm['severity']) ?? 'WARNING',
    field: (field as unknown as RuleForm['field']),
    operator: ops[op as string] ?? '>',
    threshold: String((r.condition ?? {})[field] ?? ''),
    requireApproval: Boolean(r.action?.require_approval),
    alert: Boolean(r.action?.alert),
    alertCode: String(r.action?.alert_code ?? ''),
  };
}

function formToPayload(f: RuleForm) {
  const condition: Record<string, unknown> = {};
  if (f.threshold !== '') {
    if (f.operator === '>') condition[`${f.field}_gt`] = Number(f.threshold);
    else if (f.operator === '>=') condition[`${f.field}_gte`] = Number(f.threshold);
    else condition[`${f.field}_eq`] = Number(f.threshold);
  }
  const action: Record<string, unknown> = {};
  if (f.requireApproval) action.require_approval = true;
  if (f.alert) { action.alert = true; action.alert_code = f.alertCode.trim() || undefined; }
  return {
    code: f.code.trim(), name: f.name.trim(), description: f.description.trim() || undefined,
    entityType: f.entityType, triggerEvent: f.triggerEvent, condition, action, severity: f.severity,
  };
}

export default function BusinessRules() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const canWrite = can('settings.write');

  const [tab, setTab] = useState<'rules' | 'thresholds'>('rules');
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [ruleTotal, setRuleTotal] = useState(0);
  const [rulePage, setRulePage] = useState(1);
  const [loadingRules, setLoadingRules] = useState(true);
  const [ruleEntity, setRuleEntity] = useState('');
  const [actingRule, setActingRule] = useState<number | null>(null);

  const [thresholds, setThresholds] = useState<ThresholdRow[]>([]);
  const [thTotal, setThTotal] = useState(0);
  const [thPage, setThPage] = useState(1);
  const [loadingTh, setLoadingTh] = useState(false);
  const [thEntity, setThEntity] = useState('');
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);

  const [form, setForm] = useState<RuleForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [thForm, setThForm] = useState<ThresholdRow | null>(null);

  const loadRules = useCallback(async () => {
    setLoadingRules(true);
    try {
      const res = await api<{ rules: RuleRow[]; total: number }>(`/business-rules${qs({ entityType: ruleEntity, page: rulePage, pageSize: 20 })}`);
      setRules(res.rules);
      setRuleTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingRules(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleEntity, rulePage]);

  const loadThresholds = useCallback(async () => {
    setLoadingTh(true);
    try {
      const res = await api<{ thresholds: ThresholdRow[]; total: number }>(`/business-rules/thresholds${qs({ entityType: thEntity, page: thPage, pageSize: 20 })}`);
      setThresholds(res.thresholds);
      setThTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingTh(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thEntity, thPage]);

  useEffect(() => { void loadRules(); }, [loadRules]);
  useEffect(() => {
    if (tab === 'thresholds') void loadThresholds();
  }, [tab, loadThresholds]);
  useEffect(() => {
    api<{ locations: Array<{ id: number; name: string }> }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  async function saveRule() {
    if (!form) return;
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (form.id) await api(`/business-rules/${form.id}`, { method: 'PATCH', body: payload });
      else await api('/business-rules', { method: 'POST', body: payload });
      toast.success(form.id ? 'Regla actualizada' : 'Regla creada');
      setForm(null);
      void loadRules();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(r: RuleRow) {
    setActingRule(r.id);
    try {
      await api(`/business-rules/${r.id}`, { method: 'PATCH', body: { isActive: !r.is_active } });
      toast.success(r.is_active ? 'Regla desactivada' : 'Regla activada');
      void loadRules();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActingRule(null);
    }
  }

  async function saveThreshold() {
    if (!thForm) return;
    setSaving(true);
    try {
      await api('/business-rules/thresholds', {
        method: 'POST',
        body: {
          ...(thForm.location_id ? { locationId: thForm.location_id } : {}),
          entityType: thForm.entity_type,
          metric: thForm.metric,
          thresholdValue: Number(thForm.threshold_value),
          thresholdOperator: thForm.threshold_operator,
          action: thForm.action ?? {},
        },
      });
      toast.success('Umbral guardado');
      setThForm(null);
      void loadThresholds();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteThreshold(id: number) {
    setActingRule(id);
    try {
      await api(`/business-rules/thresholds/${id}`, { method: 'DELETE' });
      toast.success('Umbral eliminado');
      void loadThresholds();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActingRule(null);
    }
  }

  const ruleColumns: Column<RuleRow>[] = [
    {
      key: 'name', label: 'Regla',
      render: (r) => (
        <div className="max-w-[300px]">
          <div className="font-medium text-slate-700">{r.name}</div>
          <div className="font-mono text-xs text-slate-400">{r.code}</div>
        </div>
      ),
    },
    { key: 'scope', label: 'Alcance', render: (r) => (
      <div className="text-sm text-slate-600">
        {ENTITY_LABEL[r.entity_type] ?? r.entity_type}
        <div className="text-xs text-slate-400">
          {TRIGGER_EVENTS.find((t) => t.value === r.trigger_event)?.label ?? r.trigger_event}
        </div>
      </div>
    ) },
    { key: 'cond', label: 'Condición', render: (r) => <span className="text-sm text-slate-600">{conditionText(r.condition)}</span> },
    { key: 'act', label: 'Acción', render: (r) => (
      <div className="space-y-0.5 text-sm text-slate-600">
        {actionText(r.action).map((t) => <div key={t}>{t}</div>)}
        {r.severity && <Badge color={SEVERITY_META[r.severity]?.color ?? 'gray'}>{SEVERITY_META[r.severity]?.label ?? r.severity}</Badge>}
      </div>
    ) },
    { key: 'is_active', label: 'Estado', render: (r) => r.is_active ? <Badge color="green">Activa</Badge> : <Badge color="gray">Desactivada</Badge> },
    {
      key: 'actions', label: canWrite ? 'Acciones' : '', render: (r) => {
        if (!canWrite) return null;
        return (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" onClick={() => setForm(ruleToForm(r))}>Editar</Button>
            <Button size="sm" variant="ghost" disabled={actingRule === r.id} onClick={() => void toggleRule(r)}>
              {r.is_active ? 'Desactivar' : 'Activar'}
            </Button>
          </div>
        );
      },
    },
  ];

  const thColumns: Column<ThresholdRow>[] = [
    { key: 'scope', label: 'Alcance', render: (t) => (
      <div className="text-sm text-slate-600">
        {ENTITY_LABEL[t.entity_type] ?? t.entity_type}
        <div className="text-xs text-slate-400">{t.location_id ? `Solo en ${locations.find((l) => l.id === t.location_id)?.name ?? `ubicación #${t.location_id}`}` : 'Global (todas)'}</div>
      </div>
    ) },
    { key: 'metric', label: 'Métrica', render: (t) => <span className="text-sm text-slate-600">{METRIC_LABEL[t.metric] ?? t.metric}</span> },
    { key: 'limit', label: 'Umbral', render: (t) => (
      <span className="text-sm text-slate-600">{OP_LABEL[t.threshold_operator]} <strong>{t.threshold_value}</strong></span>
    ) },
    { key: 'is_active', label: 'Estado', render: (t) => t.is_active ? <Badge color="green">Activo</Badge> : <Badge color="gray">Desactivado</Badge> },
    {
      key: 'actions', label: canWrite ? 'Acciones' : '', render: (t) => {
        if (!canWrite) return null;
        return (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" onClick={() => setThForm(t)}>Editar</Button>
            <Button size="sm" variant="ghost" disabled={actingRule === t.id} onClick={() => void deleteThreshold(t.id)}>Eliminar</Button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Reglas de negocio"
        subtitle="Controles antifraude: cuándo exigir aprobación doble, alertas o bloqueos según el contexto de cada operación"
        actions={
          canWrite && tab === 'rules' && <Button onClick={() => setForm({ ...EMPTY_RULE })}>+ Nueva regla</Button>
        }
      />

      <Tabs
        tabs={[{ key: 'rules', label: `Reglas (${ruleTotal})` }, { key: 'thresholds', label: `Umbrales de control (${thTotal})` }]}
        value={tab}
        onChange={(v) => setTab(v as 'rules' | 'thresholds')}
      />

      {tab === 'rules' && (
        <>
          <Card className="mb-4 p-3">
            <Select value={ruleEntity} onChange={(e) => { setRuleEntity(e.target.value); setRulePage(1); }} className="w-56">
              <option value="">Todos los tipos de documento</option>
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_LABEL[t]}</option>)}
            </Select>
          </Card>
          <Card>
            <DataTable
              columns={ruleColumns}
              rows={rules}
              rowKey={(r) => r.id}
              loading={loadingRules}
              pageSize={20}
              total={ruleTotal}
              page={rulePage}
              onPageChange={setRulePage}
              emptyTitle="No hay reglas"
              emptyHint={canWrite ? 'Creá la primera regla de control' : 'Pedí al administrador que configure las reglas'}
            />
          </Card>
        </>
      )}

      {tab === 'thresholds' && (
        <>
          <Card className="mb-4 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={thEntity} onChange={(e) => { setThEntity(e.target.value); setThPage(1); }} className="w-56">
                <option value="">Todos los tipos</option>
                {[...ENTITY_TYPES, 'PRODUCT'].map((t) => <option key={t} value={t}>{ENTITY_LABEL[t]}</option>)}
              </Select>
              {canWrite && (
                <Button
                  onClick={() => setThForm({ id: 0, location_id: null, entity_type: thEntity || 'ENTRY', metric: 'qty_sum', threshold_value: '', threshold_operator: 'GTE', action: { alert: true }, is_active: true })}
                >
                  + Nueva métrica de control
                </Button>
              )}
            </div>
          </Card>
          <Card>
            <DataTable
              columns={thColumns}
              rows={thresholds}
              rowKey={(t) => t.id}
              loading={loadingTh}
              pageSize={20}
              total={thTotal}
              page={thPage}
              onPageChange={setThPage}
              emptyTitle="No hay umbrales"
              emptyHint="Los umbrales generan alertas automáticamente cuando una métrica supera el límite"
            />
          </Card>
        </>
      )}

      {/* Formulario de regla */}
      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? `Editar regla ${form.code}` : 'Nueva regla de negocio'}
        width="lg"
        footer={
          <>
            <Button variant="secondary" disabled={saving} onClick={() => setForm(null)}>Cancelar</Button>
            <Button variant="success" loading={saving} disabled={!form?.code.trim() || !form?.name.trim()} onClick={() => void saveRule()}>
              Guardar
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-3">
            <FormRow cols={2}>
              <Field label="Código interno" required>
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} placeholder="p. ej. ENTRY_QT_ALTA" />
              </Field>
              <Field label="Severidad">
                <Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as RuleForm['severity'] })}>
                  <option value="INFO">Info</option>
                  <option value="WARNING">Atención</option>
                  <option value="BLOCKING">Bloqueante</option>
                </Select>
              </Field>
            </FormRow>
            <Field label="Nombre visible" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="p. ej. Entradas grandes exigen aprobación" />
            </Field>
            <Field label="Descripción">
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <FormRow cols={2}>
              <Field label="Tipo de documento" required>
                <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
                  {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_LABEL[t]}</option>)}
                </Select>
              </Field>
              <Field label="Momento" required>
                <Select value={form.triggerEvent} onChange={(e) => setForm({ ...form, triggerEvent: e.target.value })}>
                  {TRIGGER_EVENTS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
            </FormRow>
            <Card className="p-3">
              <p className="mb-2 text-sm font-semibold text-slate-600">Condición</p>
              <FormRow cols={3}>
                <Field label="Campo">
                  <Select value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value as RuleForm['field'] })}>
                    <option value="qty_sum">Cantidad total</option>
                    <option value="lines_count">Líneas</option>
                    <option value="value_sum">Valor total</option>
                  </Select>
                </Field>
                <Field label="Operador">
                  <Select value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value as RuleForm['operator'] })}>
                    <option value=">">mayor a</option>
                    <option value=">=">mayor o igual a</option>
                    <option value="=">igual a</option>
                  </Select>
                </Field>
                <Field label="Valor">
                  <Input type="number" min="0" step="0.001" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
                </Field>
              </FormRow>
              <Textarea rows={1} className="mt-2 text-xs text-slate-500" readOnly value={`Queda: ${conditionText(formToPayload(form).condition)}`} />
            </Card>
            <Card className="p-3">
              <p className="mb-2 text-sm font-semibold text-slate-600">Acciones</p>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.requireApproval} onChange={(e) => setForm({ ...form, requireApproval: e.target.checked })} />
                Exigir aprobación de un ENCARGADO antes de confirmar
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.alert} onChange={(e) => setForm({ ...form, alert: e.target.checked })} />
                Generar alerta a ADMIN/ENCARGADO
              </label>
            </Card>
          </div>
        )}
      </Modal>

      {/* Formulario de umbral */}
      <Modal
        open={!!thForm}
        onClose={() => setThForm(null)}
        title={thForm?.id ? 'Editar umbral de control' : 'Nuevo umbral de control'}
        width="md"
        footer={
          <>
            <Button variant="secondary" disabled={saving} onClick={() => setThForm(null)}>Cancelar</Button>
            <Button variant="success" loading={saving} disabled={!thForm || String(thForm.threshold_value) === ''} onClick={() => void saveThreshold()}>
              Guardar
            </Button>
          </>
        }
      >
        {thForm && (
          <div className="space-y-3">
            <FormRow cols={2}>
              <Field label="Tipo de documento">
                <Select value={thForm.entity_type} onChange={(e) => setThForm({ ...thForm, entity_type: e.target.value })}>
                  {[...ENTITY_TYPES, 'PRODUCT'].map((t) => <option key={t} value={t}>{ENTITY_LABEL[t]}</option>)}
                </Select>
              </Field>
              <Field label="Ubicación">
                <Select value={thForm.location_id ?? ''} onChange={(e) => setThForm({ ...thForm, location_id: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">Global (todas)</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
            </FormRow>
            <FormRow cols={3}>
              <Field label="Métrica">
                <Select value={thForm.metric} onChange={(e) => setThForm({ ...thForm, metric: e.target.value })}>
                  {Object.entries(METRIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Operador">
                <Select value={thForm.threshold_operator} onChange={(e) => setThForm({ ...thForm, threshold_operator: e.target.value as ThresholdRow['threshold_operator'] })}>
                  {Object.entries(OP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Valor del umbral" required>
                <Input type="number" value={String(thForm.threshold_value)} onChange={(e) => setThForm({ ...thForm, threshold_value: e.target.value })} />
              </Field>
            </FormRow>
            <p className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-500">
              El umbral genera alertas automáticas (vía checks programados del scheduler) cuando la métrica supera el límite. Para exigir aprobación por documento, creá una REGLA en la pestaña "Reglas".
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
