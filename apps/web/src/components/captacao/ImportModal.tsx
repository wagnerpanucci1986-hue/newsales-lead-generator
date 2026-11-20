'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toApiFilters, type CnpjFilters } from '@/lib/cnpj';
import type { ContactList, ImportJob } from '@/lib/crm';
import type { Tag } from '@/lib/inbox';
import { Modal } from '../Modal';

/** Leva as empresas marcadas (ou as primeiras N do filtro) para Contatos, com etiquetas e lista. */
export function ImportModal({ filters, selected, total, segment, onClose, onDone }: {
  filters: CnpjFilters;
  selected: string[];
  total: number;
  segment: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const today = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
  const [newTags, setNewTags] = useState(['CNPJ', filters.uf, segment].filter(Boolean).join(', '));
  const [listChoice, setListChoice] = useState('new');
  const [newListName, setNewListName] = useState(`CNPJ ${filters.uf}${segment ? ` ${segment}` : ''} ${today}`);
  const [limit, setLimit] = useState(String(Math.min(total, 500)));
  const [includeFixed, setIncludeFixed] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const useSelection = selected.length > 0;

  useEffect(() => {
    api<{ tags: Tag[] }>('/tags').then((r) => setTags(r.tags)).catch(() => undefined);
    api<{ lists: ContactList[] }>('/lists').then((r) => setLists(r.lists)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!job || job.status !== 'PROCESSING') return;
    const t = setInterval(() => api<{ import: ImportJob }>(`/imports/${job.id}`).then((r) => setJob(r.import)).catch(() => undefined), 1500);
    return () => clearInterval(t);
  }, [job]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ import: ImportJob }>('/cnpj/import', {
        method: 'POST',
        body: {
          filters: toApiFilters(filters),
          cnpjs: useSelection ? selected : undefined,
          limit: useSelection ? selected.length : Math.max(1, Math.min(5000, Number(limit) || 1)),
          includeFixed,
          tagIds,
          newTags: newTags.split(',').map((t) => t.trim()).filter(Boolean).filter((t) => !tags.some((x) => x.name === t)),
          listId: listChoice && listChoice !== 'new' ? listChoice : null,
          newListName: listChoice === 'new' ? newListName : null,
        },
      });
      // Etiquetas digitadas que já existem entram pelo id.
      setJob(res.import);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível importar');
    } finally {
      setBusy(false);
    }
  }

  // Etiqueta digitada que já existe vira seleção pelo id.
  useEffect(() => {
    const names = newTags.split(',').map((t) => t.trim().toLowerCase());
    setTagIds((ids) => [...new Set([...ids.filter((id) => !tags.find((t) => t.id === id && names.includes(t.name.toLowerCase()))), ...tags.filter((t) => names.includes(t.name.toLowerCase())).map((t) => t.id)])]);
  }, [newTags, tags]);

  return (
    <Modal title="Importar para Contatos" onClose={job?.status === 'COMPLETED' ? onDone : onClose}>
      {!job ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {useSelection ? <><strong>{selected.length}</strong> empresas marcadas.</> : <>Importar as primeiras empresas do filtro (de {total.toLocaleString('pt-BR')}), na ordem da lista.</>}
            {' '}Quem já é contato só ganha as etiquetas e a lista; quem está na lista de bloqueio fica de fora.
          </p>
          {!useSelection && (
            <div>
              <label className="label" htmlFor="ci-limit">Quantas empresas</label>
              <input id="ci-limit" type="number" min={1} max={5000} className="input max-w-40" value={limit} onChange={(e) => setLimit(e.target.value)} />
              <p className="mt-1 text-xs text-slate-500">Até 5.000 por vez. Lotes pequenos ajudam a acompanhar as respostas e protegem o número.</p>
            </div>
          )}
          <div>
            <label className="label" htmlFor="ci-tags">Etiquetas (separadas por vírgula)</label>
            <input id="ci-tags" className="input" value={newTags} onChange={(e) => setNewTags(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Sugestão: origem, UF e segmento. As que não existem são criadas.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="ci-list">Lista</label>
              <select id="ci-list" className="input" value={listChoice} onChange={(e) => setListChoice(e.target.value)}>
                <option value="new">Criar nova lista…</option>
                <option value="">Nenhuma</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            {listChoice === 'new' && (
              <div><label className="label" htmlFor="ci-newlist">Nome da lista</label><input id="ci-newlist" className="input" value={newListName} onChange={(e) => setNewListName(e.target.value)} /></div>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={includeFixed} onChange={(e) => setIncludeFixed(e.target.checked)} />
            <span>Incluir empresas só com telefone fixo <span className="block text-xs text-slate-500">Desligado, entra só quem tem celular. Fixo raramente tem WhatsApp.</span></span>
          </label>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary" disabled={busy || (listChoice === 'new' && !newListName.trim())} onClick={() => void start()}>{busy ? 'Iniciando…' : 'Importar'}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {job.status === 'PROCESSING' && <p className="text-sm text-slate-600">Importando…</p>}
          {job.status === 'FAILED' && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">A importação falhou: {job.error}</p>}
          {job.status === 'COMPLETED' && (
            <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[['Novos contatos', job.created], ['Já existiam', job.updated], ['Sem celular', job.invalid], ['Na lista de bloqueio', job.blacklisted]].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 px-2 py-3">
                  <dd className="text-lg font-semibold tabular-nums">{Number(value).toLocaleString('pt-BR')}</dd>
                  <dt className="text-xs text-slate-500">{label}</dt>
                </div>
              ))}
            </dl>
          )}
          {job.status === 'COMPLETED' && <p className="text-sm text-slate-600">Os contatos estão em <strong>Contatos</strong>{listChoice ? ', na lista escolhida' : ''}. Antes de disparar, rode a verificação de WhatsApp.</p>}
          <div className="flex justify-end"><button className="btn btn-primary" disabled={job.status === 'PROCESSING'} onClick={onDone}>Concluir</button></div>
        </div>
      )}
    </Modal>
  );
}
