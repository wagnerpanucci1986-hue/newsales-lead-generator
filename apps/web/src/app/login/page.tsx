'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, login } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password, needsCode ? code : undefined);
      router.replace('/dashboard');
    } catch (err) {
      // Senha certa e conta com verificação em duas etapas: pede o código.
      if (err instanceof ApiError && err.body.twoFactorRequired && !needsCode) setNeedsCode(true);
      else setError(err instanceof Error ? err.message : 'Não foi possível entrar');
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold">NewSales WhatsApp</h1>
          <p className="text-sm text-slate-500">{needsCode ? 'Digite o código do seu aplicativo autenticador.' : 'Entre com sua conta para acessar o painel.'}</p>
        </div>
        {!needsCode ? (
          <>
            <div>
              <label className="label" htmlFor="email">E-mail</label>
              <input id="email" type="email" autoComplete="username" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="password">Senha</label>
              <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : (
          <div>
            <label className="label" htmlFor="code">Código de verificação</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required className="input tracking-widest" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Sem o celular? Use um dos códigos de recuperação.</p>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={loading}>{loading ? 'Entrando…' : needsCode ? 'Verificar' : 'Entrar'}</button>
        {needsCode && <button type="button" className="w-full text-sm font-medium text-slate-600 hover:underline" onClick={() => { setNeedsCode(false); setCode(''); setError(null); }}>Voltar</button>}
      </form>
    </main>
  );
}
