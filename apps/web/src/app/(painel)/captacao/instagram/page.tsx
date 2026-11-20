'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CaptacaoTabs } from '@/components/captacao/CaptacaoTabs';
import { ImportModal } from '@/components/captacao/ImportModal';
import { Pagination } from '@/components/Pagination';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { compactNumber, type InstagramConnection, type InstagramProfile, type LookupResponse } from '@/lib/instagram';
import { formatPhone } from '@/lib/numbers';

const LIMIT = 25;

export default function InstagramCaptacaoPage() {
  const { user } = useAuth();
  const [conn, setConn] = useState<InstagramConnection | null | undefined>(undefined);
  const [maxLookup, setMaxLookup] = useState(30);
  const [input, setInput] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  // Histórico de perfis já pesquisados.
  const [q, setQ] = useState('');
  const [withPhone, setWithPhone] = useState(true);
  const [hideKnown, setHideKnown] = useState(true);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<{ total: number; profiles: InstagramProfile[] } | null>(null);

  useEffect(() => {
    api<{ connection: InstagramConnection | null; maxLookup: number }>('/instagram/connection')
      .then((r) => { setConn(r.connection); setMaxLookup(r.maxLookup); })
      .catch((err) => setError(err.message));
  }, []);

  const loadHistory = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(LIMIT), withPhone: String(withPhone), hideKnown: String(hideKnown) });
    if (q.trim()) p.set('q', q.trim());
    api<{ total: number; profiles: InstagramProfile[] }>(`/instagram/profiles?${p}`).then(setHistory).catch((err) => setError(err.message));
  }, [page, q, withPhone, hideKnown]);
  useEffect(() => {
    const t = setTimeout(loadHistory, 250);
    return () => clearTimeout(t);
  }, [loadHistory]);

  const count = input.split(/[\s,;]+/).filter(Boolean).length;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<LookupResponse>('/instagram/lookup', { method: 'POST', body: { input, force } });
      setLookup(r);
      // Já marca quem tem telefone.
      setSelected((s) => new Set([...s, ...r.profiles.filter((p) => !p.error && p.phones.length).map((p) => p.username)]));
      // O que não foi consultado (limite da Meta) fica na caixa para tentar depois.
      setInput(r.pending.map((u) => `@${u}`).join('\n'));
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível pesquisar');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (u: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(u); else n.delete(u); return n; });

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
      <div>
        <h1 className="text-xl font-semibold">Captação</h1>
        <p className="text-sm text-slate-500">Perfis comerciais do Instagram pesquisados pelo @, com a API oficial da Meta.</p>
      </div>
      <CaptacaoTabs />

      {conn === null && (
        <div className="card p-5 text-sm">
          <p className="font-medium">O Instagram ainda não está conectado.</p>
          <p className="mt-1 text-slate-600">
            {user.role === 'ADMIN' ? <>Conecte a conta profissional da empresa em <Link className="text-brand-700 underline" href="/configuracoes">Configurações → Instagram</Link>.</> : 'Peça a um administrador para conectar em Configurações → Instagram.'}
          </p>
        </div>
      )}

      <div role="note" className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <strong>O que esta pesquisa traz:</strong> nome, bio, site, seguidores e data do último post de perfis <em>comerciais ou de criador</em>. A Meta não entrega telefone nem lista seguidores: o telefone só aparece quando a empresa o escreveu na bio ou usa um link de WhatsApp. Perfis pessoais e privados não aparecem.
      </div>

      {conn && (
        <form onSubmit={search} className="card space-y-3 p-4">
          <div>
            <label className="label" htmlFor="ig-input">Perfis para pesquisar (@ ou link, um por linha)</label>
            <textarea id="ig-input" className="input min-h-28 font-mono text-sm" placeholder={'@lojaexemplo\nhttps://www.instagram.com/outraloja/'} value={input} onChange={(e) => setInput(e.target.value)} />
            <p className={`mt-1 text-xs ${count > maxLookup ? 'text-red-700' : 'text-slate-500'}`}>{count} de até {maxLookup} por vez. Perfis pesquisados nos últimos 7 dias vêm do histórico, sem gastar consulta.</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={force} onChange={(e) => setForce(e.target.checked)} />Consultar de novo mesmo os recentes</label>
            <button className="btn btn-primary" disabled={busy || count === 0 || count > maxLookup}>{busy ? `Consultando ${count} perfis…` : 'Pesquisar'}</button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {lookup && (
        <section className="space-y-2">
          <h2 className="font-semibold">Resultado da pesquisa</h2>
          {lookup.stopReason && (
            <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">{lookup.stopReason} {lookup.pending.length === 1 && <>Ficou 1 perfil sem consultar; ele voltou para a caixa acima.</>}
              {lookup.pending.length > 1 && <>Ficaram {lookup.pending.length} perfis sem consultar; eles voltaram para a caixa acima.</>}</p>
          )}
          {lookup.invalid.length > 0 && <p className="text-sm text-slate-600">Não entendi como perfil: {lookup.invalid.join(', ')}</p>}
          <ProfileTable profiles={lookup.profiles} selected={selected} onToggle={toggle} />
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Perfis já pesquisados</h2>
            <p className="text-sm text-slate-500">{history ? `${history.total.toLocaleString('pt-BR')} perfis` : 'Carregando…'}{selected.size > 0 && ` · ${selected.size} ${selected.size === 1 ? 'marcado' : 'marcados'}`}</p>
          </div>
          <button className="btn btn-primary" disabled={!selected.size} onClick={() => setImporting(true)}>{selected.size ? `Importar ${selected.size} para Contatos` : 'Marque perfis com telefone'}</button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <input className="input max-w-xs" aria-label="Filtrar por @, nome ou bio" placeholder="Filtrar por @, nome ou bio" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={withPhone} onChange={(e) => { setWithPhone(e.target.checked); setPage(1); }} />Só com telefone</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={hideKnown} onChange={(e) => { setHideKnown(e.target.checked); setPage(1); }} />Esconder quem já é contato ou está bloqueado</label>
        </div>
        {history && <ProfileTable profiles={history.profiles} selected={selected} onToggle={toggle} />}
        {history && <Pagination page={page} limit={LIMIT} total={history.total} onPage={setPage} />}
      </section>

      {importing && (
        <ImportModal instagram={[...selected]} onClose={() => setImporting(false)} onDone={() => { setImporting(false); setSelected(new Set()); loadHistory(); }} />
      )}
    </div>
  );
}

function ProfileTable({ profiles, selected, onToggle }: { profiles: InstagramProfile[]; selected: Set<string>; onToggle: (u: string, on: boolean) => void }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-10 px-3 py-2.5"><span className="sr-only">Marcar</span></th>
            <th className="px-3 py-2.5">Perfil</th>
            <th className="px-3 py-2.5">Bio</th>
            <th className="px-3 py-2.5 text-right">Seguidores</th>
            <th className="px-3 py-2.5">Último post</th>
            <th className="px-3 py-2.5">Contato</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {profiles.map((p) => {
            const importable = !p.error && p.phones.length > 0;
            return (
              <tr key={p.username} className="align-top hover:bg-slate-50">
                <td className="px-3 py-2.5">
                  <input type="checkbox" className="accent-emerald-600" aria-label={`Marcar @${p.username}`} disabled={!importable} checked={selected.has(p.username)} onChange={(e) => onToggle(p.username, e.target.checked)} />
                </td>
                <td className="px-3 py-2.5">
                  <a className="font-medium text-brand-700 hover:underline" href={`https://www.instagram.com/${p.username}/`} target="_blank" rel="noreferrer">@{p.username}</a>
                  {p.name && <p className="text-xs text-slate-500">{p.name}</p>}
                </td>
                {p.error ? (
                  <td colSpan={4} className="px-3 py-2.5 text-sm text-slate-500">{p.error}</td>
                ) : (
                  <>
                    <td className="max-w-sm px-3 py-2.5 text-xs text-slate-600"><p className="line-clamp-3 whitespace-pre-line">{p.biography || '—'}</p>{p.website && <p className="mt-1 truncate text-slate-500">{p.website}</p>}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-600">{compactNumber(p.followersCount)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{p.lastPostAt ? new Date(p.lastPostAt).toLocaleDateString('pt-BR') : '—'}</td>
                    <td className="px-3 py-2.5">
                      {p.phones.length ? p.phones.map((ph, i) => <p key={ph} className={i ? 'text-xs text-slate-500' : ''}>{formatPhone(ph)}</p>) : <p className="text-xs text-slate-500">sem telefone na bio</p>}
                      {p.emails[0] && <p className="max-w-[14rem] truncate text-xs text-slate-500">{p.emails[0]}</p>}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
          {profiles.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">Nenhum perfil.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
