'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pagination } from '@/components/Pagination';
import { api, API_URL, getAccessToken } from '@/lib/api';
import { CAMPAIGN_STATUS, formatDateTime, pct, RECIPIENT_STATUS, WEEKDAYS, type Campaign, type Recipient } from '@/lib/crm';
import { formatPhone } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';

const FILTERS = [
  ['', 'Todos'],
  ['status=QUEUED', 'Na fila'],
  ['status=SENT', 'Enviadas'],
  ['status=DELIVERED', 'Entregues'],
  ['status=READ', 'Lidas'],
  ['only=replied', 'Responderam'],
  ['status=FAILED', 'Falharam'],
  ['status=SKIPPED', 'Puladas'],
  ['only=optOut', 'Descadastros'],
] as const;

export default function CampaignReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [byNumber, setByNumber] = useState<Record<string, { sent: number; failed: number }>>({});
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [recipients, setRecipients] = useState<{ recipients: Recipient[]; total: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ campaign: Campaign; byNumber: Record<string, { sent: number; failed: number }> }>(`/campaigns/${id}`)
      .then((r) => {
        setCampaign(r.campaign);
        setByNumber(r.byNumber);
      })
      .catch((err) => setError(err.message));
    api<{ recipients: Recipient[]; total: number; limit: number }>(`/campaigns/${id}/recipients?page=${page}${filter ? `&${filter}` : ''}`).then(setRecipients).catch(() => undefined);
  }, [id, page, filter]);
  useEffect(load, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSocketEvent<{ campaignId: string }>('campaign.updated', (e) => {
    if (e.campaignId !== id) return;
    timer.current ??= setTimeout(() => {
      timer.current = null;
      load();
    }, 2000);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function act(action: 'start' | 'pause' | 'resume' | 'cancel', confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ campaign: Campaign }>(`/campaigns/${id}/${action}`, { method: 'POST' });
      setCampaign(r.campaign);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Excluir esta campanha e o relatório dela? As mensagens já enviadas continuam nas conversas.')) return;
    try {
      await api(`/campaigns/${id}`, { method: 'DELETE' });
      router.push('/campanhas');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível excluir');
    }
  }

  // O download precisa do cabeçalho de autorização, então é feito por fetch.
  async function exportCsv() {
    const res = await fetch(`${API_URL}/api/campaigns/${id}/export.csv`, { headers: { authorization: `Bearer ${getAccessToken()}` }, credentials: 'include' });
    if (!res.ok) return setError('Não foi possível exportar');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanha-${campaign?.name ?? id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error && !campaign) return <p role="alert" className="m-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!campaign) return <p className="p-6 text-sm text-slate-500">Carregando…</p>;

  const s = campaign.stats;
  const status = CAMPAIGN_STATUS[campaign.status];
  const target = s.total - s.skipped;
  const done = s.sent + s.failed;
  const tiles: [string, number, string][] = [
    ['Enviadas', s.sent, target ? `de ${target.toLocaleString('pt-BR')}` : ''],
    ['Entregues', s.delivered, pct(s.delivered, s.sent)],
    ['Lidas', s.read, pct(s.read, s.sent)],
    ['Respondidas', s.replied, pct(s.replied, s.sent)],
    ['Falhas', s.failed, pct(s.failed, done)],
    ['Descadastros', s.optOut, pct(s.optOut, s.sent)],
    ['Puladas', s.skipped, ''],
    ['Na fila', s.queued + s.sending, ''],
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-8">
      <div>
        <Link href="/campanhas" className="text-sm font-medium text-brand-700 hover:underline">← Campanhas</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold">
              <span className="truncate">{campaign.name}</span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {campaign.status === 'SCHEDULED' && campaign.scheduledAt ? `Agendada para ${formatDateTime(campaign.scheduledAt)}` : campaign.startedAt ? `Iniciada em ${formatDateTime(campaign.startedAt)}` : 'Ainda não iniciada'}
              {campaign.finishedAt && ` · encerrada em ${formatDateTime(campaign.finishedAt)}`}
              {campaign.createdBy && ` · por ${campaign.createdBy.name}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {campaign.status === 'DRAFT' && <Link href={`/campanhas/${id}/editar`} className="btn btn-secondary">Editar</Link>}
            {campaign.status === 'DRAFT' && <button className="btn btn-primary" disabled={busy} onClick={() => void act('start', 'Iniciar esta campanha?')}>Iniciar</button>}
            {(campaign.status === 'RUNNING' || campaign.status === 'SCHEDULED') && <button className="btn btn-secondary" disabled={busy} onClick={() => void act('pause')}>Pausar</button>}
            {campaign.status === 'PAUSED' && <button className="btn btn-primary" disabled={busy} onClick={() => void act('resume')}>Retomar</button>}
            {['RUNNING', 'SCHEDULED', 'PAUSED'].includes(campaign.status) && (
              <button className="btn btn-danger" disabled={busy} onClick={() => void act('cancel', 'Cancelar a campanha? Quem ainda está na fila não receberá. Esta ação não pode ser desfeita.')}>Cancelar</button>
            )}
            {s.total > 0 && <button className="btn btn-secondary" onClick={() => void exportCsv()}>Exportar CSV</button>}
            {['DRAFT', 'COMPLETED', 'CANCELED', 'PAUSED'].includes(campaign.status) && <button className="btn btn-danger" onClick={() => void remove()}>Excluir</button>}
          </div>
        </div>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {s.total > 0 && (
        <section className="card p-5">
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={target} aria-label="Progresso do envio">
            <div className="h-full bg-brand-500 transition-[width]" style={{ width: target ? `${Math.min(100, (done / target) * 100)}%` : '0%' }} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map(([label, value, hint]) => (
              <div key={label} className="rounded-lg bg-slate-50 px-3 py-3">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{value.toLocaleString('pt-BR')}</dd>
                <p className="h-4 text-xs text-slate-500">{hint}</p>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">“Lidas” conta só quem mantém a confirmação de leitura ligada; o número real costuma ser maior.</p>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card space-y-3 p-5">
          <h2 className="font-semibold">Mensagem</h2>
          <p className="w-fit max-w-full whitespace-pre-wrap break-words rounded-xl bg-emerald-100 px-3 py-2 text-sm shadow-sm">{campaign.body || '(sem texto)'}</p>
          {campaign.media && <p className="text-sm text-slate-600">📎 {campaign.media.fileName}</p>}
          <p className="text-sm text-slate-600">
            Público: {campaign.lists.map((l) => l.name).join(', ') || 'por etiqueta'}. Envio {campaign.sendDays.map((d) => WEEKDAYS[d]).join(', ')}, das {campaign.windowStart} às {campaign.windowEnd}.
            Intervalo de {campaign.minDelayS}–{campaign.maxDelayS} s{campaign.longPauseEvery ? `, pausa de ${Math.round(campaign.longPauseMinS / 60)}–${Math.round(campaign.longPauseMaxS / 60)} min a cada ${campaign.longPauseEvery} mensagens` : ''}.
          </p>
        </section>
        <section className="card space-y-3 p-5">
          <h2 className="font-semibold">Envios por número</h2>
          <ul className="space-y-2">
            {campaign.numbers.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: n.color }} />
                  <span className="truncate">{n.nickname}</span>
                  {n.status !== 'CONNECTED' && <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">{n.status === 'SUSPECT' ? 'pausado' : 'desconectado'}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-slate-600">
                  {(byNumber[n.id]?.sent ?? 0).toLocaleString('pt-BR')} enviadas{byNumber[n.id]?.failed ? `, ${byNumber[n.id]!.failed} falhas` : ''}
                </span>
              </li>
            ))}
            {campaign.numbers.length === 0 && <li className="text-sm text-slate-500">Nenhum número escolhido.</li>}
          </ul>
        </section>
      </div>

      {s.total > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Destinatários</h2>
            <select className="input w-auto" aria-label="Filtrar destinatários" value={filter} onChange={(e) => { setPage(1); setFilter(e.target.value); }}>
              {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2.5">Contato</th><th className="px-3 py-2.5">Situação</th><th className="px-3 py-2.5">Número</th><th className="px-3 py-2.5">Enviada em</th><th className="px-3 py-2.5">Observação</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recipients?.recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5"><p className="font-medium">{r.contact.name ?? '—'}</p><p className="text-xs text-slate-500">{formatPhone(r.contact.phone)}</p></td>
                    <td className="px-3 py-2.5">
                      {RECIPIENT_STATUS[r.status]}
                      {r.repliedAt && <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">respondeu</span>}
                      {r.optedOutAt && <span className="ml-1.5 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">saiu</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.number?.nickname ?? '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600">{formatDateTime(r.sentAt)}</td>
                    <td className="px-3 py-2.5 text-slate-600">{r.skipReason ?? r.error ?? ''}</td>
                  </tr>
                ))}
                {recipients?.recipients.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">Nenhum destinatário neste filtro.</td></tr>}
              </tbody>
            </table>
          </div>
          {recipients && <Pagination page={page} limit={recipients.limit} total={recipients.total} onPage={setPage} />}
        </section>
      )}
    </div>
  );
}
