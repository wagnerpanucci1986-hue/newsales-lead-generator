'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Conversation } from '@/lib/inbox';
import { formatWhen, STAGE_LABEL, TEMP_CLASS, TEMP_LABEL, type SdrLead, type SdrRun } from '@/lib/sdr';

interface Detail {
  aiStatus: Conversation['aiStatus'];
  paused: boolean;
  lead: SdrLead | null;
  sheet: string | null;
  runs: SdrRun[];
}

/** Faixa da IA do SDR na conversa: situação, ficha do lead e botões para assumir ou devolver. */
export function SdrBar({ conversation }: { conversation: Conversation }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/sdr/conversations/${conversation.id}`).then(setDetail).catch(() => undefined);
  }, [conversation.id]);
  // Recarrega quando a conversa muda (nova mensagem, pausa, status).
  useEffect(load, [load, conversation.aiStatus, conversation.automationPaused, conversation.lastMessageAt]);

  if (conversation.isGroup) return null;
  if (!detail || (detail.aiStatus === 'OFF' && !detail.lead)) {
    return detail ? (
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
        <span>IA do SDR desligada nesta conversa.</span>
        <button className="font-medium text-brand-700 hover:underline" disabled={busy} onClick={() => void act('activate')}>Ligar IA</button>
      </div>
    ) : null;
  }

  async function act(action: 'activate' | 'pause' | 'stop') {
    if (action === 'stop' && !confirm('Desligar a IA nesta conversa? Ela para de responder e de fazer follow-up.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/sdr/conversations/${conversation.id}/ai`, { method: 'POST', body: { action } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar');
    } finally {
      setBusy(false);
    }
  }

  const { lead } = detail;
  const state =
    detail.aiStatus === 'ACTIVE' && !detail.paused
      ? { text: 'IA atendendo', cls: 'bg-emerald-100 text-emerald-800' }
      : detail.aiStatus === 'ACTIVE'
        ? { text: lead?.handoffTo ? `IA passou para ${lead.handoffTo}` : 'IA pausada: um humano assumiu', cls: 'bg-amber-100 text-amber-900' }
        : detail.aiStatus === 'DONE'
          ? { text: 'IA encerrou o atendimento', cls: 'bg-slate-200 text-slate-700' }
          : { text: 'IA desligada', cls: 'bg-slate-200 text-slate-700' };
  const lastError = detail.runs.find((r) => r.status === 'error');

  return (
    <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-medium ${state.cls}`}>{state.text}</span>
        {lead?.temperature && <span className={`rounded px-1.5 py-0.5 ${TEMP_CLASS[lead.temperature]}`}>{TEMP_LABEL[lead.temperature]}</span>}
        {lead && <span className="text-slate-600">{STAGE_LABEL[lead.stage]}</span>}
        {lead?.meetingStart && <span className="text-slate-600">· reunião {formatWhen(lead.meetingStart)}{lead.consultantName ? ` com ${lead.consultantName}` : ''}</span>}
        {lead?.nextFollowUpAt && detail.aiStatus === 'ACTIVE' && !detail.paused && <span className="text-slate-500">· próximo contato {formatWhen(lead.nextFollowUpAt)}</span>}
        <span className="ml-auto flex gap-3">
          {detail.aiStatus === 'ACTIVE' && !detail.paused && <button className="font-medium text-amber-800 hover:underline" disabled={busy} onClick={() => void act('pause')}>Assumir (pausar IA)</button>}
          {(detail.paused || detail.aiStatus !== 'ACTIVE') && <button className="font-medium text-brand-700 hover:underline" disabled={busy} onClick={() => void act('activate')}>{detail.aiStatus === 'ACTIVE' ? 'Devolver para a IA' : 'Ligar IA'}</button>}
          {detail.aiStatus === 'ACTIVE' && <button className="font-medium text-slate-600 hover:underline" disabled={busy} onClick={() => void act('stop')}>Desligar</button>}
        </span>
      </div>
      {(detail.sheet || lead?.motivo) && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-slate-600">Ficha do lead</summary>
          {detail.sheet && <pre className="mt-1 whitespace-pre-wrap rounded bg-white p-2 font-sans text-xs text-slate-700">{detail.sheet}</pre>}
          {lead?.motivo && <p className="mt-1 text-slate-600">Motivo registrado: {lead.motivo}</p>}
          {lead?.meetingLink && <p className="mt-1"><a className="text-brand-700 underline" href={lead.meetingLink} target="_blank" rel="noreferrer">Link da reunião</a></p>}
        </details>
      )}
      {lastError && lastError === detail.runs[0] && <p className="mt-1 text-red-700">Última tentativa da IA falhou: {lastError.error}</p>}
      {error && <p role="alert" className="mt-1 text-red-700">{error}</p>}
    </div>
  );
}
