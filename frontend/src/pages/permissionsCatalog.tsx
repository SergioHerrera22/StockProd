import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Permiso del catálogo estándar (GET /api/location-permissions/catalog). */
export interface CatalogPermission {
  /** Clave del permiso (p. ej. "entries.approve"). */
  key: string;
  permission: string;
  label: string;
  category: string;
  /** Descripción opcional si el backend la incluye en el catálogo. */
  description?: string;
}

/** Etiquetas de respaldo por si el catálogo aún no cargó. */
export const PERMISSION_LABEL: Record<string, string> = {
  'products.read': 'Ver productos',
  'products.write': 'Crear/editar productos',
  'categories.write': 'Gestionar categorías',
  'products.import': 'Importar productos',
  'stock.read': 'Ver stock',
  'stock.adjust': 'Ajustar stock manual',
  'deliveries.read': 'Ver entregas',
  'deliveries.write': 'Crear/modificar entregas',
  'deliveries.confirm': 'Confirmar entregas',
  'deliveries.void': 'Anular entregas',
  'deliveries.approve': 'Aprobar entregas',
  'entries.read': 'Ver entradas',
  'entries.write': 'Crear/modificar entradas',
  'entries.confirm': 'Confirmar entradas',
  'entries.void': 'Anular entradas',
  'entries.approve': 'Aprobar entradas',
  'transfers.read': 'Ver transferencias',
  'transfers.write': 'Crear transferencias',
  'transfers.dispatch': 'Despachar transferencias',
  'transfers.receive': 'Recibir transferencias',
  'transfers.verify': 'Verificar recepción (2da persona)',
  'transfers.void': 'Anular transferencias',
  'transfers.approve': 'Aprobar transferencias',
  'counts.read': 'Ver inventarios',
  'counts.write': 'Crear/modificar inventarios',
  'counts.apply': 'Aplicar inventarios',
  'counts.approve': 'Aprobar inventarios',
  'movements.read': 'Ver movimientos',
  'dashboard.read': 'Ver dashboard',
  'reports.read': 'Ver reportes',
  'locations.read': 'Ver ubicaciones',
  'locations.manage': 'Gestionar ubicaciones',
  'users.read': 'Ver usuarios',
  'users.manage': 'Gestionar usuarios y permisos',
  'audit.read': 'Ver auditoría',
  'approvals.read': 'Ver solicitudes de aprobación',
  'approvals.approve': 'Aprobar/rechazar solicitudes',
  'alerts.read': 'Ver alertas',
  'alerts.manage': 'Gestionar alertas',
};

interface CatalogState {
  permissions: CatalogPermission[];
  /** true mientras consulta el backend. */
  pending: boolean;
  /** true si falló la consulta (se usan las etiquetas de respaldo). */
  failed: boolean;
}

/**
 * Catálogo de permisos estándar del backend (STANDARD_PERMISSIONS).
 * Se usa en "Permisos por ubicación" para armar el selector de permisos.
 */
export function usePermissionCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ permissions: [], pending: true, failed: false });

  useEffect(() => {
    let cancelled = false;
    api<{ permissions: Array<{ permission: string; label: string; category: string }> }>('/location-permissions/catalog')
      .then((r) => {
        if (cancelled) return;
        setState({
          permissions: r.permissions.map((p) => ({
            key: p.permission,
            permission: p.permission,
            label: p.label,
            category: p.category,
          })),
          pending: false,
          failed: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          permissions: Object.entries(PERMISSION_LABEL).map(([key, label]) => ({
            key, permission: key, label, category: '',
          })),
          pending: false,
          failed: true,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
