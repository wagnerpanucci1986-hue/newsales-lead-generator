'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, type BlacklistEntry } from '@/lib/crm';
import { formatPhone } from '@/lib/numbers';
import { Pagination } from '../Pagination';

const SOURCE = { OPT_OUT: 'Pediu para sair', MANUAL: 'Adicionado manualmente', IMPORT: 'Importação' } as const;

export function BlacklistTab() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ entries: BlacklistEntry[]; total: number; limit: number } | null>(null);
  const [phones, setPhones] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/blacklist?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar a lista de bloqueio');
    }
  }, [page, q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ added: number; alreadyListed: number; invalid: string[] }>('/blacklist', { method: 'POST', body: { phones, reason: reason || null } });
      setMessage(`${res.added} adicionado(s)${res.alreadyListed ? `, ${res.alreadyListed} já estavam na lista` : ''}${res.invalid.length ? `. Inválidos: ${res.invalid.join(', ')}` : ''}.`);
      setPhones('');
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível adicionar');
    }
  }

  async function remove(entry: BlacklistEntry) {
    if (!window.confirm(`Remover ${formatPhone(entry.phone)} da lista de bloqueio? O contato voltará a poder receber campanhas. Faça isso apenas a pedido da própria pessoa.`)) return;
    await api(`/blacklist/${entry.phone}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    await load();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <input type="search" className="input mb-3 max-w-xs" placeholder="Buscar telefone" aria-label="Buscar telefone na lista de bloqueio" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} />
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2.5">Telefone</th><th className="px-3 py-2.5">Origem</th><th className="px-3 py-2.5">Desde</th><th className="px-3 py-2.5 text-right">Ações</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.entries.map((e) => (
                <tr key={e.phone}>
                  <td className="px-3 py-2.5 font-medium">{formatPhone(e.phone)}</td>
                  <td className="px-3 py-2.5 text-slate-600">{SOURCE[e.source]}{e.reason ? ` — ${e.reason}` : ''}</td>
                  <td className="px-3 py-2.5 text-slate-600">{formatDateTime(e.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right"><button className="text-sm font-medium text-red-700 hover:underline" onClick={() => void remove(e)}>Remover</button></td>
                </tr>
              ))}
              {data?.entries.length === 0 && <tr><td colSpan={4} className="px-3 py-10 text-center text-slate-500">Nenhum telefone bloqueado.</td></tr>}
            </tbody>
          </table>
        </div>
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      <form onSubmit={add} className="card h-fit space-y-3 p-4">
        <h2 className="font-semibold">Bloquear telefones</h2>
        <p className="text-sm text-slate-500">Quem está nesta lista não recebe campanhas nem respostas automáticas, em nenhum número.</p>
        <div>
          <label className="label" htmlFor="bl-phones">Telefones (um por linha)</label>
          <textarea id="bl-phones" className="input min-h-28" required value={phones} onChange={(e) => setPhones(e.target.value)} placeholder={'(11) 98888-7777\n(21) 97777-6666'} />
        </div>
        <div><label className="label" htmlFor="bl-reason">Motivo (opcional)</label><input id="bl-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {message && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p>}
        <button className="btn btn-primary w-full" type="submit">Adicionar à lista de bloqueio</button>
      </form>
    </div>
  );
}
