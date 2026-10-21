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
  | 'entries.read'
  | 'entries.write'
  | 'transfers.read'
  | 'transfers.write'
  | 'transfers.receive'
  | 'counts.read'
  | 'counts.write'
  | 'counts.apply'
  | 'movements.read'
  | 'dashboard.read'
  | 'reports.read'
  | 'locations.read'
  | 'locations.manage'
  | 'users.manage'
  | 'audit.read';

const ENCARGADO: Permission[] = [
  'products.read', 'products.write', 'categories.write',
  'stock.read', 'stock.adjust',
  'deliveries.read', 'deliveries.write', 'deliveries.void',
  'entries.read', 'entries.write',
  'transfers.read', 'transfers.write', 'transfers.receive',
  'counts.read', 'counts.write', 'counts.apply',
  'movements.read', 'dashboard.read', 'reports.read',
  'locations.read',
];

const EMPLEADO: Permission[] = [
  'products.read',
  'stock.read',
  'deliveries.read', 'deliveries.write',
  'movements.read', 'dashboard.read',
  'locations.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    ...ENCARGADO,
    'locations.manage', 'users.manage', 'audit.read',
  ],
  ENCARGADO,
  EMPLEADO,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}
