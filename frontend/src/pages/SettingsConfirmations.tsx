import { useEffect, useState } from 'react';
import { getConfirmationSettings, updateConfirmationSetting, type ConfirmationSetting } from '../api/confirmationSettings';
import { useToast } from '../components/Toast';
import { Button } from '../components/ui';

const MODULE_LABEL: Record<string, string> = {
  ENTRY: 'Entradas',
  DELIVERY: 'Entregas',
  TRANSFER: 'Transferencias',
  COUNT: 'Inventarios',
  VOID: 'Anulaciones',
};

const ACTION_LABEL: Record<string, string> = {
  CONFIRM: 'Confirmar',
  APPROVE: 'Aprobar',
  APPLY: 'Aplicar',
  RECEIVE: 'Recibir',
  VERIFY: 'Verificar',
  VOID: 'Anular',
};

export default function SettingsConfirmations() {
  const toast = useToast();
  const [settings, setSettings] = useState<ConfirmationSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await getConfirmationSettings();
      setSettings(res.settings);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(setting: ConfirmationSetting, key: keyof ConfirmationSetting, value: boolean) {
    const id = `${setting.module}-${setting.action}`;
    setSaving(id);
    try {
      const updated = await updateConfirmationSetting(setting.module, setting.action, { [key]: value });
      setSettings((prev) => prev.map((s) => (s.module === updated.module && s.action === updated.action ? updated : s)));
      toast.success('Configuración actualizada');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(null);
    }
  }

  const grouped = settings.reduce<Record<string, ConfirmationSetting[]>>((acc, s) => {
    if (!acc[s.module]) acc[s.module] = [];
    acc[s.module].push(s);
    return acc;
  }, {});

  if (loading) return <div className="p-4">Cargando...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Confirmaciones y segregación de funciones</h1>
        <p className="text-sm text-slate-500">
          Configurá por acción si el mismo usuario que crea puede confirmar/aprobar/aplicar, o si se exige otro usuario.
        </p>
      </div>

      {Object.keys(grouped).sort().map((module) => (
        <div key={module} className="rounded-xl bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="font-semibold">{MODULE_LABEL[module] || module}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-4 py-2">Acción</th>
                  <th className="px-4 py-2 text-center">Habilitado</th>
                  <th className="px-4 py-2 text-center">Requiere otro usuario</th>
                  <th className="px-4 py-2 text-center">Permitir mismo usuario</th>
                  <th className="px-4 py-2 text-center">Exigir doble autorización</th>
                </tr>
              </thead>
              <tbody>
                {grouped[module].map((s) => {
                  const id = `${s.module}-${s.action}`;
                  const busy = saving === id;
                  return (
                    <tr key={id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium">{ACTION_LABEL[s.action] || s.action}</td>
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={s.enabled}
                          disabled={busy}
                          onChange={(e) => toggle(s, 'enabled', e.target.checked)}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={s.require_different_user}
                          disabled={busy || !s.enabled}
                          onChange={(e) => toggle(s, 'require_different_user', e.target.checked)}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={s.allow_same_user}
                          disabled={busy || !s.enabled}
                          onChange={(e) => toggle(s, 'allow_same_user', e.target.checked)}
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={s.require_dual_auth}
                          disabled={busy || !s.enabled}
                          onChange={(e) => toggle(s, 'require_dual_auth', e.target.checked)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="text-xs text-slate-400">
        Nota: "Requiere otro usuario" impide que el creador confirme/apruebe. Si "Permitir mismo usuario" está marcado, esa restricción se relaja.
      </div>
    </div>
  );
}
