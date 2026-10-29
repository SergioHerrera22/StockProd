-- ============================================================
-- Migracion 022: permisos personalizados por usuario
-- ============================================================
--
-- NULL       -> el usuario hereda los permisos de su rol (comportamiento
--               historico, no rompe usuarios existentes).
-- array JSON -> lista explicita de permisos concedidos. Un array vacio
--               significa "sin permisos" (el administrador puede desactivar
--               todos los permisos de un usuario).
--
-- El backend valida siempre contra esta columna en middleware/auth.ts.

ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb;

COMMENT ON COLUMN users.permissions IS
  'Permisos personalizados del usuario. NULL = hereda del rol; array = permisos explicitos.';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_permissions_is_array_chk;
ALTER TABLE users ADD CONSTRAINT users_permissions_is_array_chk
  CHECK (permissions IS NULL OR jsonb_typeof(permissions) = 'array');

-- Indice GIN por si en el futuro se consultan permisos dentro del JSON.
CREATE INDEX IF NOT EXISTS idx_users_permissions ON users USING gin (permissions);
