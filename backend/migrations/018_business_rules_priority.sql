-- 018: Reparar esquema de business_rules.
-- El servicio de reglas de negocio ordenaba por la columna `priority`, pero esa
-- columna nunca se creo en la migracion 007. PostgreSQL fallaba al validar la
-- consulta (columna inexistente) y cualquier alta/confirmacion de entrada,
-- entrega, transferencia o conteo terminaba en HTTP 500.
--
-- Se agrega la columna para dejar el esquema alineado con el codigo. El codigo
-- actual ya no depende de ella (ordena por id), asi que esta migracion es
-- segura e idempotente tambien en bases donde la tabla no exista.

ALTER TABLE IF EXISTS business_rules
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;

DO $$
BEGIN
  IF to_regclass('public.business_rules') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_biz_rules_priority
      ON business_rules (entity_type, trigger_event, priority);
  END IF;
END;
$$;
