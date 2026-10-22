-- ============================================================
-- Migracion 005: Agregar PENDING_DELIVERY a reference_type
-- ============================================================

-- Agregar nuevo valor al enum reference_type
ALTER TYPE reference_type ADD VALUE 'PENDING_DELIVERY';