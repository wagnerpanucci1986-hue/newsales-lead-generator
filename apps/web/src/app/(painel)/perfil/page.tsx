'use client';

import QRCode from 'qrcode';
import { useState } from 'react';
import { adoptAccessToken, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function ProfilePage() {
  const { user } = useAuth();
  const [totpEnabled, setTotpEnabled] = useState(user.totpEnabled);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disable, setDisable] = useState<{ password: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    try {
      const res = await api<{ accessToken: string }>('/auth/password', { method: 'POST', body: pw });
      adoptAccessToken(res.accessToken);
      setPw({ current: '', next: '' });
      setPwMsg({ ok: true, text: 'Senha alterada. As outras sessões foram encerradas.' });
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : 'Não foi possível alterar a senha' });
    }
  }

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir');
    }
  }

  const startSetup = () => run(async () => {
    const res = await api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', { method: 'POST' });
    setSetup({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUrl, { width: 220, margin: 1 }) });
  });
  const enable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } });
      setRecovery(res.recoveryCodes);
      setTotpEnabled(true);
      setSetup(null);
      setCode('');
    });
  };
  const doDisable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/2fa/disable', { method: 'POST', body: disable });
      setTotpEnabled(false);
      setDisable(null);
      setRecovery(null);
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6 md:px-8">
      <div>
        <h1 className="text-xl font-semibold">Minha conta</h1>
        <p className="text-sm text-slate-500">{user.name} · {user.email}</p>
      </div>

      <form onSubmit={changePassword} className="card space-y-3 p-5">
        <h2 className="font-semibold">Senha</h2>
        <div><label className="label" htmlFor="pw-current">Senha atual</label><input id="pw-current" type="password" autoComplete="current-password" required className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div>
          <label className="label" htmlFor="pw-next">Nova senha</label>
          <input id="pw-next" type="password" autoComplete="new-password" required minLength={10} className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">Mínimo de 10 caracteres.</p>
        </div>
        {pwMsg && <p role={pwMsg.ok ? 'status' : 'alert'} className={`rounded-lg px-3 py-2 text-sm ${pwMsg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{pwMsg.text}</p>}
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Alterar senha</button></div>
      </form>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Verificação em duas etapas</h2>
          <p className="text-sm text-slate-500">Além da senha, o login pede um código gerado por um aplicativo autenticador no seu celular (Google Authenticator, Authy, 1Password e similares).</p>
        </div>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {recovery && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">Guarde estes códigos de recuperação em local seguro. Eles não serão mostrados de novo.</p>
            <p className="mt-1 text-sm text-amber-900">Cada um serve uma única vez para entrar se você ficar sem o celular.</p>
            <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}

        {totpEnabled && !disable && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-emerald-700">Ativa nesta conta.</p>
            <button className="btn btn-danger" onClick={() => setDisable({ password: '', code: '' })}>Desativar</button>
          </div>
        )}
        {disable && (
          <form onSubmit={doDisable} className="space-y-3">
            <div><label className="label" htmlFor="d-pw">Senha</label><input id="d-pw" type="password" required className="input" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} /></div>
            <div><label className="label" htmlFor="d-code">Código do aplicativo ou de recuperação</label><input id="d-code" required className="input" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} /></div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setDisable(null)}>Cancelar</button>
              <button type="submit" className="btn btn-danger">Desativar verificação</button>
            </div>
          </form>
        )}

        {!totpEnabled && !setup && <button className="btn btn-primary" onClick={() => void startSetup()}>Ativar verificação em duas etapas</button>}
        {!totpEnabled && setup && (
          <form onSubmit={enable} className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
              <li>Abra o aplicativo autenticador e escolha adicionar uma conta.</li>
              <li>Leia o código abaixo com a câmera, ou digite a chave manualmente.</li>
              <li>Digite aqui o código de 6 dígitos que o aplicativo mostrar.</li>
            </ol>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR Code para o aplicativo autenticador" className="rounded-lg border border-slate-200" width={220} height={220} />
            <p className="break-all text-sm text-slate-600">Chave: <code className="rounded bg-slate-100 px-1.5 py-0.5">{setup.secret}</code></p>
            <div>
              <label className="label" htmlFor="t-code">Código de 6 dígitos</label>
              <input id="t-code" inputMode="numeric" autoComplete="one-time-code" required className="input max-w-40 tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary">Confirmar e ativar</button>
              <button type="button" className="btn btn-secondary" onClick={() => setSetup(null)}>Cancelar</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
