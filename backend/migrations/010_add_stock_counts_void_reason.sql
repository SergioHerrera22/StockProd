-- ============================================================
-- Migracion 010: motivo de anulacion en inventarios (stock_counts)
-- ============================================================
-- Motivo: counts.service.ts anula con
--   UPDATE stock_counts SET ..., void_reason = $2, ...
-- pero la columna no existia, por lo que anular un inventario devolvia
--   500 "no existe la columna «void_reason» en la relación «stock_counts»"
-- El frontend ya pide el motivo al usuario (Counts.tsx, modal "Anular").

ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS void_reason varchar(255);
