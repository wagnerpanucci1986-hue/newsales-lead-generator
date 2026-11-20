'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { WaNumber } from '@/lib/numbers';
import { Modal } from './Modal';

const COLORS = ['#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#14b8a6', '#64748b'];

/** Criação e edição de um número: apelido, cor, limite diário e aquecimento. */
export function NumberForm({ number, onClose, onSaved }: { number?: WaNumber; onClose: () => void; onSaved: (n: WaNumber) => void }) {
  const [nickname, setNickname] = useState(number?.nickname ?? '');
  const [color, setColor] = useState(number?.color ?? COLORS[0]!);
  const [dailyLimit, setDailyLimit] = useState(String(number?.dailyLimit ?? 200));
  const [warmupEnabled, setWarmupEnabled] = useState(number?.warmupEnabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = { nickname, color, dailyLimit: Number(dailyLimit), warmupEnabled };
      const res = await api<{ number: WaNumber }>(number ? `/numbers/${number.id}` : '/numbers', { method: number ? 'PATCH' : 'POST', body });
      onSaved(res.number);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar');
      setSaving(false);
    }
  }

  return (
    <Modal title={number ? 'Editar número' : 'Adicionar número'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="nickname">Apelido</label>
          <input id="nickname" className="input" required maxLength={40} placeholder="Ex.: Comercial 1" value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </div>
        <fieldset>
          <legend className="label">Cor</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Cor ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-full ring-offset-2 ${color === c ? 'ring-2 ring-slate-900' : ''}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="dailyLimit">Limite diário de disparos</label>
          <input id="dailyLimit" type="number" min={1} max={5000} required className="input" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Máximo de mensagens de campanha por dia. Respostas no atendimento não contam.</p>
        </div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={warmupEnabled} onChange={(e) => setWarmupEnabled(e.target.checked)} />
          <span>
            <span className="font-medium text-slate-700">Modo de aquecimento</span>
            <span className="block text-xs text-slate-500">Começa com volume baixo e aumenta a cada dia até o limite. Recomendado para chips novos.</span>
          </span>
        </label>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Salvando…' : number ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </form>
    </Modal>
  );
}
