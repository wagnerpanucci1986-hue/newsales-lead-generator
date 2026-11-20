'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BaseStatus } from '@/components/captacao/BaseStatus';
import { ImportModal } from '@/components/captacao/ImportModal';
import { MultiPicker, type PickOption } from '@/components/captacao/MultiPicker';
import { Pagination } from '@/components/Pagination';
import { api } from '@/lib/api';
import { DEFAULT_FILTERS, formatCnae, formatCnpj, money, PORTES, toApiFilters, type CnpjFilters, type CnpjRow, type CnpjStatus } from '@/lib/cnpj';
import { formatPhone } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';

const LIMIT = 25;
const PORTE_SHORT: Record<string, string> = { '01': 'ME', '03': 'EPP', '05': 'Demais', '00': '—' };

export default function CaptacaoPage() {
  const [status, setStatus] = useState<CnpjStatus | null>(null);
  const [filters, setFilters] = useState<CnpjFilters>(DEFAULT_FILTERS);
  const [cnaePicks, setCnaePicks] = useState<PickOption[]>([]);
  const [munPicks, setMunPicks] = useState<PickOption[]>([]);
  const [natPicks, setNatPicks] = useState<PickOption[]>([]);
  const [applied, setApplied] = useState<CnpjFilters | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ total: number; rows: CnpjRow[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(() => {
    api<CnpjStatus>('/cnpj/status')
      .then((s) => {
        setStatus(s);
        // UF padrão: a primeira já carregada.
        setFilters((f) => (s.ufs.length && !s.ufs.some((u) => u.uf === f.uf) ? { ...f, uf: s.ufs[0]!.uf } : f));
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSocketEvent('cnpj.updated', () => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      loadStatus();
    }, 1500);
  });

  const set = <K extends keyof CnpjFilters>(k: K, v: CnpjFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'portes' | 'ddds', v: string) => setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  // A busca usa os filtros aplicados (botão Buscar), não cada tecla.
  useEffect(() => {
    if (!applied) return;
    let active = true;
    setLoading(true);
    setError(null);
    api<{ total: number; rows: CnpjRow[] }>('/cnpj/search', { method: 'POST', body: { filters: toApiFilters(applied), page, limit: LIMIT } })
      .then((r) => active && setResult(r))
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Não foi possível buscar'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [applied, page]);

  function search(e?: React.FormEvent) {
    e?.preventDefault();
    setSelected(new Set());
    setPage(1);
    setApplied({ ...filters, cnaes: cnaePicks.map((p) => p.value), municipios: munPicks.map((p) => p.value), naturezas: natPicks.map((p) => p.value) });
  }

  const searchCnaes = useCallback(async (q: string) => {
    if (q.trim().length < 2) return [];
    const r = await api<{ cnaes: { code: string; description: string }[] }>(`/cnpj/cnaes?q=${encodeURIComponent(q)}`);
    return r.cnaes.map((c) => ({ value: c.code, label: `${formatCnae(c.code)} ${c.description}` }));
  }, []);
  const searchMunicipios = useCallback(async (q: string) => {
    const r = await api<{ municipios: { code: string; name: string; total: number }[] }>(`/cnpj/municipios?uf=${filters.uf}&q=${encodeURIComponent(q)}`);
    return r.municipios.map((m) => ({ value: m.code, label: m.name, hint: m.total.toLocaleString('pt-BR') }));
  }, [filters.uf]);
  const searchNaturezas = useCallback(async (q: string) => {
    const r = await api<{ naturezas: { code: string; description: string }[] }>('/cnpj/naturezas');
    const t = q.toLowerCase();
    return r.naturezas.filter((n) => !t || n.description.toLowerCase().includes(t) || n.code.includes(t)).slice(0, 30).map((n) => ({ value: n.code, label: n.description, hint: n.code }));
  }, []);

  const loadedUfs = status?.ufs ?? [];
  const pageCnpjs = result?.rows.map((r) => r.cnpj) ?? [];
  const allOnPage = pageCnpjs.length > 0 && pageCnpjs.every((c) => selected.has(c));
  // Etiqueta de segmento sugerida: duas primeiras palavras relevantes da atividade ("Limpeza Prédios").
  const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'em', 'e', 'a', 'o', 'para', 'com', 'comércio', 'varejista', 'atacadista', 'serviços']);
  const segment =
    cnaePicks.length === 1
      ? cnaePicks[0]!.label.split(' ').slice(1).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase())).slice(0, 2).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : '';

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
      <div>
        <h1 className="text-xl font-semibold">Captação</h1>
        <p className="text-sm text-slate-500">Empresas ativas da base pública de CNPJ da Receita Federal, prontas para virar contatos.</p>
      </div>
      {status && <BaseStatus status={status} onChanged={loadStatus} />}
      <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Prospecção fria pede cuidado.</strong> A base é pública, mas o telefone de MEI e empresário individual costuma ser da própria pessoa. Use legítimo interesse com opção de saída em toda mensagem, mande para quem tem relação com o que você vende e comece com lotes pequenos: denúncias de quem não esperava a mensagem são a principal causa de banimento.
      </div>

      {loadedUfs.length > 0 && (
        <form onSubmit={search} className="card space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="label" htmlFor="f-uf">UF</label>
              <select id="f-uf" className="input" value={filters.uf} onChange={(e) => { set('uf', e.target.value); setMunPicks([]); }}>
                {loadedUfs.map((u) => <option key={u.uf} value={u.uf}>{u.uf} ({u.total.toLocaleString('pt-BR')})</option>)}
              </select>
            </div>
            <MultiPicker label="Municípios" placeholder="Digite para buscar" selected={munPicks} onChange={setMunPicks} search={searchMunicipios} />
            <div className="md:col-span-2">
              <MultiPicker label="Atividade (CNAE)" placeholder="Ex.: material de escritório, 4761" selected={cnaePicks} onChange={setCnaePicks} search={searchCnaes} />
              <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" className="accent-emerald-600" checked={filters.includeSecondary} onChange={(e) => set('includeSecondary', e.target.checked)} />
                Incluir quem tem a atividade como secundária
              </label>
            </div>
          </div>

          <details className="group" open>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Mais filtros</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <fieldset>
                <legend className="label">Porte</legend>
                <div className="flex flex-wrap gap-1.5">
                  {PORTES.map(([v, l]) => (
                    <button key={v} type="button" aria-pressed={filters.portes.includes(v)} onClick={() => toggle('portes', v)} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${filters.portes.includes(v) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500'}`}>{l}</button>
                  ))}
                </div>
              </fieldset>
              <div>
                <span className="label">Capital social (R$)</span>
                <div className="flex items-center gap-2">
                  <input className="input" inputMode="numeric" placeholder="mínimo" aria-label="Capital social mínimo" value={filters.capitalMin} onChange={(e) => set('capitalMin', e.target.value)} />
                  <input className="input" inputMode="numeric" placeholder="máximo" aria-label="Capital social máximo" value={filters.capitalMax} onChange={(e) => set('capitalMax', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="f-mei">MEI</label>
                <select id="f-mei" className="input" value={filters.mei} onChange={(e) => set('mei', e.target.value as CnpjFilters['mei'])}>
                  <option value="exclude">Excluir MEI</option>
                  <option value="any">Incluir MEI</option>
                  <option value="only">Somente MEI</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="f-matriz">Matriz ou filial</label>
                <select id="f-matriz" className="input" value={filters.matriz} onChange={(e) => set('matriz', e.target.value as CnpjFilters['matriz'])}>
                  <option value="matriz">Somente matriz</option>
                  <option value="any">Matriz e filiais</option>
                  <option value="filial">Somente filiais</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="f-phone">Telefone</label>
                <select id="f-phone" className="input" value={filters.phone} onChange={(e) => set('phone', e.target.value as CnpjFilters['phone'])}>
                  <option value="mobile">Com celular</option>
                  <option value="any">Qualquer telefone</option>
                  <option value="fixed">Somente fixo</option>
                </select>
              </div>
              <MultiPicker label="Natureza jurídica" placeholder="Ex.: limitada" selected={natPicks} onChange={setNatPicks} search={searchNaturezas} />
              <div><label className="label" htmlFor="f-bairro">Bairro</label><input id="f-bairro" className="input" value={filters.bairro} onChange={(e) => set('bairro', e.target.value)} /></div>
              <div><label className="label" htmlFor="f-cep">CEP (início)</label><input id="f-cep" className="input" inputMode="numeric" placeholder="Ex.: 860" value={filters.cep} onChange={(e) => set('cep', e.target.value)} /></div>
              <div>
                <label className="label" htmlFor="f-ddd">DDD (separados por vírgula)</label>
                <input id="f-ddd" className="input" inputMode="numeric" placeholder="Ex.: 43, 44" value={filters.ddds.join(', ')} onChange={(e) => set('ddds', e.target.value.split(/[,\s]+/).map((d) => d.replace(/\D/g, '')).filter((d) => d.length === 2))} />
              </div>
              <div className="md:col-span-2"><label className="label" htmlFor="f-q">Nome ou CNPJ</label><input id="f-q" className="input" value={filters.q} onChange={(e) => set('q', e.target.value)} /></div>
              <div className="flex flex-col justify-end gap-1.5 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-emerald-600" checked={filters.withEmail} onChange={(e) => set('withEmail', e.target.checked)} />Somente com e-mail</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-emerald-600" checked={filters.hideKnown} onChange={(e) => set('hideKnown', e.target.checked)} />Esconder quem já é contato ou está bloqueado</label>
                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 accent-emerald-600" checked={filters.hideSharedPhones} onChange={(e) => set('hideSharedPhones', e.target.checked)} /><span>Esconder telefones usados por 3 ou mais empresas <span className="block text-xs text-slate-500">Em geral é o telefone do contador.</span></span></label>
              </div>
            </div>
          </details>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => { setFilters({ ...DEFAULT_FILTERS, uf: filters.uf }); setCnaePicks([]); setMunPicks([]); setNatPicks([]); }}>Limpar</button>
            <button type="submit" className="btn btn-primary">Buscar empresas</button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {result && (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600"><strong className="text-slate-900">{result.total.toLocaleString('pt-BR')}</strong> empresas encontradas{selected.size > 0 && ` · ${selected.size} marcadas`}{loading && ' · atualizando…'}</p>
            <button className="btn btn-primary" disabled={!result.total} onClick={() => setImporting(true)}>
              {selected.size ? `Importar ${selected.size} marcadas` : 'Importar para Contatos'}
            </button>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2.5"><input type="checkbox" aria-label="Marcar todas desta página" className="accent-emerald-600" checked={allOnPage} onChange={(e) => setSelected((s) => { const n = new Set(s); for (const c of pageCnpjs) if (e.target.checked) n.add(c); else n.delete(c); return n; })} /></th>
                  <th className="px-3 py-2.5">Empresa</th>
                  <th className="px-3 py-2.5">Atividade</th>
                  <th className="px-3 py-2.5">Local</th>
                  <th className="px-3 py-2.5">Contato</th>
                  <th className="px-3 py-2.5 text-right">Capital</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((r) => (
                  <tr key={r.cnpj} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2.5"><input type="checkbox" aria-label={`Marcar ${r.nomeFantasia ?? r.razaoSocial ?? r.cnpj}`} className="accent-emerald-600" checked={selected.has(r.cnpj)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.cnpj); else n.delete(r.cnpj); return n; })} /></td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{r.nomeFantasia || r.razaoSocial}</p>
                      {r.nomeFantasia && <p className="text-xs text-slate-500">{r.razaoSocial}</p>}
                      <p className="text-xs text-slate-500">{formatCnpj(r.cnpj)} · {r.isMatriz ? 'Matriz' : 'Filial'} · {r.isMei ? 'MEI' : PORTE_SHORT[r.porte ?? '00'] ?? '—'}</p>
                    </td>
                    <td className="max-w-xs px-3 py-2.5 text-xs text-slate-600">{formatCnae(r.cnaePrincipal)} {r.cnaeDescricao}</td>
                    <td className="px-3 py-2.5 text-slate-600">{r.municipio}<span className="block text-xs text-slate-500">{r.bairro}</span></td>
                    <td className="px-3 py-2.5">
                      <p>{formatPhone(r.mobile ?? r.phone)}{!r.mobile && <span className="ml-1 text-xs text-slate-500">(fixo)</span>}</p>
                      {r.phoneShared > 1 && <p className="text-xs text-amber-700">mesmo telefone em {r.phoneShared} empresas</p>}
                      {r.email && <p className="max-w-[14rem] truncate text-xs text-slate-500">{r.email}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-600">{money(r.capitalSocial)}</td>
                  </tr>
                ))}
                {result.rows.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">Nenhuma empresa com esses filtros.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={page} limit={LIMIT} total={Math.min(result.total, LIMIT * 400)} onPage={setPage} />
        </section>
      )}

      {importing && applied && result && (
        <ImportModal filters={applied} selected={[...selected]} total={result.total} segment={segment} onClose={() => setImporting(false)} onDone={() => { setImporting(false); setSelected(new Set()); search(); }} />
      )}
    </div>
  );
}
