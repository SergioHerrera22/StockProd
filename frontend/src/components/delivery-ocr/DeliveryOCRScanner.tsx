import React, { useState, useRef, useEffect } from 'react';
import Tesseract from 'tesseract.js';

interface DetectedProduct {
  productId: number;
  productName: string;
  productCode: string;
  quantity: number;
  confidence: number;
}

interface OCRBlock {
  text: string;
  confidence: number;
  bounds?: any;
}

interface OCRResult {
  text: string;
  data: any;
  success: boolean;
  error?: string;
  blocks?: OCRBlock[];
}

interface DeliveryOCRProps {
  onProductsDetected: (products: DetectedProduct[]) => void;
  onClose: () => void;
}

export const DeliveryOCRScanner: React.FC<DeliveryOCRProps> = ({ onProductsDetected, onClose }) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<OCRResult>({ text: '', data: {}, success: false });
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleImage(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleImage(file);
  };

  const handleImage = async (file: File) => {
    setError(null);
    setIsProcessing(true);
    setOcrResult({ text: '', data: {}, success: false });

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Por favor, selecciona un archivo de imagen');
      setIsProcessing(false);
      return;
    }

    // Show preview
    const objectUrl = URL.createObjectURL(file);
    setImageSrc(objectUrl);

    try {
      // Tesseract.js 2.x API: createWorker accepts a single options object.
      // Load and initialize the language explicitly before recognizing the image.
      const worker = Tesseract.createWorker();
      let data: any;

      try {
        await worker.load();
        await worker.loadLanguage('eng');
        await worker.initialize('eng');
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.:/-\\ ',
        });
        ({ data } = await worker.recognize(file));
      } finally {
        await worker.terminate();
      }

      setOcrResult({
        text: data.text || '',
        data: data || {},
        success: true,
        blocks: data.blocks,
      });

      // Parse the detected text to find products and quantities
      const parsedProducts = parseOcrTextForProducts(data.text || '');
      setIsProcessing(false);
      onProductsDetected(parsedProducts);
    } catch (err) {
      console.error('OCR error:', err);
      setError('Error al procesar la imagen con OCR. Intenta con una imagen más clara.');
      setIsProcessing(false);
    }
  };

  const parseOcrTextForProducts = (text: string): DetectedProduct[] => {
    // This is a parser that looks for patterns like "Producto: X" or "Product: X - Qty: Y"
    // or numbers followed by product names in typical delivery formats

    const lines = text.split('\n').filter(line => line.trim().length > 0);
    const detectedProducts: DetectedProduct[] = [];
    const seenIds = new Set<string>();

    // Try to identify product patterns
    // Typical patterns: "Producto: Nombre - Qty: 10" or "10 x Producto" or "Product Name 10"

    for (const line of lines) {
      const trimmed = line.trim();

      // Pattern: "Qty: 10" or "Quantity: 10" or just a number at end
      const qtyMatch = trimmed.match(/(?:qty|quantity|q|units?):\s*(\d+(?:\.\d+)?)/i);
      const numberAtEnd = trimmed.match(/(\d+(?:\.\d+)?)\s*$/);

      let quantity: number | null = null;
      if (qtyMatch) {
        quantity = parseFloat(qtyMatch[1]);
      } else if (numberAtEnd) {
        // Check if the number makes sense as a quantity (not too large, not too small)
        const num = parseFloat(numberAtEnd[1]);
        if (num > 0 && num < 10000 && !trimmed.startsWith('http')) {
          quantity = num;
        }
      }

      // Try to find product name - everything before the quantity
      if (quantity !== null) {
        // Remove the quantity part to get the product name
        const withoutQty = trimmed.replace(new RegExp(`\\s*\\d+(?:\\.\\d+)?\\s*$`), '').trim();

        // Skip if too short or too long as a product name
        if (withoutQty.length > 3 && withoutQty.length < 100) {
          // Try to find a product ID or match against known products
          // For now, we'll mark it as needing lookup
          const productName = withoutQty;

          // Don't add duplicates (use string key)
          const key = `${productName}-${quantity}`;
          if (!seenIds.has(key)) {
            seenIds.add(key);
            // We need the productId - this will be resolved later by matching with the products database
            detectedProducts.push({
              productId: -1, // Will be resolved by matching with product database
              productName,
              productCode: '',
              quantity,
              confidence: 0.8,
            });
          }
        }
      }
    }

    return detectedProducts;
  };

  const pasteFromClipboard = async (e: React.ClipboardEvent) => {
    e.preventDefault();
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      // DataTransferItem.getAsFile() returns File | null
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file && file.type?.startsWith('image/')) {
        handleImage(file);
        return;
      }
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 border rounded-lg">
      <h3 className="text-xl font-bold mb-6 border-b pb-2">
        Escaneo OCR de Captura de Pantalla
      </h3>

      {/* Instructions */}
      <div className="mb-6 p-4 border rounded-info/20 text-info/80">
        <p className="font-medium mb-2">Instrucciones:</p>
        <ul className="text-sm space-y-1">
          <li>Presiona <kbd className="mono">Ctrl + V</kbd> después de tomar captura</li>
          <li>O arrastra y suelta una imagen (PNG, JPG, JPEG)</li>
          <li>La imagen debe ser legible y bien iluminada</li>
          <li>El sistema detectará automáticamente productos y cantidades</li>
        </ul>
      </div>

      {/* Image Preview */}
      {imageSrc && (
        <div className="mb-6 rounded overflow-hidden shadow-lg">
          <img src={imageSrc} alt="Captura de pantalla" className="w-full h-48 object-contain" />
        </div>
      )}

      {/* OCR Result */}
      {isProcessing && (
        <div className="mb-6 p-4 border rounded-info/20">
          <p className="font-medium">Procesando OCR...</p>
          <p className="text-sm text-info/80">Analizando texto de la captura...</p>
        </div>
      )}

      {error && (
        <div className="mb-6 p-4 border-red-100 rounded-red text-red-800">
          <p>{error}</p>
        </div>
      )}

      {ocrResult.success && !isProcessing && (
        <div className="mb-6 p-4 border-green-100 rounded-green text-green-800">
          <p className="font-medium">✅ OCR completado exitosamente</p>
          <p className="text-sm mt-2 line-clamp-6">
            {ocrResult.text.substring(0, 500)}{ocrResult.text.length > 500 ? '...' : ''}
          </p>
          <p className="text-xs mt-2">Se detectaron productos en el texto</p>
        </div>
      )}

      {/* Detected Products List from OCR text */}
      {ocrResult.success && ocrResult.data?.text && ocrResult.data.text.trim().length > 0 && (
        <div className="space-y-4">
          <h4 className="font-medium">Texto detectado en la captura:</h4>
          <div className="grid grid-cols-1 gap-3">
            {ocrResult.data.text
              .split('\n')
              .filter((line: string) => line.trim().length > 0 && /[\d]/.test(line))
              .slice(0, 10)
              .map((line: string, index: number) => (
                <div key={index} className="p-3 border rounded-info/30 text-info/80 text-sm">
                  {line.substring(0, 80)}{line.length > 80 && '...'}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3 mt-8">
        <button
          onClick={onClose}
          className="flex-1 py-2 px-4 border rounded-info text-info hover:bg-info/10 transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={() => {
            // Here we would create the delivery with the detected products
            // This would need to be connected to the delivery creation flow
            onClose();
          }}
          className="flex-1 py-2 px-4 rounded-primary bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          disabled={!ocrResult.success}
        >
          {ocrResult.success ? 'Crear Entrega' : 'Procesar'}
        </button>
      </div>
    </div>
  );
};