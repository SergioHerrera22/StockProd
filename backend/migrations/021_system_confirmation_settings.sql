CREATE TABLE IF NOT EXISTS system_confirmation_settings (
  id SERIAL PRIMARY KEY,
  module VARCHAR(20) NOT NULL,
  action VARCHAR(30) NOT NULL,
  allow_same_user BOOLEAN NOT NULL DEFAULT false,
  require_different_user BOOLEAN NOT NULL DEFAULT true,
  require_min_role VARCHAR(20),
  require_dual_auth BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(module, action)
);

INSERT INTO system_confirmation_settings (module, action, allow_same_user, require_different_user, require_dual_auth, enabled)
VALUES
('ENTRY', 'CONFIRM', false, true, false, true),
('ENTRY', 'APPROVE', false, true, false, true),
('ENTRY', 'VOID', false, false, true, true),
('DELIVERY', 'CONFIRM', false, true, false, true),
('DELIVERY', 'APPROVE', false, true, false, true),
('DELIVERY', 'VOID', false, false, true, true),
('TRANSFER', 'APPROVE', false, true, false, true),
('TRANSFER', 'RECEIVE', false, true, false, true),
('TRANSFER', 'VERIFY', false, true, false, true),
('TRANSFER', 'VOID', false, false, true, true),
('COUNT', 'APPLY', false, true, false, true),
('COUNT', 'APPROVE', false, true, false, true),
('COUNT', 'VOID', false, false, true, true)
ON CONFLICT (module, action) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_sys_conf_mod_act ON system_confirmation_settings(module, action);
