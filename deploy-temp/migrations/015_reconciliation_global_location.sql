-- 015: reconciliation_logs.location_id admite checks GLOBALES.
-- Los checks sin ubicacion (movimientos huerfanos, transferencias en transito)
-- usaban location_id = 0 como marcador "GLOBAL" que viola la FK a locations
-- (la corrida completa de conciliacion revienta con 409/400 a mitad de camino).
-- NULL = check global.

ALTER TABLE reconciliation_logs ALTER COLUMN location_id DROP NOT NULL;
