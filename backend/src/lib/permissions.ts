// Matriz de permisos por rol. El frontend usa una copia identica para la UX,
// pero SIEMPRE se valida en el backend.

export type Role = 'ADMIN' | 'ENCARGADO' | 'EMPLEADO';

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
  | 'users.read'
  | 'users.manage'
  | 'audit.read'
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
  'approvals.read', 'approvals.approve',
  'alerts.read', 'alerts.manage',
];

const EMPLEADO: Permission[] = [
  'products.read',
  'stock.read',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm',
  'movements.read', 'dashboard.read',
  'locations.read',
  'approvals.read',
  'alerts.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    ...ENCARGADO,
    'locations.manage', 'users.manage', 'users.read', 'audit.read',
  ],
  ENCARGADO,
  EMPLEADO,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}