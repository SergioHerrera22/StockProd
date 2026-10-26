import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtQty } from '../lib/format';
import { availableOf, type StockRow } from '../types';
import { Badge, Button, Input, Modal, Spinner } from './ui';

/** Buscador de productos (nombre, código, código de barras, marca) con stock por ubicación. */
export function ProductPicker({ open, onClose, locationId, onPick }: {
  open: boolean;
  onClose: () => void;
  locationId?: number | null;
  onPick: (p: StockRow) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) { setQ(''); setRows([]); setSearched(false); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ products: StockRow[] }>(`/stock${qs({ q, locationId, limit: 30 })}`);
        setRows(res.products);
        setSearched(true);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, open, locationId]);

  return (
    <Modal open={open} onClose={onClose} title="Buscar producto" width="lg">
      <Input
        autoFocus
        placeholder="Nombre, código, marca o código de barras…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-3 max-h-[50vh] divide-y divide-slate-100 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}
        {!loading && rows.map((p) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between gap-3 px-2 py-2.5 text-left hover:bg-brand-50/60"
            onClick={() => { onPick(p); onClose(); }}
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-700">{p.name}</div>
              <div className="text-xs text-slate-400">
                {p.code}{p.brand ? ` · ${p.brand}` : ''}
              </div>
            </div>
            <Badge color={availableOf(p) <= 0 ? 'red' : availableOf(p) <= Number(p.min_stock) ? 'amber' : 'green'}>
              {fmtQty(availableOf(p))} {p.unit?.toLowerCase()}
            </Badge>
          </button>
        ))}
        {!loading && searched && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">No se encontraron productos para “{q}”</p>
        )}
        {!searched && !loading && (
          <p className="py-6 text-center text-sm text-slate-400">Escribí para buscar…</p>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
      </div>
    </Modal>
  );
}
