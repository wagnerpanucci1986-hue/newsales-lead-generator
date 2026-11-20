'use client';

import { useEffect, useRef, useState } from 'react';

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Seleção múltipla com busca no servidor (CNAE, município, natureza).
 * `search` devolve as opções para o texto digitado.
 */
export function MultiPicker({
  label,
  placeholder,
  selected,
  onChange,
  search,
}: {
  label: string;
  placeholder: string;
  selected: PickOption[];
  onChange: (next: PickOption[]) => void;
  search: (q: string) => Promise<PickOption[]>;
}) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<PickOption[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = `mp-${label.replace(/\W/g, '')}`;

  useEffect(() => {
    if (!open) return;
    let active = true;
    const t = setTimeout(() => {
      search(q).then((o) => active && setOptions(o)).catch(() => undefined);
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [q, open, search]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const chosen = new Set(selected.map((s) => s.value));
  return (
    <div ref={box} className="relative">
      <label className="label" htmlFor={id}>{label}</label>
      {selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((s) => (
            <span key={s.value} className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
              <span className="truncate">{s.label}</span>
              <button type="button" aria-label={`Remover ${s.label}`} className="shrink-0 hover:text-brand-900" onClick={() => onChange(selected.filter((x) => x.value !== s.value))}>✕</button>
            </span>
          ))}
        </div>
      )}
      <input id={id} className="input" placeholder={placeholder} value={q} autoComplete="off" onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                disabled={chosen.has(o.value)}
                className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-40"
                onClick={() => { onChange([...selected, o]); setQ(''); }}
              >
                <span>{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-slate-500">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
