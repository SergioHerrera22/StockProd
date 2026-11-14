import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './ui';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  value?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
  pageSize?: number;
  total?: number;
  page?: number;
  onPageChange?: (page: number) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  selectable?: boolean;
  selectedKeys?: Set<string | number>;
  onSelect?: (keys: Set<string | number>) => void;
  getRowKey?: (row: T) => string | number;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, loading, emptyTitle = 'Sin resultados',
  emptyHint, emptyAction, pageSize = 15, total, page, onPageChange, initialSort,
  selectable = false, selectedKeys, onSelect,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [clientPage, setClientPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.value ?? ((row: T) => (row as Record<string, unknown>)[col.key] as string | number | null | undefined);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'es') * dir;
    });
  }, [rows, sort, columns]);

  const serverPaged = typeof total === 'number' && !!onPageChange;
  const size = serverPaged ? pageSize : pageSize;
  const currentPage = serverPaged ? (page ?? 1) : clientPage;
  const totalCount = serverPaged ? total! : sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / size));
  const pageRows = serverPaged ? sorted : sorted.slice((currentPage - 1) * size, currentPage * size);

  const keys = useMemo(() => pageRows.map((r) => rowKey(r)), [pageRows, rowKey]);
  const allSelected = selectable && selectedKeys ? keys.length > 0 && keys.every((k) => selectedKeys.has(k)) : false;
  const someSelected = selectable && selectedKeys ? keys.some((k) => selectedKeys.has(k)) && !allSelected : false;

  function toggleAll() {
    if (!selectable || !onSelect || !selectedKeys) return;
    const next = new Set(selectedKeys);
    if (allSelected) {
      for (const k of keys) next.delete(k);
    } else {
      for (const k of keys) next.add(k);
    }
    onSelect(next);
  }

  function toggleSort(col: Column<T>) {
    if (!col.sortable) return;
    setSort((prev) =>
      prev?.key === col.key ? { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'asc' }
    );
  }

  function toggleOne(key: string | number) {
    if (!selectable || !onSelect || !selectedKeys) return;
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelect(next);
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              {selectable && (
                <th className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-3 py-2.5 font-semibold ${col.sortable ? 'cursor-pointer select-none hover:text-slate-600' : ''} ${col.className ?? ''} ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''}`}
                  onClick={() => toggleSort(col)}
                >
                  {col.label}
                  {sort?.key === col.key && <span className="ml-1">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const k = rowKey(row);
              const checked = selectable && selectedKeys ? selectedKeys.has(k) : false;
              return (
                <tr
                  key={k}
                  onClick={(e) => {
                    if (selectable && (e.target as HTMLElement).tagName === 'INPUT') return;
                    onRowClick?.(row);
                  }}
                  className={`border-b border-slate-100 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-brand-50/60' : 'hover:bg-slate-50'} ${checked ? 'bg-brand-50/40' : ''}`}
                >
                  {selectable && (
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(k)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                  <td key={col.key} className={`px-3 py-2.5 ${col.className ?? ''} ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''}`}>
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                  </td>
                ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageRows.length === 0 && !loading && <EmptyState title={emptyTitle} hint={emptyHint} action={emptyAction} />}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-sm text-slate-500">
          <span>
            Página {currentPage} de {totalPages} · {totalCount} registros
          </span>
          <div className="flex gap-1">
            <button
              className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
              disabled={currentPage <= 1}
              onClick={() => (serverPaged ? onPageChange!(currentPage - 1) : setClientPage(currentPage - 1))}
            >
              ← Anterior
            </button>
            <button
              className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
              disabled={currentPage >= totalPages}
              onClick={() => (serverPaged ? onPageChange!(currentPage + 1) : setClientPage(currentPage + 1))}
            >
              Siguiente →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
