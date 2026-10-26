-- 017: Claves de idempotencia para operaciones criticas.
-- Problema (punto 9 del audit): confirmar una operacion puede haber ocurrido
-- en el servidor aunque el navegador no reciba la respuesta (red caida,
-- timeout). Sin idempotencia, el usuario reintenta y el resultado depende de
-- los guards de estado: a veces falla con un 409 confuso, a veces duplica.
-- Con la tabla, un reintento con la MISMA clave devuelve la respuesta guardada
-- en lugar de ejecutar de nuevo.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            varchar(80) PRIMARY KEY,
  user_id        integer REFERENCES users(id),
  method         varchar(8) NOT NULL DEFAULT 'POST',
  path           varchar(200) NOT NULL,
  request_hash   varchar(64) NOT NULL,
  status_code    integer NOT NULL,
  response_body  jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
