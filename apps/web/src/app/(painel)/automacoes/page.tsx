'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import { api } from '@/lib/api';
import { WEEKDAYS } from '@/lib/crm';
import type { WaNumber } from '@/lib/numbers';

type Trigger = 'KEYWORD' | 'OUT_OF_HOURS';
type Match = 'EXACT' | 'CONTAINS' | 'STARTS_WITH';
type Action = 'REPLY' | 'HANDOFF';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: Trigger;
  matchType: Match;
  keywords: string[];
  numberId: string | null;
  action: Action;
  responseText: string | null;
  cooldownMinutes: number;
  number: { id: string; nickname: string } | null;
}
interface Hours { timezone: string; days: number[]; start: string; end: string }

const MATCH_LABEL: Record<Match, string> = { CONTAINS: 'contém a palavra', EXACT: 'é exatamente', STARTS_WITH: 'começa com' };
const blank = { name: '', enabled: true, priority: 0, trigger: 'KEYWORD' as Trigger, matchType: 'CONTAINS' as Match, keywords: '', numberId: '', action: 'REPLY' as Action, responseText: '', cooldownMinutes: 60 };

export default function AutomationsPage() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [hours, setHours] = useState<Hours | null>(null);
  const [editing, setEditing] = useState<{ id?: string; form: typeof blank } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [hoursSaved, setHoursSaved] = useState(false);

  const load = useCallback(() => api<{ rules: Rule[] }>('/automations').then((r) => setRules(r.rules)).catch((err) => setError(err.message)), []);
  useEffect(() => {
    void load();
    api<{ numbers: WaNumber[] }>('/numbers').then((r) => setNumbers(r.numbers)).catch(() => undefined);
    api<{ businessHours: Hours }>('/settings').then((r) => setHours(r.businessHours)).catch(() => undefined);
  }, [load]);

  const edit = (r: Rule) => setEditing({ id: r.id, form: { name: r.name, enabled: r.enabled, priority: r.priority, trigger: r.trigger, matchType: r.matchType, keywords: r.keywords.join(', '), numberId: r.numberId ?? '', action: r.action, responseText: r.responseText ?? '', cooldownMinutes: r.cooldownMinutes } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setFormError(null);
    const f = editing.form;
    try {
      const body = { ...f, keywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean), numberId: f.numberId || null, responseText: f.responseText || null };
      await api(editing.id ? `/automations/${editing.id}` : '/automations', { method: editing.id ? 'PUT' : 'POST', body });
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Não foi possível salvar');
    }
  }

  async function toggle(r: Rule) {
    await api(`/automations/${r.id}/enabled`, { method: 'PATCH', body: { enabled: !r.enabled } }).catch((err) => setError(err.message));
    await load();
  }
  async function remove(r: Rule) {
    if (!window.confirm(`Excluir a regra “${r.name}”?`)) return;
    await api(`/automations/${r.id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    await load();
  }
  async function saveHours(e: React.FormEvent) {
    e.preventDefault();
    setHoursSaved(false);
    try {
      await api('/settings/businessHours', { method: 'PUT', body: hours });
      setHoursSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar o horário');
    }
  }

  const setForm = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setEditing((s) => (s ? { ...s, form: { ...s.form, [k]: v } } : s));
  const f = editing?.form;

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Automações</h1>
          <p className="text-sm text-slate-500">Respostas automáticas em conversas individuais. Param sozinhas quando um atendente responde e voltam quando a conversa é encerrada.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setFormError(null); setEditing({ form: blank }); }}>Nova regra</button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <ul className="space-y-3">
        {rules?.map((r) => (
          <li key={r.id} className={`card p-4 ${r.enabled ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-semibold">{r.name}</h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  {r.trigger === 'OUT_OF_HOURS' ? 'Quando chega mensagem fora do horário de atendimento' : `Quando a mensagem ${MATCH_LABEL[r.matchType]}: ${r.keywords.join(', ')}`}
                  {r.number ? ` · só em ${r.number.nickname}` : ' · todos os números'}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {r.action === 'HANDOFF' ? <strong>Encaminha para um atendente</strong> : <strong>Responde</strong>}
                  {r.responseText ? `: “${r.responseText}”` : '.'}
                </p>
                <p className="mt-1 text-xs text-slate-500">Prioridade {r.priority} · não repete na mesma conversa por {r.cooldownMinutes} min</p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm font-medium">
                <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
                  <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={r.enabled} onChange={() => void toggle(r)} />
                  Ativa
                </label>
                <button className="text-brand-700 hover:underline" onClick={() => { setFormError(null); edit(r); }}>Editar</button>
                <button className="text-red-700 hover:underline" onClick={() => void remove(r)}>Excluir</button>
              </div>
            </div>
          </li>
        ))}
        {rules?.length === 0 && <li className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma regra criada. Exemplos: responder a “preço” com a tabela, ou avisar que o atendimento volta às 9h.</li>}
      </ul>

      {hours && (
        <form onSubmit={saveHours} className="card space-y-4 p-5">
          <div>
            <h2 className="font-semibold">Horário de atendimento</h2>
            <p className="text-sm text-slate-500">Define quando as regras de “fora do horário” respondem (horário de Brasília).</p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <fieldset>
              <legend className="label">Dias</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((label, day) => {
                  const on = hours.days.includes(day);
                  return (
                    <button key={day} type="button" aria-pressed={on} onClick={() => setHours({ ...hours, days: on ? hours.days.filter((d) => d !== day) : [...hours.days, day].sort() })} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500'}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex items-center gap-2">
              <input type="time" className="input" aria-label="Início do atendimento" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} />
              <span className="text-sm text-slate-500">até</span>
              <input type="time" className="input" aria-label="Fim do atendimento" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} />
            </div>
            <span className="flex-1" />
            {hoursSaved && <span className="text-sm text-emerald-700">Salvo.</span>}
            <button className="btn btn-primary" type="submit">Salvar horário</button>
          </div>
        </form>
      )}

      {editing && f && (
        <Modal title={editing.id ? 'Editar regra' : 'Nova regra'} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-3">
            <div><label className="label" htmlFor="ar-name">Nome</label><input id="ar-name" className="input" required maxLength={80} value={f.name} onChange={(e) => setForm('name', e.target.value)} placeholder="Ex.: Tabela de preços" /></div>
            <div>
              <label className="label" htmlFor="ar-trigger">Quando</label>
              <select id="ar-trigger" className="input" value={f.trigger} onChange={(e) => setForm('trigger', e.target.value as Trigger)}>
                <option value="KEYWORD">A mensagem tiver uma palavra-chave</option>
                <option value="OUT_OF_HOURS">Chegar mensagem fora do horário de atendimento</option>
              </select>
            </div>
            {f.trigger === 'KEYWORD' && (
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <div>
                  <label className="label" htmlFor="ar-match">Comparação</label>
                  <select id="ar-match" className="input" value={f.matchType} onChange={(e) => setForm('matchType', e.target.value as Match)}>
                    <option value="CONTAINS">Contém</option>
                    <option value="EXACT">É exatamente</option>
                    <option value="STARTS_WITH">Começa com</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="ar-keywords">Palavras-chave (separadas por vírgula)</label>
                  <input id="ar-keywords" className="input" value={f.keywords} onChange={(e) => setForm('keywords', e.target.value)} placeholder="preço, valor, quanto custa" />
                </div>
              </div>
            )}
            <div>
              <label className="label" htmlFor="ar-action">O que fazer</label>
              <select id="ar-action" className="input" value={f.action} onChange={(e) => setForm('action', e.target.value as Action)}>
                <option value="REPLY">Responder automaticamente</option>
                <option value="HANDOFF">Encaminhar para um atendente</option>
              </select>
              {f.action === 'HANDOFF' && <p className="mt-1 text-xs text-slate-500">A conversa vai para “Pendente” e a automação para de responder até um atendente encerrá-la.</p>}
            </div>
            <div>
              <label className="label" htmlFor="ar-text">{f.action === 'HANDOFF' ? 'Mensagem ao encaminhar (opcional)' : 'Resposta'}</label>
              <textarea id="ar-text" className="input min-h-24" maxLength={2000} value={f.responseText} onChange={(e) => setForm('responseText', e.target.value)} placeholder="Oi {{primeiro_nome}}! …" />
              <p className="mt-1 text-xs text-slate-500">Aceita variáveis como {'{{primeiro_nome}}'} e variações {'{Olá|Oi}'}.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="ar-number">Número</label>
                <select id="ar-number" className="input" value={f.numberId} onChange={(e) => setForm('numberId', e.target.value)}>
                  <option value="">Todos</option>
                  {numbers.map((x) => <option key={x.id} value={x.id}>{x.nickname}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="ar-priority">Prioridade</label><input id="ar-priority" type="number" min={0} max={1000} className="input" value={f.priority} onChange={(e) => setForm('priority', Number(e.target.value))} /></div>
              <div><label className="label" htmlFor="ar-cooldown">Não repetir por (min)</label><input id="ar-cooldown" type="number" min={1} max={10080} className="input" value={f.cooldownMinutes} onChange={(e) => setForm('cooldownMinutes', Number(e.target.value))} /></div>
            </div>
            <p className="text-xs text-slate-500">Se mais de uma regra casar com a mensagem, vale a de maior prioridade.</p>
            {formError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
              <button type="submit" className="btn btn-primary">Salvar</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
