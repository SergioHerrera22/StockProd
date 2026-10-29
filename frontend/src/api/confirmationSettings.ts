import { api } from '../lib/api';

export interface ConfirmationSetting {
  module: 'ENTRY' | 'DELIVERY' | 'TRANSFER' | 'COUNT' | 'VOID';
  action: 'CONFIRM' | 'APPROVE' | 'APPLY' | 'RECEIVE' | 'VERIFY' | 'VOID';
  allow_same_user: boolean;
  require_different_user: boolean;
  require_min_role: string | null;
  require_dual_auth: boolean;
  enabled: boolean;
  notes: string | null;
  updated_by?: number | null;
  updated_at?: string | null;
}

export async function getConfirmationSettings(): Promise<{ settings: ConfirmationSetting[] }> {
  return api<{ settings: ConfirmationSetting[] }>('/settings/confirmations');
}

export async function updateConfirmationSetting(
  module: string,
  action: string,
  data: Partial<ConfirmationSetting>
): Promise<ConfirmationSetting> {
  return api<ConfirmationSetting>(`/settings/confirmations/${module}/${action}`, {
    method: 'PUT',
    body: data,
  });
}
