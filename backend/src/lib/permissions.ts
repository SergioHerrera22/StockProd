// Matriz de permisos por rol. El frontend usa una copia identica para la UX,
// pero SIEMPRE se valida en el backend.

export type Role = 'ADMIN' | 'ENCARGADO' | 'EMPLEADO' | 'TRANSPORTE';

export type Permission =
  | 'products.read'
  | 'products.write'
  | 'categories.write'
  | 'stock.read'
  | 'stock.adjust'
  | 'deliveries.read'
  | 'deliveries.write'
  | 'deliveries.void'
  | 'deliveries.confirm'
  | 'deliveries.approve'
  | 'entries.read'
  | 'entries.write'
  | 'entries.confirm'
  | 'entries.void'
  | 'entries.approve'
  | 'transfers.read'
  | 'transfers.write'
  | 'transfers.receive'
  | 'transfers.dispatch'
  | 'transfers.verify'
  | 'transfers.void'
  | 'transfers.approve'
  | 'counts.read'
  | 'counts.write'
  | 'counts.apply'
  | 'counts.void'
  | 'counts.approve'
  | 'movements.read'
  | 'dashboard.read'
  | 'reports.read'
  | 'locations.read'
  | 'locations.manage'
  | 'tracking.read'
  | 'tracking.write'
  | 'tracking.gps'
  | 'users.read'
  | 'users.manage'
  | 'audit.read'
  /** Configuración global (reglas de aprobación, reglas de negocio, umbrales) */
  | 'settings.write'
  | 'approvals.read'
  | 'approvals.approve'
  | 'alerts.read'
  | 'alerts.manage';

const ENCARGADO: Permission[] = [
  'products.read', 'products.write', 'categories.write',
  'stock.read', 'stock.adjust',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void', 'deliveries.approve',
  'entries.read', 'entries.write', 'entries.confirm', 'entries.void', 'entries.approve',
  'transfers.read', 'transfers.write', 'transfers.receive', 'transfers.dispatch', 'transfers.verify', 'transfers.void', 'transfers.approve',
  'counts.read', 'counts.write', 'counts.apply', 'counts.void', 'counts.approve',
  'movements.read', 'dashboard.read', 'reports.read',
  'locations.read',
  'tracking.read', 'tracking.write', 'tracking.gps',
  'approvals.read', 'approvals.approve',
  'alerts.read', 'alerts.manage',
];

const EMPLEADO: Permission[] = [
  'products.read',
  'stock.read',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm',
  'movements.read', 'dashboard.read',
  'locations.read',
  'tracking.read', 'tracking.gps',
  'approvals.read',
  'alerts.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    ...ENCARGADO,
    'locations.manage', 'users.manage', 'users.read', 'audit.read', 'settings.write',
  ],
  ENCARGADO,
  EMPLEADO,
  // Chofer de transporte: ve sus viajes y opera el GPS (compartir ubicación,
  // salió, parada entregada). NO arma Ni edita viajes (tracking.write).
  TRANSPORTE: ['locations.read', 'tracking.read', 'tracking.gps', 'deliveries.read', 'stock.read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}