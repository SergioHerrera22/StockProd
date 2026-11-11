-- ============================================================
-- Migracion 008: Agregar PARCIAL a doc_status
-- Necesario para entregas derivadas multi-sucursal: cuando hay
-- faltantes, la entrega queda en estado PARCIAL hasta que el
-- cliente retire el faltante en la otra sucursal.
-- ============================================================

ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'PARCIAL';