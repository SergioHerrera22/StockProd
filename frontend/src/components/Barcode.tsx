import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

interface BarcodeProps {
  /** Texto a codificar: número de documento, EAN-13, etc. */
  value: string;
  /** Formato JsBarcode. CODE128 acepta cualquier texto; EAN13 para códigos de producto/orden */
  format?: 'CODE128' | 'EAN13';
  height?: number;
  width?: number;
  /** Mostrar el valor en texto debajo de las barras */
  displayValue?: boolean;
  className?: string;
}

/** Código de barras scannable (SVG) para comprobantes impresos.
 *  Renderiza en pantalla y en window.print() sin configuración extra. */
export default function Barcode({
  value,
  format = 'CODE128',
  height = 48,
  width = 1.6,
  displayValue = true,
  className,
}: BarcodeProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, {
        format,
        height,
        width,
        displayValue,
        margin: 4,
        fontSize: 12,
        font: 'monospace',
        lineColor: '#0f172a',
        background: '#ffffff',
      });
    } catch {
      // Valor inválido para el formato elegido: queda el SVG vacío
    }
  }, [value, format, height, width, displayValue]);

  return <svg ref={ref} className={className} />;
}
