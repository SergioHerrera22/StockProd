/** Gráficos SVG livianos (sin dependencias externas). */

export interface SeriesPoint {
  label: string;
  a: number;
  b?: number;
}

/** Barras agrupadas (serie A + serie B opcional). */
export function GroupedBars({ data, labelA = 'A', labelB = 'B', height = 180 }: {
  data: SeriesPoint[]; labelA?: string; labelB?: string; height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b ?? 0)));
  const hasB = data.some((d) => (d.b ?? 0) > 0);

  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="group relative flex flex-1 items-end justify-center gap-[2px]" title={`${d.label}: ${labelA} ${d.a}${hasB ? ` · ${labelB} ${d.b ?? 0}` : ''}`}>
            <div
              className="w-full max-w-[14px] rounded-t bg-emerald-400 transition-colors group-hover:bg-emerald-500"
              style={{ height: `${Math.max(2, (d.a / max) * (height - 20))}px` }}
            />
            {hasB && (
              <div
                className="w-full max-w-[14px] rounded-t bg-red-300 transition-colors group-hover:bg-red-400"
                style={{ height: `${Math.max(2, ((d.b ?? 0) / max) * (height - 20))}px` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" /> {labelA}</span>
          {hasB && <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-red-300" /> {labelB}</span>}
        </div>
        <span>
          {data.length > 0 && `${data[0].label} – ${data[data.length - 1].label}`}
        </span>
      </div>
    </div>
  );
}

/** Barras horizontales con etiqueta y valor. */
export function HBars({ data, valueFormat }: {
  data: { label: string; value: number; color?: string }[];
  valueFormat?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i}>
          <div className="mb-0.5 flex items-center justify-between text-xs">
            <span className="font-medium text-slate-600">{d.label}</span>
            <span className="text-slate-400">{valueFormat ? valueFormat(d.value) : d.value}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color ?? '#3a7db8' }}
            />
          </div>
        </div>
      ))}
      {data.length === 0 && <p className="py-4 text-center text-sm text-slate-400">Sin datos</p>}
    </div>
  );
}

/** Donut simple con leyenda. */
export function Donut({ data, size = 150 }: {
  data: { label: string; value: number; color: string }[]; size?: number;
}) {
  const total = data.reduce((acc, d) => acc + d.value, 0);
  const radius = size / 2 - 12;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f1f5f9" strokeWidth={16} />
        {total > 0 &&
          data.map((d, i) => {
            const frac = d.value / total;
            const dash = frac * circumference;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={d.color}
                strokeWidth={16}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += dash;
            return el;
          })}
      </svg>
      <div className="space-y-1.5 text-sm">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: d.color }} />
            <span className="text-slate-600">{d.label}:</span>
            <span className="font-semibold text-slate-800">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
