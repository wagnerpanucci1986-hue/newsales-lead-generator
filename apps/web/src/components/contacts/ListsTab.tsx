'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { ContactList } from '@/lib/crm';

export function ListsTab({ lists, onChanged }: { lists: ContactList[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação');
    }
  }

  return (
    <div className="max-w-2xl">
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(async () => { await api('/lists', { method: 'POST', body: { name } }); setName(''); }); }}>
        <input className="input" placeholder="Nome da nova lista" aria-label="Nome da nova lista" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary shrink-0" type="submit">Criar lista</button>
      </form>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <ul className="card divide-y divide-slate-100">
        {lists.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{l.name}</p>
              <p className="text-sm text-slate-500">{l.members.toLocaleString('pt-BR')} {l.members === 1 ? 'contato' : 'contatos'}</p>
            </div>
            <div className="flex shrink-0 gap-3 text-sm font-medium">
              <button className="text-brand-700 hover:underline" onClick={() => { const next = window.prompt('Novo nome da lista', l.name); if (next?.trim()) void run(() => api(`/lists/${l.id}`, { method: 'PATCH', body: { name: next } })); }}>Renomear</button>
              <button className="text-red-700 hover:underline" onClick={() => { if (window.confirm(`Excluir a lista “${l.name}”? Os contatos continuam cadastrados.`)) void run(() => api(`/lists/${l.id}`, { method: 'DELETE' })); }}>Excluir</button>
            </div>
          </li>
        ))}
        {lists.length === 0 && <li className="px-4 py-10 text-center text-sm text-slate-500">Nenhuma lista criada. As listas definem o público das campanhas.</li>}
      </ul>
    </div>
  );
}
