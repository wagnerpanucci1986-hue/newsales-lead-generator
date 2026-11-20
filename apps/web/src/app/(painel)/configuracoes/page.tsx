'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { InstagramConnectionCard } from '@/components/instagram/ConnectionCard';

interface Settings {
  optOut: { keywords: string[]; confirmation: string };
  antiBan: { warmupStart: number; warmupGrowth: number; maxConsecutiveFailures: number; minDeliveryRate: number; deliverySample: number };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keywords, setKeywords] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Settings>('/settings')
      .then((s) => {
        setSettings(s);
        setKeywords(s.optOut.keywords.join(', '));
      })
      .catch((err) => setError(err.message));
  }, []);

  async function save(key: keyof Settings, value: unknown) {
    setError(null);
    setSaved(null);
    try {
      const res = await api<Partial<Settings>>(`/settings/${key}`, { method: 'PUT', body: value });
      setSettings((s) => (s ? { ...s, ...res } : s));
      setSaved(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar');
    }
  }

  if (!settings) return <p className="p-6 text-sm text-slate-500">{error ?? 'Carregando…'}</p>;
  const ab = settings.antiBan;
  const setAb = (k: keyof Settings['antiBan']) => (e: React.ChangeEvent<HTMLInputElement>) => setSettings((s) => (s ? { ...s, antiBan: { ...s.antiBan, [k]: Number(e.target.value) } } : s));
  // Dias até o aquecimento alcançar 200 mensagens/dia, só como referência.
  const daysTo200 = ab.warmupGrowth > 1 ? Math.max(1, Math.ceil(Math.log(200 / ab.warmupStart) / Math.log(ab.warmupGrowth)) + 1) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 md:px-8">
      <h1 className="text-xl font-semibold">Configurações</h1>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <form className="card space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void save('optOut', { keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean), confirmation: settings.optOut.confirmation }); }}>
        <div>
          <h2 className="font-semibold">Descadastro</h2>
          <p className="text-sm text-slate-500">Quando um contato envia exatamente uma destas palavras, ele entra na lista de bloqueio, sai das campanhas pendentes e recebe a confirmação abaixo, uma única vez.</p>
        </div>
        <div>
          <label className="label" htmlFor="st-keywords">Palavras de descadastro (separadas por vírgula)</label>
          <input id="st-keywords" className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Maiúsculas, acentos e pontuação são ignorados: “Sair!” vale como “SAIR”.</p>
        </div>
        <div>
          <label className="label" htmlFor="st-confirm">Mensagem de confirmação</label>
          <textarea id="st-confirm" className="input min-h-20" maxLength={500} value={settings.optOut.confirmation} onChange={(e) => setSettings((s) => (s ? { ...s, optOut: { ...s.optOut, confirmation: e.target.value } } : s))} />
        </div>
        <div className="flex items-center justify-end gap-3">
          {saved === 'optOut' && <span className="text-sm text-emerald-700">Salvo.</span>}
          <button className="btn btn-primary" type="submit">Salvar</button>
        </div>
      </form>

      <form className="card space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void save('antiBan', ab); }}>
        <div>
          <h2 className="font-semibold">Proteção contra banimento</h2>
          <p className="text-sm text-slate-500">Valem para todos os números. O intervalo entre mensagens e as pausas longas são definidos em cada campanha.</p>
        </div>
        <fieldset disabled={user.role !== 'ADMIN'} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="st-wstart">Aquecimento: mensagens no 1º dia</label>
              <input id="st-wstart" type="number" min={1} max={500} className="input" value={ab.warmupStart} onChange={setAb('warmupStart')} />
            </div>
            <div>
              <label className="label" htmlFor="st-wgrowth">Aquecimento: crescimento por dia</label>
              <input id="st-wgrowth" type="number" min={1} max={3} step={0.05} className="input" value={ab.warmupGrowth} onChange={setAb('warmupGrowth')} />
              <p className="mt-1 text-xs text-slate-500">{daysTo200 ? `Com estes valores, um número novo chega a 200 mensagens por dia em cerca de ${daysTo200} dias.` : 'Com crescimento 1, o volume não aumenta.'}</p>
            </div>
            <div>
              <label className="label" htmlFor="st-fail">Pausar o número após falhas seguidas</label>
              <input id="st-fail" type="number" min={2} max={50} className="input" value={ab.maxConsecutiveFailures} onChange={setAb('maxConsecutiveFailures')} />
            </div>
            <div>
              <label className="label" htmlFor="st-rate">Pausar se a entrega cair abaixo de (%)</label>
              <input id="st-rate" type="number" min={0} max={100} className="input" value={Math.round(ab.minDeliveryRate * 100)} onChange={(e) => setSettings((s) => (s ? { ...s, antiBan: { ...s.antiBan, minDeliveryRate: Number(e.target.value) / 100 } } : s))} />
              <p className="mt-1 text-xs text-slate-500">Medido nas últimas {ab.deliverySample} mensagens de campanha de cada número.</p>
            </div>
          </div>
        </fieldset>
        {user.role !== 'ADMIN' && <p className="text-sm text-slate-500">Só administradores alteram estes valores.</p>}
        <div className="flex items-center justify-end gap-3">
          {saved === 'antiBan' && <span className="text-sm text-emerald-700">Salvo.</span>}
          <button className="btn btn-primary" type="submit" disabled={user.role !== 'ADMIN'}>Salvar</button>
        </div>
      </form>
      <InstagramConnectionCard canEdit={user.role === 'ADMIN'} />
    </div>
  );
}
