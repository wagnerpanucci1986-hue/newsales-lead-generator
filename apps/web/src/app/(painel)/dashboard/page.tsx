'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessagesChart, type DayPoint } from '@/components/dashboard/MessagesChart';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CAMPAIGN_STATUS, pct, type CampaignStats, type CampaignStatus } from '@/lib/crm';
import { formatPhone, STATUS_INFO, type NumberStatus } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';

interface Dashboard {
  days: number;
  numbers: {
    id: string; nickname: string; color: string; phone: string | null; status: NumberStatus; statusReason: string | null;
    campaignEnabled: boolean; warmupEnabled: boolean; dailyLimit: number; capToday: number;
    today: { sent: number; received: number; campaignSent: number; delivered: number; failed: number };
  }[];
  series: (DayPoint & { campaignSent: number; failed: number })[];
  totals: { sent: number; received: number; campaignSent: number; campaignDelivered: number; campaignReplied: number };
  conversations: { open: number; pending: number; unreadConversations: number; unreadMessages: number };
  campaigns: { id: string; name: string; status: CampaignStatus; scheduledAt: string | null; stats: CampaignStats }[];
}

const n = (v: number) => v.toLocaleString('pt-BR');

export default function DashboardPage() {
  const { user } = useAuth();
  const isManager = user.role !== 'AGENT';
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Dashboard>(`/dashboard?days=${days}`).then(setData).catch((err) => setError(err.message));
  }, [days]);
  useEffect(load, [load]);

  // Atualiza sozinho quando algo muda, no máximo a cada 5 s.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      load();
    }, 5000);
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useSocketEvent('number.status', refreshSoon);
  useSocketEvent('message.new', refreshSoon);
  useSocketEvent('campaign.updated', refreshSoon);

  if (!data) return <p className="p-6 text-sm text-slate-500">{error ?? 'Carregando…'}</p>;

  const connected = data.numbers.filter((x) => x.status === 'CONNECTED').length;
  const attention = data.numbers.filter((x) => x.status === 'SUSPECT' || x.status === 'BANNED' || x.status === 'DISCONNECTED');
  const t = data.totals;
  const tiles: [string, string, string, string?][] = [
    ['Números conectados', `${connected} de ${data.numbers.length}`, attention.length ? `${attention.length} precisam de atenção` : 'todos funcionando', '/numeros'],
    ['Conversas não lidas', n(data.conversations.unreadConversations), `${n(data.conversations.pending)} aguardando atendente`, '/conversas'],
    [`Mensagens em ${data.days} dias`, n(t.sent + t.received), `${n(t.sent)} enviadas · ${n(t.received)} recebidas`],
    ['Resposta às campanhas', pct(t.campaignReplied, t.campaignSent), t.campaignSent ? `${n(t.campaignReplied)} de ${n(t.campaignSent)} responderam · ${pct(t.campaignDelivered, t.campaignSent)} entregues` : 'nenhuma campanha no período'],
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Visão geral</h1>
        <select className="input w-auto" aria-label="Período" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
        </select>
      </div>

      {attention.filter((x) => x.status !== 'DISCONNECTED').map((x) => (
        <p key={x.id} role="alert" className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <strong>{x.nickname}</strong>: {(x.statusReason ?? STATUS_INFO[x.status].label).replace(/\.$/, '')}. <Link href="/numeros" className="font-medium underline">Ver números</Link>
        </p>
      ))}

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map(([label, value, hint, href]) => {
          const body = (
            <>
              <dt className="text-sm text-slate-500">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
              <p className="mt-1 text-xs text-slate-500">{hint}</p>
            </>
          );
          return href ? <Link key={label} href={href} className="card block p-4 hover:border-slate-300">{body}</Link> : <div key={label} className="card p-4">{body}</div>;
        })}
      </dl>

      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Mensagens por dia</h2>
        <MessagesChart data={data.series} />
        <p className="mt-2 text-xs text-slate-500">O último ponto é o dia de hoje, ainda em andamento.</p>
      </section>

      <section>
        <h2 className="mb-3 font-semibold">Saúde dos números</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2.5">Número</th><th className="px-3 py-2.5">Situação</th><th className="px-3 py-2.5">Disparos hoje</th><th className="px-3 py-2.5 text-right">Enviadas</th><th className="px-3 py-2.5 text-right">Recebidas</th><th className="px-3 py-2.5 text-right">Falhas</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.numbers.map((x) => {
                const info = STATUS_INFO[x.status];
                const used = x.capToday ? Math.min(100, (x.today.campaignSent / x.capToday) * 100) : 0;
                return (
                  <tr key={x.id}>
                    <td className="px-3 py-2.5">
                      <p className="flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: x.color }} />{x.nickname}</p>
                      <p className="text-xs text-slate-500">{formatPhone(x.phone)}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${info.className}`}>{info.label}</span>
                      {x.statusReason && x.status !== 'CONNECTED' && <p className="mt-1 max-w-xs text-xs text-slate-500">{x.statusReason}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={x.today.campaignSent} aria-valuemin={0} aria-valuemax={x.capToday} aria-label={`Disparos de ${x.nickname} hoje`}>
                        <div className="h-full bg-brand-500" style={{ width: `${used}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{n(x.today.campaignSent)} de {n(x.capToday)}{x.warmupEnabled && x.capToday < x.dailyLimit ? ' (em aquecimento)' : ''}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{n(x.today.sent)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{n(x.today.received)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${x.today.failed ? 'font-medium text-red-700' : ''}`}>{n(x.today.failed)}</td>
                  </tr>
                );
              })}
              {data.numbers.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">Nenhum número cadastrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {isManager && (
        <section>
          <h2 className="mb-3 font-semibold">Campanhas ativas</h2>
          {data.campaigns.length === 0 ? (
            <p className="card px-4 py-6 text-center text-sm text-slate-500">Nenhuma campanha em andamento, agendada ou pausada.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {data.campaigns.map((c) => {
                const target = c.stats.total - c.stats.skipped;
                const done = c.stats.sent + c.stats.failed;
                return (
                  <li key={c.id}>
                    <Link href={`/campanhas/${c.id}`} className="card block p-4 hover:border-slate-300">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-medium">{c.name}</span>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${CAMPAIGN_STATUS[c.status].className}`}>{CAMPAIGN_STATUS[c.status].label}</span>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={target} aria-label={`Progresso de ${c.name}`}>
                        <div className="h-full bg-brand-500" style={{ width: target ? `${Math.min(100, (done / target) * 100)}%` : '0%' }} />
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{n(c.stats.sent)} de {n(target)} enviadas · respostas {pct(c.stats.replied, c.stats.sent)}</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
