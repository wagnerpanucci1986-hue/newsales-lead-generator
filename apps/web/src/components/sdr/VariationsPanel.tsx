'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * Variações da 1ª mensagem: a IA escreve versões com o mesmo sentido, você revisa e aprova.
 * Com variações aprovadas, cada envio sorteia uma delas no lugar do texto principal.
 */
export function VariationsPanel({ body, variants, onChange }: { body: string; variants: string[]; onChange: (v: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [count, setCount] = useState(6);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ variations: string[]; warnings: string[] }>('/sdr/variations', { method: 'POST', body: { body, count } });
      onChange([...variants, ...r.variations].slice(0, 20));
      setWarnings(r.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gerar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Variações com IA</h3>
          <p className="text-xs text-slate-500">
            {variants.length ? `${variants.length} variações aprovadas: cada envio sorteia uma delas no lugar do texto acima.` : 'A IA escreve versões diferentes do texto acima, com o mesmo sentido. Você revisa antes de usar.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-600" htmlFor="var-count">Quantas</label>
          <select id="var-count" className="input w-auto py-1.5 text-xs" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button type="button" className="btn btn-secondary" disabled={busy || body.trim().length < 10} onClick={() => void generate()}>{busy ? 'Gerando…' : 'Gerar variações'}</button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {warnings.length > 0 && (
        <ul role="note" className="list-inside list-disc rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {variants.length > 0 && (
        <ol className="space-y-2">
          {variants.map((v, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-2 w-5 shrink-0 text-right text-xs text-slate-500">{i + 1}.</span>
              <textarea className="input min-h-16 text-sm" aria-label={`Variação ${i + 1}`} value={v} maxLength={4096} onChange={(e) => onChange(variants.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="mt-1.5 text-sm font-medium text-red-700 hover:underline" onClick={() => onChange(variants.filter((_, j) => j !== i))}>Remover</button>
            </li>
          ))}
        </ol>
      )}
      {variants.length > 0 && <button type="button" className="text-sm font-medium text-slate-600 hover:underline" onClick={() => onChange([])}>Remover todas e usar só o texto acima</button>}
    </div>
  );
}
