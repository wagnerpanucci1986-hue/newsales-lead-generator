'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { Contact } from '@/lib/crm';
import type { Tag } from '@/lib/inbox';
import { Modal } from '../Modal';

export function ContactForm({ contact, tags, onClose, onSaved }: { contact?: Contact; tags: Tag[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    phone: contact ? `+${contact.phone}` : '',
    name: contact?.name ?? '',
    company: contact?.company ?? '',
    email: contact?.email ?? '',
    consentSource: contact?.consentSource ?? '',
  });
  const [fields, setFields] = useState<[string, string][]>(Object.entries(contact?.customFields ?? {}));
  const [tagIds, setTagIds] = useState<string[]>(contact?.tags.map((t) => t.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const customFields = Object.fromEntries(fields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      await api(contact ? `/contacts/${contact.id}` : '/contacts', { method: contact ? 'PATCH' : 'POST', body: { ...form, customFields, tagIds } });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar');
      setSaving(false);
    }
  }

  return (
    <Modal title={contact ? 'Editar contato' : 'Novo contato'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="c-phone">Telefone</label>
          <input id="c-phone" className="input" required placeholder="(11) 98888-7777" value={form.phone} onChange={set('phone')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="c-name">Nome</label><input id="c-name" className="input" value={form.name} onChange={set('name')} /></div>
          <div><label className="label" htmlFor="c-company">Empresa</label><input id="c-company" className="input" value={form.company} onChange={set('company')} /></div>
        </div>
        <div><label className="label" htmlFor="c-email">E-mail</label><input id="c-email" type="email" className="input" value={form.email} onChange={set('email')} /></div>
        <div>
          <label className="label" htmlFor="c-consent">Origem do consentimento</label>
          <input id="c-consent" className="input" placeholder="Ex.: formulário do site, 03/2026" value={form.consentSource} onChange={set('consentSource')} />
        </div>
        <fieldset>
          <legend className="label">Campos personalizados</legend>
          <div className="space-y-2">
            {fields.map(([k, v], i) => (
              <div key={i} className="flex gap-2">
                <input className="input" placeholder="Campo (ex.: cidade)" aria-label="Nome do campo" value={k} onChange={(e) => setFields((f) => f.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))} />
                <input className="input" placeholder="Valor" aria-label="Valor do campo" value={v} onChange={(e) => setFields((f) => f.map((row, j) => (j === i ? [row[0], e.target.value] : row)))} />
                <button type="button" className="btn btn-secondary px-2.5" aria-label="Remover campo" onClick={() => setFields((f) => f.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setFields((f) => [...f, ['', '']])}>+ Adicionar campo</button>
          </div>
        </fieldset>
        {tags.length > 0 && (
          <fieldset>
            <legend className="label">Etiquetas</legend>
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-sm">
                  <input type="checkbox" className="accent-emerald-600" checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} />
                  {t.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  );
}
