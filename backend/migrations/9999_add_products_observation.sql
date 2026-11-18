-- Agrega observaciones internas a los productos.
-- IF NOT EXISTS permite aplicar esta migración en bases donde la columna
-- ya se haya creado manualmente, sin afectar los datos existentes.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS observation text;
