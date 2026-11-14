'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '@/lib/api';
import { WEEKDAYS, type Campaign, type ContactList } from '@/lib/crm';
import { formatSize, type Tag } from '@/lib/inbox';
import type { WaNumber } from '@/lib/numbers';
import { LgpdNotice } from './LgpdNotice';

interface Preview {
  audience: { total: number; willSend: number; skipped: Record<string, number> };
  samples: { contact: string; text: string }[];
  unknownVariables: string[];
}

// datetime-local trabalha com hora local sem fuso.
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export function CampaignForm({ campaign }: { campaign?: Campaign }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    body: campaign?.body ?? '',
    listIds: campaign?.lists.map((l) => l.id) ?? [],
    numberIds: campaign?.numbers.map((n) => n.id) ?? [],
    tagIds: campaign?.audienceFilter?.tagIds ?? [],
    onlyWaValid: campaign?.audienceFilter?.onlyWaValid ?? false,
    scheduledAt: toLocalInput(campaign?.scheduledAt ?? null),
    sendDays: campaign?.sendDays ?? [1, 2, 3, 4, 5],
    windowStart: campaign?.windowStart ?? '09:00',
    windowEnd: campaign?.windowEnd ?? '18:00',
    minDelayS: campaign?.minDelayS ?? 15,
    maxDelayS: campaign?.maxDelayS ?? 60,
    longPauseEvery: campaign?.longPauseEvery ?? 20,
    longPauseMinS: campaign?.longPauseMinS ?? 300,
    longPauseMaxS: campaign?.longPauseMaxS ?? 900,
    simulateTyping: campaign?.simulateTyping ?? true,
    consentConfirmed: campaign?.consentConfirmed ?? false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [removeMedia, setRemoveMedia] = useState(false);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [variables, setVariables] = useState<string[]>(['nome', 'primeiro_nome', 'empresa']);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const num = (key: 'minDelayS' | 'maxDelayS' | 'longPauseEvery' | 'longPauseMinS' | 'longPauseMaxS') => (e: React.ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value));

  useEffect(() => {
    api<{ lists: ContactList[] }>('/lists').then((r) => setLists(r.lists)).catch(() => undefined);
    api<{ tags: Tag[] }>('/tags').then((r) => setTags(r.tags)).catch(() => undefined);
    api<{ numbers: WaNumber[] }>('/numbers').then((r) => setNumbers(r.numbers)).catch(() => undefined);
    api<{ builtin: string[]; custom: string[] }>('/contacts/fields').then((r) => setVariables([...r.builtin, ...r.custom])).catch(() => undefined);
  }, []);

  // Prévia do público e da mensagem, atualizada pouco depois de cada mudança.
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>('/campaigns/preview', { method: 'POST', body: { body: form.body, listIds: form.listIds, audienceFilter: { tagIds: form.tagIds, onlyWaValid: form.onlyWaValid } } })
        .then(setPreview)
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [form.body, form.listIds, form.tagIds, form.onlyWaValid]);

  function insert(text: string) {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? form.body.length;
    const end = el?.selectionEnd ?? form.body.length;
    set('body', form.body.slice(0, start) + text + form.body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  async function save(start: boolean) {
    setError(null);
    if (start && !form.consentConfirmed) return setError('Para iniciar, confirme que os contatos autorizaram o recebimento de mensagens.');
    if (start && !window.confirm(form.scheduledAt ? 'Agendar esta campanha?' : `Iniciar o envio agora para ${preview?.audience.willSend.toLocaleString('pt-BR') ?? 'os'} contatos?`)) return;
    setSaving(true);
    try {
      const { tagIds, onlyWaValid, scheduledAt, ...rest } = form;
      const body = { ...rest, audienceFilter: { tagIds, onlyWaValid }, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null };
      const saved = await api<{ campaign: Campaign }>(campaign ? `/campaigns/${campaign.id}` : '/campaigns', { method: campaign ? 'PUT' : 'POST', body });
      const id = saved.campaign.id;
      if (file) {
        const data = new FormData();
        data.append('file', file);
        await apiUpload(`/campaigns/${id}/media`, data);
      } else if (removeMedia) {
        await api(`/campaigns/${id}/media`, { method: 'DELETE' });
      }
      if (start) await api(`/campaigns/${id}/start`, { method: 'POST' });
      router.push(`/campanhas/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar a campanha');
      setSaving(false);
    }
  }

  const existingMedia = campaign?.media && !removeMedia && !file ? campaign.media : null;
  const skipped = preview ? Object.entries(preview.audience.skipped) : [];

  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
      <LgpdNotice />

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Mensagem</h2>
        <div>
          <label className="label" htmlFor="cp-name">Nome da campanha</label>
          <input id="cp-name" className="input max-w-md" required maxLength={100} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Lançamento turma de março" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label" htmlFor="cp-body">Texto</label>
            <textarea id="cp-body" ref={bodyRef} className="input min-h-44" maxLength={4096} value={form.body} onChange={(e) => set('body', e.target.value)} placeholder={'{Olá|Oi} {{primeiro_nome}}, tudo bem?'} />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">Inserir:</span>
              {variables.map((v) => (
                <button key={v} type="button" className="rounded-full border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50" onClick={() => insert(`{{${v}}}`)}>{`{{${v}}}`}</button>
              ))}
              <button type="button" className="rounded-full border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50" onClick={() => insert('{Olá|Oi|E aí}')}>variação {'{a|b}'}</button>
            </div>
            <p className="mt-2 text-xs text-slate-500">Variações entre chaves, separadas por barra, são sorteadas a cada envio. Mensagens idênticas em sequência aumentam o risco de bloqueio.</p>

            <div className="mt-4">
              <span className="label">Anexo (opcional)</span>
              {existingMedia ? (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">📎 {existingMedia.fileName} <span className="text-slate-500">({formatSize(existingMedia.size)})</span></span>
                  <button type="button" className="shrink-0 font-medium text-red-700 hover:underline" onClick={() => setRemoveMedia(true)}>Remover</button>
                </div>
              ) : (
                <input type="file" className="input" aria-label="Anexo da campanha" accept="image/*,application/pdf,audio/*,video/mp4" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              )}
              <p className="mt-1 text-xs text-slate-500">Imagem, PDF, áudio ou vídeo. O texto vira a legenda.</p>
            </div>
          </div>
          <div>
            <span className="label">Como vai chegar</span>
            <div className="min-h-44 space-y-2 rounded-lg bg-slate-100 p-3">
              {preview?.samples.length ? (
                preview.samples.map((s) => (
                  <div key={s.contact}>
                    <p className="mb-0.5 text-xs text-slate-500">Para {s.contact}</p>
                    <p className="w-fit max-w-full whitespace-pre-wrap break-words rounded-xl bg-emerald-100 px-3 py-2 text-sm shadow-sm">{s.text || '(sem texto)'}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">Escolha o público para ver exemplos com contatos reais.</p>
              )}
            </div>
            {preview && preview.unknownVariables.length > 0 && (
              <p className="mt-2 text-sm text-amber-800">Variáveis que nenhum contato tem: {preview.unknownVariables.map((v) => `{{${v}}}`).join(', ')}. Elas sairão em branco.</p>
            )}
          </div>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Público</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <fieldset>
            <legend className="label">Listas</legend>
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {lists.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={form.listIds.includes(l.id)} onChange={() => set('listIds', toggle(form.listIds, l.id))} />
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="text-xs text-slate-500">{l.members.toLocaleString('pt-BR')}</span>
                </label>
              ))}
              {lists.length === 0 && <p className="text-sm text-slate-500">Nenhuma lista. Crie uma em Contatos.</p>}
            </div>
          </fieldset>
          <fieldset>
            <legend className="label">Somente com as etiquetas (opcional)</legend>
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-sm">
                  <input type="checkbox" className="accent-emerald-600" checked={form.tagIds.includes(t.id)} onChange={() => set('tagIds', toggle(form.tagIds, t.id))} />
                  {t.name}
                </label>
              ))}
              {tags.length === 0 && <p className="text-sm text-slate-500">Nenhuma etiqueta criada.</p>}
            </div>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={form.onlyWaValid} onChange={(e) => set('onlyWaValid', e.target.checked)} />
              <span>Enviar só para quem já foi verificado no WhatsApp</span>
            </label>
          </fieldset>
        </div>
        {preview && (
          <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
            <strong>{preview.audience.willSend.toLocaleString('pt-BR')}</strong> de {preview.audience.total.toLocaleString('pt-BR')} contatos vão receber.
            {skipped.length > 0 && <span className="text-slate-600"> Ficam de fora: {skipped.map(([reason, n]) => `${n} (${reason})`).join(', ')}.</span>}
          </p>
        )}
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Números que vão enviar</h2>
        <div className="flex flex-wrap gap-2">
          {numbers.map((n) => (
            <label key={n.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={form.numberIds.includes(n.id)} onChange={() => set('numberIds', toggle(form.numberIds, n.id))} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: n.color }} />
              {n.nickname}
              {n.status !== 'CONNECTED' && <span className="text-xs text-amber-700">(desconectado)</span>}
            </label>
          ))}
          {numbers.length === 0 && <p className="text-sm text-slate-500">Nenhum número cadastrado.</p>}
        </div>
        <p className="text-xs text-slate-500">Os contatos são distribuídos automaticamente entre os números escolhidos. Cada número respeita o próprio limite diário e o aquecimento.</p>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Quando enviar</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="cp-when">Início</label>
            <input id="cp-when" type="datetime-local" className="input" value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Em branco, começa assim que você iniciar.</p>
          </div>
          <div>
            <span className="label">Horário permitido</span>
            <div className="flex items-center gap-2">
              <input type="time" className="input" aria-label="Início da janela" value={form.windowStart} onChange={(e) => set('windowStart', e.target.value)} />
              <span className="text-sm text-slate-500">até</span>
              <input type="time" className="input" aria-label="Fim da janela" value={form.windowEnd} onChange={(e) => set('windowEnd', e.target.value)} />
            </div>
          </div>
        </div>
        <fieldset>
          <legend className="label">Dias da semana</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((label, day) => (
              <button key={day} type="button" aria-pressed={form.sendDays.includes(day)} onClick={() => set('sendDays', toggle(form.sendDays, day))} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${form.sendDays.includes(day) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500'}`}>
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Fora da janela o envio pausa sozinho e retoma no próximo horário permitido (horário de Brasília).</p>
        </fieldset>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Ritmo e proteção contra banimento</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div><label className="label" htmlFor="cp-min">Intervalo mín. (s)</label><input id="cp-min" type="number" min={5} max={3600} className="input" value={form.minDelayS} onChange={num('minDelayS')} /></div>
          <div><label className="label" htmlFor="cp-max">Intervalo máx. (s)</label><input id="cp-max" type="number" min={5} max={7200} className="input" value={form.maxDelayS} onChange={num('maxDelayS')} /></div>
          <div><label className="label" htmlFor="cp-every">Pausa longa a cada</label><input id="cp-every" type="number" min={0} max={1000} className="input" value={form.longPauseEvery} onChange={num('longPauseEvery')} /></div>
          <div><label className="label" htmlFor="cp-pmin">Pausa mín. (s)</label><input id="cp-pmin" type="number" min={30} max={7200} className="input" value={form.longPauseMinS} onChange={num('longPauseMinS')} /></div>
          <div><label className="label" htmlFor="cp-pmax">Pausa máx. (s)</label><input id="cp-pmax" type="number" min={30} max={14400} className="input" value={form.longPauseMaxS} onChange={num('longPauseMaxS')} /></div>
        </div>
        <p className="text-xs text-slate-500">Cada número espera um tempo sorteado entre o mínimo e o máximo antes da próxima mensagem, e faz uma pausa longa a cada {form.longPauseEvery || '—'} mensagens (0 desliga). Intervalos menores enviam mais rápido e aumentam o risco de bloqueio.</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={form.simulateTyping} onChange={(e) => set('simulateTyping', e.target.checked)} />
          <span>Mostrar “digitando…” antes de cada mensagem</span>
        </label>
      </section>

      <section className="card space-y-3 p-5">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={form.consentConfirmed} onChange={(e) => set('consentConfirmed', e.target.checked)} />
          <span><strong>Confirmo que os contatos deste público autorizaram o recebimento de mensagens</strong> e que a origem dessa autorização está registrada. Esta confirmação fica gravada no log de auditoria com meu usuário.</span>
        </label>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => router.back()}>Cancelar</button>
          <button type="submit" className="btn btn-secondary" disabled={saving}>Salvar rascunho</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save(true)}>{form.scheduledAt ? 'Salvar e agendar' : 'Salvar e iniciar'}</button>
        </div>
      </section>
    </form>
  );
}
