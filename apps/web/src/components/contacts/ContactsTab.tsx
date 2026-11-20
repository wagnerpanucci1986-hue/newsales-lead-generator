'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { WA_STATUS, type Contact, type ContactList, type WaCheckStatus } from '@/lib/crm';
import type { Tag } from '@/lib/inbox';
import { formatPhone, type WaNumber } from '@/lib/numbers';
import { Modal } from '../Modal';
import { Pagination } from '../Pagination';
import { ContactForm } from './ContactForm';
import { ImportWizard } from './ImportWizard';

type Dialog = { kind: 'create' } | { kind: 'edit'; contact: Contact } | { kind: 'import' } | { kind: 'verify' } | null;

export function ContactsTab({ lists, tags, numbers, onListsChanged }: { lists: ContactList[]; tags: Tag[]; numbers: WaNumber[]; onListsChanged: () => void }) {
  const [filters, setFilters] = useState({ q: '', tagId: '', listId: '', waStatus: '' as '' | WaCheckStatus, optedOut: '' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ contacts: Contact[]; total: number; limit: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkTarget, setBulkTarget] = useState('');
  const [verify, setVerify] = useState({ numberId: '', listId: '' });

  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setFilters((f) => (f.q === search ? f : { ...f, q: search }));
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ page: String(page) });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    try {
      setData(await api(`/contacts?${p}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os contatos');
    }
  }, [filters, page]);
  useEffect(() => {
    void load();
  }, [load]);

  const setFilter = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPage(1);
    setSelected(new Set());
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  };

  async function bulk(action: 'addTag' | 'addToList' | 'delete') {
    const ids = [...selected];
    if (action === 'delete' && !window.confirm(`Excluir ${ids.length} contato(s)? O histórico de conversas é mantido.`)) return;
    try {
      const [kind, id] = bulkTarget.split(':');
      await api('/contacts/bulk', { method: 'POST', body: { ids, action, tagId: kind === 'tag' ? id : undefined, listId: kind === 'list' ? id : undefined } });
      setSelected(new Set());
      setBulkTarget('');
      await load();
      onListsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação');
    }
  }

  async function remove(c: Contact) {
    if (!window.confirm(`Excluir ${c.name ?? formatPhone(c.phone)}?`)) return;
    await api(`/contacts/${c.id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    await load();
  }

  async function startVerify() {
    try {
      const res = await api<{ pending: number }>('/contacts/verify', { method: 'POST', body: { numberId: verify.numberId, listId: verify.listId || undefined } });
      setDialog(null);
      setNotice(res.pending ? `Verificação iniciada para ${res.pending.toLocaleString('pt-BR')} contato(s). O resultado aparece aos poucos na coluna WhatsApp.` : 'Não há contatos pendentes de verificação.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar a verificação');
      setDialog(null);
    }
  }

  const pageIds = data?.contacts.map((c) => c.id) ?? [];
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const connected = numbers.filter((n) => n.status === 'CONNECTED');

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="search" className="input max-w-xs" placeholder="Buscar por nome, telefone, empresa" aria-label="Buscar contatos" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-auto" aria-label="Lista" value={filters.listId} onChange={setFilter('listId')}>
          <option value="">Todas as listas</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="input w-auto" aria-label="Etiqueta" value={filters.tagId} onChange={setFilter('tagId')}>
          <option value="">Todas as etiquetas</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="input w-auto" aria-label="WhatsApp" value={filters.waStatus} onChange={setFilter('waStatus')}>
          <option value="">WhatsApp: todos</option>
          {(Object.keys(WA_STATUS) as WaCheckStatus[]).map((s) => <option key={s} value={s}>{WA_STATUS[s].label}</option>)}
        </select>
        <select className="input w-auto" aria-label="Descadastro" value={filters.optedOut} onChange={setFilter('optedOut')}>
          <option value="">Todos</option>
          <option value="0">Ativos</option>
          <option value="1">Descadastrados</option>
        </select>
        <span className="flex-1" />
        <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'verify' })}>Verificar WhatsApp</button>
        <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}>Importar</button>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>Novo contato</button>
      </div>

      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="mb-3 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900">{notice}</p>}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm">
          <strong>{selected.size} selecionado(s)</strong>
          <select className="input w-auto py-1.5" aria-label="Lista ou etiqueta de destino" value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
            <option value="">Escolha lista ou etiqueta…</option>
            <optgroup label="Listas">{lists.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}</optgroup>
            <optgroup label="Etiquetas">{tags.map((t) => <option key={t.id} value={`tag:${t.id}`}>{t.name}</option>)}</optgroup>
          </select>
          <button className="btn btn-secondary py-1.5" disabled={!bulkTarget} onClick={() => void bulk(bulkTarget.startsWith('tag') ? 'addTag' : 'addToList')}>Adicionar</button>
          <button className="btn btn-danger py-1.5" onClick={() => void bulk('delete')}>Excluir</button>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input type="checkbox" aria-label="Selecionar todos desta página" className="accent-emerald-600" checked={allSelected} onChange={(e) => setSelected((s) => {
                  const next = new Set(s);
                  for (const id of pageIds) if (e.target.checked) next.add(id); else next.delete(id);
                  return next;
                })} />
              </th>
              <th className="px-3 py-2.5">Contato</th>
              <th className="px-3 py-2.5">Empresa</th>
              <th className="px-3 py-2.5">WhatsApp</th>
              <th className="px-3 py-2.5">Listas e etiquetas</th>
              <th className="px-3 py-2.5 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.contacts.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-3 py-2.5">
                  <input type="checkbox" aria-label={`Selecionar ${c.name ?? c.phone}`} className="accent-emerald-600" checked={selected.has(c.id)} onChange={(e) => setSelected((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(c.id); else next.delete(c.id);
                    return next;
                  })} />
                </td>
                <td className="px-3 py-2.5">
                  <p className="font-medium">{c.name ?? c.pushName ?? '—'}</p>
                  <p className="text-xs text-slate-500">{formatPhone(c.phone)}</p>
                </td>
                <td className="px-3 py-2.5 text-slate-600">{c.company ?? '—'}</td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${WA_STATUS[c.waStatus].className}`}>{WA_STATUS[c.waStatus].label}</span>
                  {c.optedOutAt && <span className="ml-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Descadastrado</span>}
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-wrap gap-1">
                    {c.lists.map((l) => <span key={l.id} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{l.name}</span>)}
                    {c.tags.map((t) => <span key={t.id} className="rounded px-1.5 py-0.5 text-xs text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  <button className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setDialog({ kind: 'edit', contact: c })}>Editar</button>
                  <button className="ml-3 text-sm font-medium text-red-700 hover:underline" onClick={() => void remove(c)}>Excluir</button>
                </td>
              </tr>
            ))}
            {data?.contacts.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">Nenhum contato encontrado. Importe uma planilha ou cadastre um contato.</td></tr>
            )}
            {!data && <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">Carregando…</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}

      {dialog?.kind === 'create' && <ContactForm tags={tags} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'edit' && <ContactForm contact={dialog.contact} tags={tags} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'import' && <ImportWizard lists={lists} tags={tags} numbers={numbers} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); onListsChanged(); }} />}
      {dialog?.kind === 'verify' && (
        <Modal title="Verificar quem tem WhatsApp" onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Consulta o WhatsApp para os contatos ainda não verificados, em lotes pequenos e espaçados. Consultas em grande volume aumentam o risco de bloqueio do número usado; prefira um número que não seja o principal.</p>
            <div>
              <label className="label" htmlFor="v-number">Número que fará a consulta</label>
              <select id="v-number" className="input" value={verify.numberId} onChange={(e) => setVerify((v) => ({ ...v, numberId: e.target.value }))}>
                <option value="">Escolha um número conectado</option>
                {connected.map((n) => <option key={n.id} value={n.id}>{n.nickname}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="v-list">Contatos</label>
              <select id="v-list" className="input" value={verify.listId} onChange={(e) => setVerify((v) => ({ ...v, listId: e.target.value }))}>
                <option value="">Todos os não verificados</option>
                {lists.map((l) => <option key={l.id} value={l.id}>Só da lista {l.name}</option>)}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setDialog(null)}>Cancelar</button>
              <button className="btn btn-primary" disabled={!verify.numberId} onClick={() => void startVerify()}>Iniciar verificação</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
