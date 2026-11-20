'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LgpdNotice } from '@/components/campaigns/LgpdNotice';
import { api } from '@/lib/api';
import { CAMPAIGN_STATUS, formatDateTime, pct, type Campaign } from '@/lib/crm';
import { useSocketEvent } from '@/lib/socket';

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ campaigns: Campaign[] }>('/campaigns').then((r) => setCampaigns(r.campaigns)).catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  // Muitos envios por minuto: no máximo uma atualização a cada 2 s.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSocketEvent('campaign.updated', () => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      load();
    }, 2000);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Campanhas</h1>
        <Link href="/campanhas/nova" className="btn btn-primary">Nova campanha</Link>
      </div>
      <LgpdNotice />
      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {campaigns?.length === 0 && (
        <div className="card px-6 py-12 text-center">
          <p className="font-medium">Nenhuma campanha criada</p>
          <p className="mt-1 text-sm text-slate-500">Importe seus contatos, monte uma lista e crie a primeira campanha.</p>
        </div>
      )}
      <ul className="space-y-3">
        {campaigns?.map((c) => {
          const status = CAMPAIGN_STATUS[c.status];
          const target = c.stats.total - c.stats.skipped;
          const done = c.stats.sent + c.stats.failed;
          return (
            <li key={c.id}>
              <Link href={`/campanhas/${c.id}`} className="card block p-4 hover:border-slate-300">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{c.name}</h2>
                    <p className="text-sm text-slate-500">
                      {c.status === 'SCHEDULED' && c.scheduledAt ? `Agendada para ${formatDateTime(c.scheduledAt)}` : `Criada em ${formatDateTime(c.createdAt)}`}
                      {c.numbers.length > 0 && ` · ${c.numbers.map((n) => n.nickname).join(', ')}`}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
                </div>
                {c.stats.total > 0 && (
                  <>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={target} aria-label="Progresso do envio">
                      <div className="h-full bg-brand-500" style={{ width: target ? `${Math.min(100, (done / target) * 100)}%` : '0%' }} />
                    </div>
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                      <span><strong className="tabular-nums">{c.stats.sent.toLocaleString('pt-BR')}</strong> de {target.toLocaleString('pt-BR')} enviadas</span>
                      <span>Entregues {pct(c.stats.delivered, c.stats.sent)}</span>
                      <span>Lidas {pct(c.stats.read, c.stats.sent)}</span>
                      <span>Respostas {pct(c.stats.replied, c.stats.sent)}</span>
                      {c.stats.failed > 0 && <span className="text-red-700">{c.stats.failed} falhas</span>}
                    </p>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
