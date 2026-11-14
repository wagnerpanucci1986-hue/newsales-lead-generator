'use client';

import { useEffect, useState } from 'react';
import { api, apiUpload } from '@/lib/api';
import type { ContactList, ImportJob } from '@/lib/crm';
import type { Tag } from '@/lib/inbox';
import type { WaNumber } from '@/lib/numbers';
import { Modal } from '../Modal';

interface Upload {
  import: ImportJob;
  columns: string[];
  sample: string[][];
  suggestedMapping: Record<string, string>;
}

const TARGETS = [
  ['phone', 'Telefone'],
  ['name', 'Nome'],
  ['company', 'Empresa'],
  ['email', 'E-mail'],
  ['custom', 'Campo personalizado'],
  ['ignore', 'Ignorar'],
] as const;

/** Importação em três passos: arquivo → mapeamento de colunas → resultado. */
export function ImportWizard({ lists, tags, numbers, onClose, onDone }: { lists: ContactList[]; tags: Tag[]; numbers: WaNumber[]; onClose: () => void; onDone: () => void }) {
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [listChoice, setListChoice] = useState('');
  const [newListName, setNewListName] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [consentSource, setConsentSource] = useState('');
  const [verifyNumberId, setVerifyNumberId] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiUpload<Upload>('/imports', form);
      setUpload(res);
      setMapping(res.suggestedMapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ler o arquivo');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ import: ImportJob }>(`/imports/${upload.import.id}/start`, {
        method: 'POST',
        body: {
          mapping,
          listId: listChoice && listChoice !== 'new' ? listChoice : null,
          newListName: listChoice === 'new' ? newListName : null,
          tagIds,
          consentSource: consentSource || null,
          verifyNumberId: verifyNumberId || null,
        },
      });
      setJob(res.import);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar a importação');
    } finally {
      setBusy(false);
    }
  }

  // Acompanha o processamento até terminar.
  useEffect(() => {
    if (!job || job.status !== 'PROCESSING') return;
    const t = setInterval(() => {
      api<{ import: ImportJob }>(`/imports/${job.id}`).then((r) => setJob(r.import)).catch(() => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [job]);

  const phoneCols = Object.values(mapping).filter((t) => t === 'phone').length;
  const connected = numbers.filter((n) => n.status === 'CONNECTED');

  return (
    <Modal title="Importar contatos" onClose={job?.status === 'COMPLETED' ? onDone : onClose}>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!upload && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Envie um arquivo <strong>.csv</strong> ou <strong>.xlsx</strong>. A primeira linha deve conter os nomes das colunas.</p>
          <input type="file" accept=".csv,.xlsx,.txt" aria-label="Arquivo de contatos" className="input" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          {busy && <p className="text-sm text-slate-500">Lendo arquivo…</p>}
        </div>
      )}

      {upload && !job && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{upload.import.fileName} — {upload.import.totalRows.toLocaleString('pt-BR')} linhas. Diga o que cada coluna representa.</p>
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {upload.columns.map((col, i) => {
              const target = mapping[col] ?? 'ignore';
              const kind = target.startsWith('custom:') ? 'custom' : target;
              return (
                <div key={col} className="grid grid-cols-[1fr_1fr] items-center gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{col}</p>
                    <p className="truncate text-xs text-slate-500">{upload.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ') || 'sem exemplo'}</p>
                  </div>
                  <select className="input py-1.5" aria-label={`Destino da coluna ${col}`} value={kind} onChange={(e) => setMapping((m) => ({ ...m, [col]: e.target.value === 'custom' ? `custom:${col}` : e.target.value }))}>
                    {TARGETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          {phoneCols !== 1 && <p className="text-sm text-amber-800">Escolha exatamente uma coluna como Telefone.</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="imp-list">Adicionar à lista</label>
              <select id="imp-list" className="input" value={listChoice} onChange={(e) => setListChoice(e.target.value)}>
                <option value="">Nenhuma</option>
                <option value="new">Criar nova lista…</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            {listChoice === 'new' && (
              <div><label className="label" htmlFor="imp-newlist">Nome da nova lista</label><input id="imp-newlist" className="input" value={newListName} onChange={(e) => setNewListName(e.target.value)} /></div>
            )}
          </div>
          {tags.length > 0 && (
            <fieldset>
              <legend className="label">Aplicar etiquetas</legend>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-sm">
                    <input type="checkbox" className="accent-emerald-600" checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} />
                    {t.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div>
            <label className="label" htmlFor="imp-consent">Origem do consentimento (LGPD)</label>
            <input id="imp-consent" className="input" placeholder="Ex.: cadastro no site, evento de março" value={consentSource} onChange={(e) => setConsentSource(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Registre de onde veio a autorização destes contatos para receber mensagens.</p>
          </div>
          <div>
            <label className="label" htmlFor="imp-verify">Verificar quem tem WhatsApp</label>
            <select id="imp-verify" className="input" value={verifyNumberId} onChange={(e) => setVerifyNumberId(e.target.value)}>
              <option value="">Não verificar agora</option>
              {connected.map((n) => <option key={n.id} value={n.id}>Verificar usando {n.nickname}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">A verificação é feita aos poucos. Consultas em grande volume aumentam o risco de bloqueio do número usado.</p>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary" disabled={busy || phoneCols !== 1 || (listChoice === 'new' && !newListName.trim())} onClick={() => void start()}>{busy ? 'Iniciando…' : 'Importar'}</button>
          </div>
        </div>
      )}

      {job && (
        <div className="space-y-4">
          {job.status === 'PROCESSING' && <p className="text-sm text-slate-600">Importando {job.totalRows.toLocaleString('pt-BR')} linhas…</p>}
          {job.status === 'FAILED' && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">A importação falhou: {job.error}</p>}
          {job.status === 'COMPLETED' && (
            <>
              <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                {[['Novos', job.created], ['Atualizados', job.updated], ['Inválidos', job.invalid], ['Na blacklist', job.blacklisted]].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-slate-50 px-2 py-3">
                    <dd className="text-lg font-semibold tabular-nums">{Number(value).toLocaleString('pt-BR')}</dd>
                    <dt className="text-xs text-slate-500">{label}</dt>
                  </div>
                ))}
              </dl>
              {job.errorReport && job.errorReport.duplicatedInFile > 0 && <p className="text-sm text-slate-600">{job.errorReport.duplicatedInFile} linhas repetiam um telefone do próprio arquivo e foram unificadas.</p>}
              {job.errorReport && job.errorReport.rejected.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium text-slate-700">Ver linhas rejeitadas</summary>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-slate-600">
                    {job.errorReport.rejected.map((r) => <li key={r.line}>Linha {r.line}: “{r.value || 'vazio'}” — {r.reason}</li>)}
                  </ul>
                </details>
              )}
            </>
          )}
          <div className="flex justify-end">
            <button className="btn btn-primary" disabled={job.status === 'PROCESSING'} onClick={onDone}>Concluir</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
