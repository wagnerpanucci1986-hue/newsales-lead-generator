'use client';

import { useCallback, useEffect, useState } from 'react';
import { GoogleCard } from '@/components/sdr/GoogleCard';
import { SdrConfigForm } from '@/components/sdr/SdrConfigForm';
import { SdrOverview } from '@/components/sdr/SdrOverview';
import { Simulator } from '@/components/sdr/Simulator';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SdrConfig, SdrStatus } from '@/lib/sdr';

const TABS = [
  ['overview', 'Visão geral'],
  ['config', 'Configuração'],
  ['google', 'Google Agenda'],
  ['test', 'Testar'],
] as const;
type Tab = (typeof TABS)[number][0];

export default function SdrPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<SdrStatus | null>(null);
  const [config, setConfig] = useState<SdrConfig | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(() => api<SdrStatus>('/sdr/status').then(setStatus).catch((err) => setError(err.message)), []);
  useEffect(() => {
    void loadStatus();
    api<{ sdr: SdrConfig }>('/settings').then((r) => setConfig(r.sdr)).catch((err) => setError(err.message));
    // Volta da autorização do Google: ?google=ok ou ?google=erro&msg=…
    const p = new URLSearchParams(window.location.search);
    if (p.get('google')) {
      setTab('google');
      setNotice(p.get('google') === 'ok' ? { ok: true, text: 'Google Agenda conectado.' } : { ok: false, text: p.get('msg') ?? 'Não foi possível conectar o Google Agenda.' });
      window.history.replaceState(null, '', '/sdr');
    }
  }, [loadStatus]);

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
      <div>
        <h1 className="text-xl font-semibold">SDR (IA)</h1>
        <p className="text-sm text-slate-500">A IA atende quem responde às campanhas com SDR: qualifica, marca a reunião com o consultor e faz os follow-ups.</p>
      </div>
      <nav aria-label="Seções do SDR" className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)} className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{label}</button>
        ))}
      </nav>
      {notice && <p role="status" className={`rounded-lg px-4 py-3 text-sm ${notice.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-700'}`}>{notice.text}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {tab === 'overview' && status && <SdrOverview status={status} />}
      {tab === 'config' && config && <SdrConfigForm initial={config} canEdit={isAdmin} onSaved={(c) => { setConfig(c); void loadStatus(); }} />}
      {tab === 'google' && status && <GoogleCard status={status.google} canEdit={isAdmin} onChange={() => void loadStatus()} />}
      {tab === 'test' && (status && !status.hasApiKey ? <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">Para testar, coloque a chave da API da Anthropic (ANTHROPIC_API_KEY) no arquivo .env e reinicie o sistema.</p> : <Simulator />)}
    </div>
  );
}
