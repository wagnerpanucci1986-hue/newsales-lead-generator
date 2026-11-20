'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { WEEKDAYS } from '@/lib/crm';
import type { SdrConfig } from '@/lib/sdr';

/** Configuração da IA do SDR: persona, consultores, agenda, follow-ups e base de conhecimento. */
export function SdrConfigForm({ initial, canEdit, onSaved }: { initial: SdrConfig; canEdit: boolean; onSaved: (c: SdrConfig) => void }) {
  const [cfg, setCfg] = useState(initial);
  const [followUps, setFollowUps] = useState(initial.followUpDays.join(', '));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof SdrConfig>(k: K, v: SdrConfig[K]) => {
    setSaved(false);
    setCfg((c) => ({ ...c, [k]: v }));
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const followUpDays = followUps.split(/[,\s]+/).map(Number).filter((n) => n > 0);
      const r = await api<{ sdr: SdrConfig }>('/settings/sdr', { method: 'PUT', body: { ...cfg, followUpDays } });
      setCfg(r.sdr);
      onSaved(r.sdr);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar');
    }
  }

  const consultant = (i: number, patch: Partial<SdrConfig['consultants'][number]>) => set('consultants', cfg.consultants.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <form onSubmit={save}>
      <fieldset disabled={!canEdit} className="space-y-5">
        {!canEdit && <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">Só administradores alteram a IA do SDR.</p>}
        <section className="card space-y-4 p-5">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span><span className="font-medium">IA do SDR ligada</span><span className="block text-slate-500">Desligada, nenhuma conversa é respondida pela IA, nem os follow-ups.</span></span>
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label" htmlFor="sdr-name">Nome do SDR</label><input id="sdr-name" className="input" maxLength={40} value={cfg.agentName} onChange={(e) => set('agentName', e.target.value)} /></div>
            <div>
              <label className="label" htmlFor="sdr-delay">Esperar antes de responder (s)</label>
              <input id="sdr-delay" type="number" min={5} max={600} className="input" value={cfg.replyDelaySeconds} onChange={(e) => set('replyDelaySeconds', Number(e.target.value))} />
              <p className="mt-1 text-xs text-slate-500">Junta mensagens seguidas do lead e evita resposta instantânea de robô.</p>
            </div>
            <div>
              <label className="label" htmlFor="sdr-effort">Profundidade do raciocínio</label>
              <select id="sdr-effort" className="input" value={cfg.effort} onChange={(e) => set('effort', e.target.value as SdrConfig['effort'])}>
                <option value="low">Baixa (mais rápida e barata)</option>
                <option value="medium">Média (recomendada)</option>
                <option value="high">Alta (mais cuidadosa e cara)</option>
              </select>
            </div>
          </div>
        </section>

        <section className="card space-y-3 p-5">
          <div>
            <h2 className="font-semibold">Consultores</h2>
            <p className="text-sm text-slate-500">A IA oferece horários livres na agenda Google de cada consultor ativo e marca com quem estiver livre. O e-mail é o da agenda dele.</p>
          </div>
          {cfg.consultants.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input className="input max-w-48" aria-label={`Nome do consultor ${i + 1}`} placeholder="Nome" value={c.name} onChange={(e) => consultant(i, { name: e.target.value })} />
              <input className="input max-w-72" type="email" aria-label={`E-mail do consultor ${i + 1}`} placeholder="email@gruponewsales.com.br" value={c.email} onChange={(e) => consultant(i, { email: e.target.value })} />
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="accent-emerald-600" checked={c.active} onChange={(e) => consultant(i, { active: e.target.checked })} />Ativo</label>
              <button type="button" className="text-sm font-medium text-red-700 hover:underline" onClick={() => set('consultants', cfg.consultants.filter((_, j) => j !== i))}>Remover</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary" onClick={() => set('consultants', [...cfg.consultants, { name: '', email: '', active: true }])}>Adicionar consultor</button>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="font-semibold">Reuniões e follow-ups</h2>
          <div className="grid gap-4 sm:grid-cols-4">
            <div><label className="label" htmlFor="sdr-min">Duração (min)</label><input id="sdr-min" type="number" min={10} max={120} className="input" value={cfg.meetingMinutes} onChange={(e) => set('meetingMinutes', Number(e.target.value))} /></div>
            <div><label className="label" htmlFor="sdr-start">Das</label><input id="sdr-start" type="time" className="input" value={cfg.meetingStart} onChange={(e) => set('meetingStart', e.target.value)} /></div>
            <div><label className="label" htmlFor="sdr-end">Até</label><input id="sdr-end" type="time" className="input" value={cfg.meetingEnd} onChange={(e) => set('meetingEnd', e.target.value)} /></div>
            <div><label className="label" htmlFor="sdr-notice">Antecedência mínima (h)</label><input id="sdr-notice" type="number" min={0} max={72} className="input" value={cfg.minNoticeHours} onChange={(e) => set('minNoticeHours', Number(e.target.value))} /></div>
          </div>
          <fieldset>
            <legend className="label">Dias com reunião</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, i) => (
                <button key={d} type="button" aria-pressed={cfg.meetingDays.includes(i)} onClick={() => set('meetingDays', cfg.meetingDays.includes(i) ? cfg.meetingDays.filter((x) => x !== i) : [...cfg.meetingDays, i].sort())} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${cfg.meetingDays.includes(i) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500'}`}>{d}</button>
              ))}
            </div>
          </fieldset>
          <div className="max-w-sm">
            <label className="label" htmlFor="sdr-fu">Follow-ups sem resposta (dias)</label>
            <input id="sdr-fu" className="input" value={followUps} onChange={(e) => { setFollowUps(e.target.value); setSaved(false); }} placeholder="2, 5, 10" />
            <p className="mt-1 text-xs text-slate-500">Contados desde a última mensagem da IA. O último é a despedida cordial; depois dele, o lead fica como frio. Saem só no horário de atendimento (Configurações).</p>
          </div>
        </section>

        <section className="card space-y-3 p-5">
          <div>
            <h2 className="font-semibold">Base de conhecimento</h2>
            <p className="text-sm text-slate-500">Tudo o que a IA sabe sobre a New Sales: missão, roteiro, objeções, tom e limites. Veio do seu documento; edite aqui quando o roteiro mudar.</p>
          </div>
          <textarea className="input min-h-96 font-mono text-xs" aria-label="Base de conhecimento" maxLength={60_000} value={cfg.knowledgeBase} onChange={(e) => set('knowledgeBase', e.target.value)} />
          <p className="text-xs text-slate-500">{cfg.knowledgeBase.length.toLocaleString('pt-BR')} de 60.000 caracteres.</p>
        </section>
      </fieldset>
      {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {canEdit && (
        <div className="sticky bottom-0 mt-4 flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50/95 py-3">
          {saved && <span className="text-sm text-emerald-700">Salvo.</span>}
          <button className="btn btn-primary" type="submit">Salvar configuração</button>
        </div>
      )}
    </form>
  );
}
