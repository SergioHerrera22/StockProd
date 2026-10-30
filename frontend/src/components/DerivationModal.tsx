import { useEffect, useState } from 'react';
import { Button, Modal } from './ui';
import { fmtQty } from '../lib/format';
import type { DeliveryAvailabilityItem, UserAlternativeChoice } from '../types';

/**
 * Modal para elegir ubicaciones alternativas cuando hay faltantes.
 * Compartido por Nueva entrega y Detalle de entrega (flujo unificado).
 */
export function DerivationModal({
  open,
  onClose,
  items,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  items: DeliveryAvailabilityItem[];
  onConfirm: (choices: UserAlternativeChoice[]) => void;
}) {
  const [choices, setChoices] = useState<Map<number, { locationId: number; quantity: number }>>(new Map());

  // Reset al abrir el modal: sin esto, las elecciones de un intento anterior
  // (otro borrador/producto) se enviaban silenciosamente, derivando stock en
  // la sucursal o cantidad equivocadas.
  useEffect(() => {
    if (open) setChoices(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  // Solo items con faltantes
  const shortfallItems = items.filter(i => i.shortfall > 0);
  // Los items SIN alternativas no bloquean la confirmacion: el backend los
  // registra como deuda sin derivar y la entrega avanza con lo disponible.
  const derivableItems = shortfallItems.filter(i => i.alternativeLocations.length > 0);

  const handleLocationChange = (productId: number, locationId: number) => {
    const item = shortfallItems.find(i => i.productId === productId);
    const maxQty = item ? Math.min(item.shortfall,
      item.alternativeLocations.find(a => a.locationId === locationId)?.availableQuantity || 0) : 0;
    setChoices(prev => {
      const next = new Map(prev);
      next.set(productId, { locationId, quantity: maxQty });
      return next;
    });
  };

  const handleQtyChange = (productId: number, qty: number) => {
    setChoices(prev => {
      const next = new Map(prev);
      const item = shortfallItems.find(i => i.productId === productId);
      const current = next.get(productId);
      if (current && item) {
        const max = Math.min(item.shortfall,
          item.alternativeLocations.find(a => a.locationId === current.locationId)?.availableQuantity || 0);
        // Clamp real (el atributo max de HTML no bloquea lo tipeado) para no
        // prometer stock que no existe.
        next.set(productId, { ...current, quantity: Math.min(Math.max(qty, 0), max) });
      }
      return next;
    });
  };

  const allSelected = derivableItems.every(item => {
    const choice = choices.get(item.productId);
    return choice && choice.locationId > 0 && choice.quantity > 0;
  });

  const noAlternativeItems = shortfallItems.filter(i => i.alternativeLocations.length === 0);

  return (
    <Modal open={open} onClose={onClose} title="Derivar faltantes a otra sucursal" width="lg">
      <p className="mb-4 text-sm text-slate-600">
        Los siguientes productos tienen stock insuficiente en la sucursal de salida.
        Seleccioná la sucursal de destino y la cantidad para cada uno.
        Se creará un <strong>comprobante de retiro</strong> para que el cliente retire en esa sucursal.
      </p>

      <div className="max-h-96 overflow-y-auto space-y-4">
        {shortfallItems.map(item => {
          const choice = choices.get(item.productId);
          return (
            <div key={item.productId} className="border border-slate-200 rounded-lg p-4 bg-white">
              <div className="mb-3">
                <div className="font-medium text-slate-800">{item.productName}</div>
                <div className="text-xs text-slate-500">{item.productCode} · Pedido: {fmtQty(item.requestedQuantity)} · Disponible acá: {fmtQty(item.availableAtMain)} · <strong className="text-red-600">Faltan: {fmtQty(item.shortfall)}</strong></div>
              </div>

              {item.alternativeLocations.length === 0 ? (
                <div className="text-red-600 text-sm p-3 bg-red-50 rounded">No hay stock existente en otras sucursales.</div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Sucursal destino *</label>
                    <select
                      className="input w-full"
                      value={choice?.locationId || ''}
                      onChange={e => handleLocationChange(item.productId, parseInt(e.target.value))}
                      required
                    >
                      <option value="">Seleccionar sucursal...</option>
                      {item.alternativeLocations.map(loc => (
                        <option key={loc.locationId} value={loc.locationId}>
                          {loc.locationName} ({loc.locationCode}) — Disponible: {fmtQty(loc.availableQuantity)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Cantidad a derivar *</label>
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      max={choice ? Math.min(item.shortfall,
                        item.alternativeLocations.find(a => a.locationId === choice.locationId)?.availableQuantity || 0) : item.shortfall}
                      value={choice?.quantity || ''}
                      onChange={e => handleQtyChange(item.productId, parseFloat(e.target.value) || 0)}
                      className="input w-full"
                      required
                    />
                  </div>
                  <div className="sm:col-span-3 text-xs text-slate-500">
                    Se reservará el stock en la sucursal elegida. El cliente presenta el código de barras para retirar.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {noAlternativeItems.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
          {noAlternativeItems.length} producto(s) sin stock en ninguna sucursal quedarán como <strong>deuda sin derivar</strong> (podrá re-derivarse más tarde desde el detalle).
        </div>
      )}

      <div className="mt-4 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={() => {
          // Solo se envian elecciones de items con alternativas: los sin
          // opcion van limpios y el backend los registra como unresolved.
          const derivableIds = new Set(derivableItems.map(i => i.productId));
          const choicesArray: UserAlternativeChoice[] = [];
          choices.forEach((v, productId) => {
            if (derivableIds.has(productId) && v.locationId && v.quantity > 0) {
              choicesArray.push({ productId, chosenLocationId: v.locationId, quantity: v.quantity });
            }
          });
          onConfirm(choicesArray);
        }} disabled={!allSelected}>
          Confirmar y crear retiros
        </Button>
      </div>
    </Modal>
  );
}
