'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { CnpjStatus } from '@/lib/cnpj';
import { formatDateTime } from '@/lib/crm';
import { Modal } from '../Modal';

const n = (v: number) => v.toLocaleString('pt-BR');

/** Situação da base de CNPJ e atualização a partir dos arquivos da Receita. */
export function BaseStatus({ status, onChanged }: { status: CnpjStatus; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [ufs, setUfs] = useState<string[]>(status.ufs.length ? status.ufs.map((u) => u.uf) : ['PR']);
  const [error, setError] = useState<string | null>(null);
  const running = status.imports.find((i) => i.status === 'RUNNING');
  const last = status.imports.find((i) => i.status !== 'RUNNING');
  const total = status.ufs.reduce((a, u) => a + u.total, 0);

  async function start() {
    setError(null);
    try {
      await api('/cnpj/refresh', { method: 'POST', body: { ufs } });
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar');
    }
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Base de CNPJ (Receita Federal)</h2>
          {status.ufs.length ? (
            <p className="text-sm text-slate-600">
              {n(total)} empresas ativas com telefone em {status.ufs.map((u) => u.uf).join(', ')} · {n(status.ufs.reduce((a, u) => a + u.mobile, 0))} com celular
              {last?.status === 'COMPLETED' && ` · atualizada em ${formatDateTime(last.finishedAt)}${last.competencia ? ` (dados de ${last.competencia})` : ''}`}
            </p>
          ) : (
            <p className="text-sm text-slate-600">Ainda vazia. Clique em <strong>Atualizar base</strong> para carregar as empresas de uma UF.</p>
          )}
        </div>
        <button className="btn btn-secondary" disabled={Boolean(running)} onClick={() => setOpen(true)}>{running ? 'Atualizando…' : 'Atualizar base'}</button>
      </div>

      {running && (
        <div className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900" role="status">
          <p><strong>Atualizando {running.ufs.join(', ')}:</strong> {running.progress ?? 'iniciando'}</p>
          <p className="mt-0.5 text-xs">Pode levar de 30 a 60 minutos. Você pode sair desta tela; a atualização continua.</p>
        </div>
      )}
      {!running && last?.status === 'FAILED' && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">A última atualização falhou: {last.error}</p>
      )}

      {open && (
        <Modal title="Atualizar base de CNPJ" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              O sistema baixa os arquivos públicos da Receita Federal (cerca de 7 GB, mesmo para uma UF só, porque eles não vêm separados por estado),
              mantém apenas as empresas <strong>ativas e com telefone</strong> das UFs escolhidas e apaga os arquivos ao terminar.
            </p>
            <fieldset>
              <legend className="label">UFs</legend>
              <div className="flex flex-wrap gap-1.5">
                {status.allUfs.map((uf) => (
                  <button key={uf} type="button" aria-pressed={ufs.includes(uf)} onClick={() => setUfs((s) => (s.includes(uf) ? s.filter((x) => x !== uf) : [...s, uf]))}
                    className={`w-11 rounded-lg border py-1 text-xs font-medium ${ufs.includes(uf) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500'}`}>
                    {uf}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">Cada UF a mais ocupa mais espaço no banco (o Paraná deve ficar em poucos GB).</p>
            </fieldset>
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Se o download automático falhar, baixe os arquivos pelo navegador no portal de dados abertos da Receita e coloque na pasta <code>dados-cnpj</code> do sistema; a próxima atualização usa esses arquivos.
            </p>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancelar</button>
              <button className="btn btn-primary" disabled={!ufs.length} onClick={() => void start()}>Atualizar {ufs.length} UF{ufs.length === 1 ? '' : 's'}</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
