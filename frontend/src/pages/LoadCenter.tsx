import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';

type ActionCardProps = {
  icon: string;
  title: string;
  description: string;
  action: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
};

function ActionCard({ icon, title, description, label, disabled, onClick }: ActionCardProps) {
  return (
    <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-2xl">{icon}</div>
      <h2 className="font-semibold text-slate-800">{title}</h2>
      <p className="mt-1 flex-1 text-sm leading-6 text-slate-500">{description}</p>
      <button type="button" disabled={disabled} onClick={onClick}
        className="mt-4 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50">
        {label}
      </button>
    </section>
  );
}

export default function LoadCenter() {
  const navigate = useNavigate();
  const canWrite = useAuth((s) => s.can('products.write'));
  const go = (action: string) => navigate(`/productos?accion=${action}`);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Catálogo · Operaciones</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Centro de carga</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
          Un solo lugar para incorporar productos, completar códigos de barras y mantener el catálogo.
          Estas acciones no modifican existencias ni generan movimientos de stock.
        </p>
      </header>

      {!canWrite && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Tenés acceso de consulta. Para cargar o modificar productos necesitás el permiso de escritura del catálogo.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ActionCard icon="📄" title="Importar catálogo" label="Importar Excel / CSV"
          description="Cargá productos desde archivos .xlsx, .xls o .csv. El importador actual detecta columnas, limpia códigos y descripciones y permite revisar una muestra antes de confirmar."
          disabled={!canWrite} onClick={() => go('importar')} />
        <ActionCard icon="📷" title="Carga continua de barras" label="Abrir lector continuo"
          description="Buscá cada producto por código interno o descripción, escaneá su EAN con un lector USB/Bluetooth y guardalo. También permite generar un EAN-13 interno."
          disabled={!canWrite} onClick={() => go('barras')} />
        <ActionCard icon="➕" title="Alta individual" label="Crear producto"
          description="Registrá un producto con código, descripción completa, unidad, categoría y proveedores asociados. Podés generar o escanear su código de barras."
          disabled={!canWrite} onClick={() => go('nuevo')} />
        <ActionCard icon="🏷️" title="Etiquetas" label="Abrir catálogo"
          description="Buscá un producto en el catálogo para revisar sus datos e imprimir etiquetas individuales con su código de barras."
          onClick={() => navigate('/productos')} />
        <ActionCard icon="🔎" title="Control y corrección" label="Revisar productos"
          description="Consultá el catálogo, editá fichas, corregí códigos de barras y verificá proveedores vinculados. Los cambios quedan auditados."
          onClick={() => navigate('/productos')} />
        <ActionCard icon="🏭" title="Proveedores" label="Administrar proveedores"
          description="Mantené el padrón de proveedores. La asociación proveedor-producto se gestiona desde la ficha del producto."
          onClick={() => navigate('/proveedores')} />
      </div>

      <section className="rounded-xl border border-blue-200 bg-blue-50 p-4">
        <h2 className="font-semibold text-blue-900">Reglas de seguridad de carga</h2>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-blue-900/80">
          <li>La carga y edición del catálogo no modifica stock ni movimientos.</li>
          <li>Los códigos de barras duplicados se rechazan en el servidor.</li>
          <li>La edición de una ficha permite mantener varios proveedores y definir uno principal.</li>
          <li>Las operaciones de alta y edición quedan registradas en auditoría.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Siguiente etapa del Centro de Carga</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          Quedan para una segunda entrega el panel automático de productos incompletos (sin barras, sin proveedor
          o con descripción faltante), la edición masiva con previsualización de diferencias y la impresión por lotes.
          No se habilitan todavía porque requieren consultas y validaciones específicas del servidor para no recorrer
          los más de 12.000 productos desde el navegador ni sobrescribir datos existentes.
        </p>
      </section>
    </div>
  );
}
