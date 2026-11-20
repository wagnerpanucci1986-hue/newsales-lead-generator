'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { GoogleStatus } from '@/lib/sdr';

/** Google Agenda: cadastro do cliente OAuth e autorização da conta que marca as reuniões. */
export function GoogleCard({ status, canEdit, onChange }: { status: GoogleStatus; canEdit: boolean; onChange: () => void }) {
  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir');
    } finally {
      setBusy(false);
    }
  }
  const saveClient = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/google/client', { method: 'PUT', body: { clientId, clientSecret } });
      setClientSecret('');
      onChange();
    });
  };
  const connect = () => void run(async () => (window.location.href = (await api<{ url: string }>('/google/auth-url')).url));
  const disconnect = () => {
    if (confirm('Desconectar o Google Agenda? A IA deixa de marcar reuniões sozinha.')) void run(async () => { await api('/google', { method: 'DELETE' }); onChange(); });
  };

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Google Agenda</h2>
        <p className="text-sm text-slate-500">A IA lê os horários livres dos consultores e cria a reunião com link do Meet, convidando o consultor e o lead. O passo a passo está em docs/09-ia-sdr.md.</p>
      </div>
      {status.connectedAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span>Conectado com <strong>{status.email ?? 'a conta Google'}</strong> desde {new Date(status.connectedAt).toLocaleDateString('pt-BR')}. As reuniões são criadas na agenda dessa conta.</span>
          {canEdit && <button className="btn btn-secondary" disabled={busy} onClick={disconnect}>Desconectar</button>}
        </div>
      ) : (
        <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">Não conectado.</p>
      )}
      {canEdit ? (
        <>
          <form className="space-y-3" onSubmit={saveClient}>
            <p className="text-sm text-slate-600">1. No Google Cloud, crie um cliente OAuth do tipo <strong>Aplicativo da Web</strong> com este URI de redirecionamento autorizado:</p>
            <code className="block break-all rounded bg-slate-100 px-3 py-2 text-xs">{status.redirectUri}</code>
            <p className="text-sm text-slate-600">2. Cole aqui o ID e a chave secreta do cliente:</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <input className="input" aria-label="ID do cliente OAuth" placeholder="…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              <input className="input" type="password" autoComplete="off" aria-label="Chave secreta do cliente OAuth" placeholder={status.clientId ? 'Chave secreta (já guardada; preencha para trocar)' : 'Chave secreta'} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </div>
            <button className="btn btn-secondary" disabled={busy || clientId.trim().length < 20 || clientSecret.trim().length < 10}>Salvar cliente OAuth</button>
          </form>
          <div className="space-y-2">
            <p className="text-sm text-slate-600">3. Autorize a conta Google que vai criar as reuniões (precisa enxergar a agenda dos consultores):</p>
            <button className="btn btn-primary" disabled={busy || !status.clientId} onClick={connect}>{status.connectedAt ? 'Conectar outra conta' : 'Conectar Google Agenda'}</button>
          </div>
        </>
      ) : (
        !status.connectedAt && <p className="text-sm text-slate-500">Peça a um administrador para conectar.</p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
