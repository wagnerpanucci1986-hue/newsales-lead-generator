'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Pagination } from '@/components/Pagination';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';
import { formatWhen, STAGE_LABEL, TEMP_CLASS, TEMP_LABEL, type LeadStage, type LeadTemperature, type SdrLead, type SdrStatus } from '@/lib/sdr';

type Row = SdrLead & { conversation: { id: string; aiStatus: string; automationPausedAt: string | null; lastMessageAt: string | null; lastMessagePreview: string | null; contact: { name: string | null; company: string | null; phone: string; pushName: string | null } | null } };
const LIMIT = 25;

/** Situação da IA (pendências de configuração, números da semana) e a lista de leads atendidos. */
export function SdrOverview({ status }: { status: SdrStatus }) {
  const [temperature, setTemperature] = useState<'' | LeadTemperature>('');
  const [stage, setStage] = useState<'' | LeadStage>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; leads: Row[] } | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (temperature) p.set('temperature', temperature);
    if (stage) p.set('stage', stage);
    if (q.trim()) p.set('q', q.trim());
    api<{ total: number; leads: Row[] }>(`/sdr/leads?${p}`).then(setData).catch(() => undefined);
  }, [page, temperature, stage, q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useSocketEvent('sdr.updated', load);

  const pending = [
    !status.hasApiKey && 'Falta a chave da API da Anthropic: coloque ANTHROPIC_API_KEY no arquivo .env e reinicie o sistema.',
    !status.enabled && 'A IA está desligada. Ligue na aba Configuração.',
    !status.consultants && 'Nenhum consultor cadastrado (aba Configuração). Sem consultor, a IA passa para humano quando o lead quiser reunião.',
    !status.google.connectedAt && 'O Google Agenda não está conectado (aba Google Agenda). Sem ele, a IA não marca reuniões sozinha.',
  ].filter(Boolean) as string[];
  const cost = status.week.inputTokens + status.week.outputTokens;

  return (
    <div className="space-y-5">
      {pending.length > 0 && (
        <ul role="note" className="list-inside list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {pending.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ['Quentes', status.temperature.QUENTE ?? 0],
          ['Mornos', status.temperature.MORNO ?? 0],
          ['Frios', status.temperature.FRIO ?? 0],
          ['Reuniões marcadas (futuras)', status.upcomingMeetings],
          ['Respostas da IA em 7 dias', status.week.runs],
        ].map(([label, value]) => (
          <div key={label} className="card p-3">
            <dd className="text-2xl font-semibold tabular-nums">{Number(value).toLocaleString('pt-BR')}</dd>
            <dt className="text-xs text-slate-500">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="text-xs text-slate-500">
        Uso em 7 dias: {cost.toLocaleString('pt-BR')} tokens ({status.week.cacheReadTokens.toLocaleString('pt-BR')} lidos do cache, mais baratos)
        {status.week.errors > 0 && <span className="text-red-700"> · {status.week.errors} execuções com erro</span>}. O valor em reais aparece no painel da Anthropic.
      </p>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto font-semibold">Leads atendidos pela IA</h2>
          <input className="input max-w-56" aria-label="Buscar lead" placeholder="Nome, empresa, produto" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select className="input w-auto" aria-label="Temperatura" value={temperature} onChange={(e) => { setTemperature(e.target.value as never); setPage(1); }}>
            <option value="">Todas as temperaturas</option>
            {(Object.keys(TEMP_LABEL) as LeadTemperature[]).map((t) => <option key={t} value={t}>{TEMP_LABEL[t]}</option>)}
          </select>
          <select className="input w-auto" aria-label="Etapa" value={stage} onChange={(e) => { setStage(e.target.value as never); setPage(1); }}>
            <option value="">Todas as etapas</option>
            {(Object.keys(STAGE_LABEL) as LeadStage[]).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2.5">Lead</th><th className="px-3 py-2.5">Temperatura</th><th className="px-3 py-2.5">Etapa</th><th className="px-3 py-2.5">Produto</th><th className="px-3 py-2.5">Próximo passo</th><th className="px-3 py-2.5">Última mensagem</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.leads.map((l) => {
                const c = l.conversation.contact;
                return (
                  <tr key={l.id} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <Link className="font-medium text-brand-700 hover:underline" href={`/conversas?c=${l.conversation.id}`}>{c?.name ?? c?.pushName ?? (c ? formatPhone(c.phone) : 'Contato')}</Link>
                      {c?.company && <p className="text-xs text-slate-500">{c.company}</p>}
                      {l.conversation.automationPausedAt && <p className="text-xs text-amber-800">{l.handoffTo ? `Passado para ${l.handoffTo}` : 'Com um humano'}</p>}
                    </td>
                    <td className="px-3 py-2.5">{l.temperature ? <span className={`rounded px-1.5 py-0.5 text-xs ${TEMP_CLASS[l.temperature]}`}>{TEMP_LABEL[l.temperature]}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-3 py-2.5 text-slate-600">{STAGE_LABEL[l.stage]}{l.meetingStart && <span className="block text-xs">{formatWhen(l.meetingStart)}{l.consultantName ? ` · ${l.consultantName}` : ''}</span>}</td>
                    <td className="max-w-52 px-3 py-2.5 text-slate-600">{l.produto ?? '—'}{l.estados && <span className="block text-xs text-slate-500">{l.estados}</span>}</td>
                    <td className="max-w-56 px-3 py-2.5 text-xs text-slate-600">{l.stage === 'ENCERRADO' ? (l.motivo ?? 'Encerrado') : (l.proximoPasso ?? (l.nextFollowUpAt ? `Follow-up ${formatWhen(l.nextFollowUpAt)}` : '—'))}</td>
                    <td className="max-w-64 px-3 py-2.5 text-xs text-slate-500"><p className="line-clamp-2">{l.conversation.lastMessagePreview ?? '—'}</p>{formatWhen(l.conversation.lastMessageAt)}</td>
                  </tr>
                );
              })}
              {data?.leads.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">Nenhum lead ainda. Eles aparecem quando alguém responde a uma campanha com a IA do SDR ligada.</td></tr>}
            </tbody>
          </table>
        </div>
        {data && <Pagination page={page} limit={LIMIT} total={data.total} onPage={setPage} />}
      </section>
    </div>
  );
}
