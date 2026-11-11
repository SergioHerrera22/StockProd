-- ============================================================
-- Migracion 016: codigo de barras de la ORDEN DE ENTREGA
-- ============================================================
-- La orden de retiro derivada (pending_deliveries) ya tenia un EAN-13 propio,
-- pero la entrega no: el unico codigo impreso era el numero textual (CODE128
-- del "EN-00012"), que no hay forma de scanear para traer la orden completa.
--
-- Con esta columna cada entrega tiene un EAN-13 unico e imprimible; el vendedor
-- escanea el comprobante y la web le muestra TODA la mercaderia solicitada para
-- aceptarla (entrega completa, parcial con derivacion o retiro posterior).
--
-- generate_ean13_barcode() (migracion 003) genera el EAN-13 con checksum.

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS barcode varchar(60);

-- Rellenar las entregas ya creadas para que todas sean escaneables
UPDATE deliveries
   SET barcode = generate_ean13_barcode()
 WHERE barcode IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_barcode ON deliveries(barcode);
CREATE INDEX IF NOT EXISTS idx_deliveries_number ON deliveries(number);
