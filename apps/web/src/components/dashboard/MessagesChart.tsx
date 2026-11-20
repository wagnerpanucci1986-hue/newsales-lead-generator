'use client';

import { useEffect, useRef, useState } from 'react';

export interface DayPoint {
  date: string; // AAAA-MM-DD
  sent: number;
  received: number;
}

// Cores categóricas validadas para daltonismo e contraste no fundo claro.
const SERIES = [
  { key: 'sent', label: 'Enviadas', color: '#2a78d6' },
  { key: 'received', label: 'Recebidas', color: '#eb6834' },
] as const;

const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };
const dayLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmt = (n: number) => n.toLocaleString('pt-BR');

/** Teto "redondo" do eixo: 1, 2 ou 5 × potência de 10. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * pow >= value)! * pow;
  return step;
}

/** Mensagens por dia: duas linhas num único eixo, com leitura por ponteiro e tabela alternativa. */
export function MessagesChart({ data }: { data: DayPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...data.flatMap((d) => [d.sent, d.received]), 0));
  const x = (i: number) => PAD.left + (data.length > 1 ? (i / (data.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 56))));
  const point = hover !== null ? data[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left - PAD.left) / innerW;
    setHover(Math.min(data.length - 1, Math.max(0, Math.round(ratio * (data.length - 1)))));
  }

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded" style={{ backgroundColor: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={wrap} className="relative">
        <svg width={width} height={H} role="img" aria-label="Mensagens enviadas e recebidas por dia" onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-pan-y">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-slate-500 text-[11px]">{fmt(t)}</text>
            </g>
          ))}
          {data.map((d, i) => (i % labelEvery === 0 || i === data.length - 1) && (data.length - 1 - i >= labelEvery || i === data.length - 1) && (
            <text key={d.date} x={x(i)} y={H - 8} textAnchor={i === data.length - 1 ? 'end' : 'middle'} className="fill-slate-500 text-[11px]">{dayLabel(d.date)}</text>
          ))}
          {SERIES.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} />
          ))}
          {point && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="#94a3b8" strokeWidth={1} />
              {SERIES.map((s) => <circle key={s.key} cx={x(hover)} cy={y(point[s.key])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />)}
            </g>
          )}
        </svg>
        {point && hover !== null && (
          <div className="pointer-events-none absolute top-2 z-10 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md" style={x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}>
            <p className="mb-1 font-medium text-slate-900">{dayLabel(point.date)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 text-slate-600">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}: <strong className="tabular-nums text-slate-900">{fmt(point[s.key])}</strong>
              </p>
            ))}
          </div>
        )}
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-slate-600">Ver em tabela</summary>
        <div className="mt-2 max-h-56 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-1">Dia</th><th className="py-1 text-right">Enviadas</th><th className="py-1 text-right">Recebidas</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...data].reverse().map((d) => (
                <tr key={d.date}><td className="py-1">{dayLabel(d.date)}</td><td className="py-1 text-right tabular-nums">{fmt(d.sent)}</td><td className="py-1 text-right tabular-nums">{fmt(d.received)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
