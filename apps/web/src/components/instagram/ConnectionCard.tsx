'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { InstagramConnection } from '@/lib/instagram';

/** Configurações → Instagram: conecta a conta profissional da empresa com um token da Meta. */
export function InstagramConnectionCard({ canEdit }: { canEdit: boolean }) {
  const [conn, setConn] = useState<InstagramConnection | null | undefined>(undefined);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ connection: InstagramConnection | null }>('/instagram/connection').then((r) => setConn(r.connection)).catch((err) => setError(err.message));
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ connection: InstagramConnection }>('/instagram/connection', { method: 'PUT', body: { token, username: username || undefined } });
      setConn(r.connection);
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível conectar');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('Desconectar o Instagram? A pesquisa de perfis para de funcionar até conectar de novo.')) return;
    await api('/instagram/connection', { method: 'DELETE' }).then(() => setConn(null)).catch((err) => setError(err.message));
  }

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Instagram</h2>
        <p className="text-sm text-slate-500">Usado na Captação para pesquisar perfis comerciais pelo @, pela API oficial da Meta. Precisa de uma conta profissional do Instagram ligada a uma Página do Facebook.</p>
      </div>
      {conn === undefined && !error && <p className="text-sm text-slate-500">Carregando…</p>}
      {conn && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span>Conectado como <strong>@{conn.igUsername}</strong>{conn.pageName && <> (Página {conn.pageName})</>} desde {new Date(conn.connectedAt).toLocaleDateString('pt-BR')}.</span>
          {canEdit && <button type="button" className="btn btn-secondary" onClick={() => void disconnect()}>Desconectar</button>}
        </div>
      )}
      {canEdit ? (
        <form className="space-y-3" onSubmit={connect}>
          <div>
            <label className="label" htmlFor="ig-token">{conn ? 'Trocar o token de acesso' : 'Token de acesso da Meta'}</label>
            <input id="ig-token" className="input font-mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" />
            <p className="mt-1 text-xs text-slate-500">Prefira o token de um usuário do sistema do Gerenciador de Negócios, que não expira. Permissões: instagram_basic, instagram_manage_insights, pages_read_engagement e pages_show_list. O passo a passo está em docs/08-captacao-instagram.md.</p>
          </div>
          <div>
            <label className="label" htmlFor="ig-user">Conta do Instagram (opcional)</label>
            <input id="ig-user" className="input max-w-xs" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@suaempresa" />
            <p className="mt-1 text-xs text-slate-500">Só se o token der acesso a mais de uma conta.</p>
          </div>
          <div className="flex justify-end"><button className="btn btn-primary" disabled={busy || token.trim().length < 20}>{busy ? 'Conferindo na Meta…' : 'Conectar'}</button></div>
        </form>
      ) : (
        !conn && <p className="text-sm text-slate-500">Peça a um administrador para conectar.</p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
