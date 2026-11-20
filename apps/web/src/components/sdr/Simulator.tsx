'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { STAGE_LABEL, TEMP_LABEL, type SdrLead } from '@/lib/sdr';

interface Turn {
  fromMe: boolean;
  text: string;
  tools?: { name: string; result: string; isError: boolean }[];
}

const TOOL_LABEL: Record<string, string> = {
  atualizar_ficha: 'atualizou a ficha',
  consultar_horarios: 'consultou a agenda',
  agendar_reuniao: 'marcou a reunião (teste)',
  passar_para_humano: 'passou para humano',
  registrar_descadastro: 'registrou descadastro',
  agendar_retorno: 'combinou retorno',
  encerrar_atendimento: 'encerrou o atendimento',
};

/** Conversa de teste com a IA: você faz o papel do lead. Nada é enviado nem marcado. */
export function Simulator() {
  const [name, setName] = useState('Joana');
  const [company, setCompany] = useState('Uniformes Lima');
  const [opening, setOpening] = useState('Oi, Joana! Aqui é a Ana, do Grupo New Sales, em Londrina. Vi que a Uniformes Lima trabalha com uniformes. Hoje órgãos públicos compram muito isso por licitação. Vocês já vendem para o governo?');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [lead, setLead] = useState<SdrLead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    const history: Turn[] = [...(turns.length ? turns : [{ fromMe: true, text: opening }]), { fromMe: false, text: draft.trim() }];
    setTurns(history);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ replies: string[]; toolCalls: { name: string; result: string; isError: boolean }[]; lead: SdrLead }>('/sdr/simulate', {
        method: 'POST',
        body: { messages: history.map(({ fromMe, text }) => ({ fromMe, text })), contact: { name, company }, lead: lead ?? undefined },
      });
      setLead(r.lead);
      const replies = r.replies.length ? r.replies : ['(a IA decidiu não responder)'];
      setTurns([...history, ...replies.map((text, i) => ({ fromMe: true, text, tools: i === 0 ? r.toolCalls : undefined }))]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível testar');
      setTurns(history.slice(0, -1));
      setDraft(history.at(-1)!.text);
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    setTurns([]);
    setLead(null);
    setError(null);
  };
  const shown = turns.length ? turns : [{ fromMe: true, text: opening }];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <section className="card flex min-h-[32rem] flex-col">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 p-4">
          <div><label className="label" htmlFor="sim-name">Nome do lead</label><input id="sim-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={turns.length > 0} /></div>
          <div><label className="label" htmlFor="sim-company">Empresa</label><input id="sim-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} disabled={turns.length > 0} /></div>
          <button type="button" className="btn btn-secondary ml-auto" onClick={reset}>Recomeçar</button>
        </div>
        <ol className="flex-1 space-y-2 overflow-y-auto bg-slate-100 p-4" aria-live="polite">
          {shown.map((t, i) => (
            <li key={i} className={`flex flex-col ${t.fromMe ? 'items-end' : 'items-start'}`}>
              {!turns.length && i === 0 ? (
                <textarea className="input min-h-24 max-w-md text-sm" aria-label="Primeira mensagem (como a campanha)" value={opening} onChange={(e) => setOpening(e.target.value)} />
              ) : (
                <p className={`max-w-md whitespace-pre-wrap rounded-xl px-3 py-2 text-sm shadow-sm ${t.fromMe ? 'bg-emerald-100' : 'bg-white'}`}>{t.text}</p>
              )}
              {t.tools?.map((tool, j) => (
                <details key={j} className="mt-1 max-w-md text-xs text-slate-500">
                  <summary className={`cursor-pointer ${tool.isError ? 'text-red-700' : ''}`}>{TOOL_LABEL[tool.name] ?? tool.name}</summary>
                  <pre className="whitespace-pre-wrap font-sans">{tool.result}</pre>
                </details>
              ))}
            </li>
          ))}
          {busy && <li className="text-xs text-slate-500">{name || 'O lead'} está esperando a resposta…</li>}
        </ol>
        <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-3">
          <input className="input" aria-label="Mensagem do lead" placeholder="Escreva como se fosse o lead…" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
          <button className="btn btn-primary" disabled={busy || !draft.trim()}>Enviar</button>
        </form>
        {error && <p role="alert" className="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </section>
      <aside className="card space-y-2 p-4 text-sm">
        <h2 className="font-semibold">Ficha do teste</h2>
        <p className="text-xs text-slate-500">Nada aqui é enviado, gravado ou marcado. A agenda é só lida.</p>
        {lead ? (
          <dl className="space-y-1">
            {[
              ['Etapa', STAGE_LABEL[lead.stage]],
              ['Temperatura', lead.temperature ? TEMP_LABEL[lead.temperature] : null],
              ['Cargo', lead.cargo],
              ['Produto', lead.produto],
              ['Estados', lead.estados],
              ['Experiência', lead.experiencia],
              ['Dor', lead.dor],
              ['Objeções', lead.objecoes?.join('; ') || null],
              ['Próximo passo', lead.proximoPasso],
              ['Motivo', lead.motivo],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd>{v}</dd></div>
              ))}
          </dl>
        ) : (
          <p className="text-slate-500">Responda como o lead para ver a ficha se formar.</p>
        )}
      </aside>
    </div>
  );
}
