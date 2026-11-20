'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, type Conversation, type ConversationStatus, type Tag } from '@/lib/inbox';
import { formatPhone } from '@/lib/numbers';

export interface Assignable {
  id: string;
  name: string;
}

/** Cabeçalho da conversa: contato, número, status, responsável e etiquetas. */
export function ChatHeader({
  conversation,
  users,
  tags,
  onChange,
  onBack,
  onTagsChanged,
}: {
  conversation: Conversation;
  users: Assignable[];
  tags: Tag[];
  onChange: (c: Conversation) => void;
  onBack: () => void;
  onTagsChanged: () => void;
}) {
  const { user } = useAuth();
  const isAgent = user.role === 'AGENT';
  const [error, setError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');

  async function run(fn: () => Promise<{ conversation: Conversation }>) {
    setError(null);
    try {
      onChange((await fn()).conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar');
    }
  }
  const patch = (body: { status?: ConversationStatus; assignedUserId?: string | null }) =>
    run(() => api(`/conversations/${conversation.id}`, { method: 'PATCH', body }));

  const tagIds = new Set(conversation.tags.map((t) => t.id));
  const toggleTag = (id: string) => {
    const next = new Set(tagIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return run(() => api(`/conversations/${conversation.id}/tags`, { method: 'PUT', body: { tagIds: [...next] } }));
  };

  async function createTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newTag.trim()) return;
    setError(null);
    try {
      await api('/tags', { method: 'POST', body: { name: newTag.trim() } });
      setNewTag('');
      onTagsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar a etiqueta');
    }
  }

  // Atendente só assume para si ou devolve à fila.
  const assignOptions = isAgent ? users.filter((u) => u.id === user.id || u.id === conversation.assignee?.id) : users;

  return (
    <header className="border-b border-slate-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button className="btn btn-secondary px-2.5 md:hidden" onClick={onBack} aria-label="Voltar para a lista">←</button>
        <div className="min-w-[60%] flex-1 md:min-w-0">
          <h2 className="truncate text-sm font-semibold">{conversation.name}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            {conversation.contact && <span>{formatPhone(conversation.contact.phone)}</span>}
            {conversation.isGroup && <span>Grupo</span>}
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: conversation.number.color }} />
              {conversation.number.nickname}
            </span>
            {conversation.contact?.optedOutAt && <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">Descadastrado</span>}
          </p>
        </div>

        <label className="text-xs text-slate-500">
          <span className="sr-only">Status</span>
          <select className="input w-auto py-1.5 text-xs" value={conversation.status} onChange={(e) => void patch({ status: e.target.value as ConversationStatus })}>
            {(Object.keys(STATUS_LABEL) as ConversationStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-500">
          <span className="sr-only">Responsável</span>
          <select className="input w-auto max-w-40 py-1.5 text-xs" value={conversation.assignee?.id ?? ''} onChange={(e) => void patch({ assignedUserId: e.target.value || null })}>
            <option value="">Sem responsável</option>
            {assignOptions.map((u) => (
              <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (você)` : u.name}</option>
            ))}
          </select>
        </label>

        <details className="relative">
          <summary className="btn btn-secondary cursor-pointer list-none py-1.5 text-xs">Etiquetas{conversation.tags.length ? ` (${conversation.tags.length})` : ''}</summary>
          <div className="absolute right-0 z-10 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
            {tags.length === 0 && <p className="px-2 py-1 text-xs text-slate-500">Nenhuma etiqueta criada.</p>}
            <ul className="max-h-52 overflow-y-auto">
              {tags.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                    <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={tagIds.has(t.id)} onChange={() => void toggleTag(t.id)} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="truncate">{t.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!isAgent && (
              <form onSubmit={createTag} className="mt-2 flex gap-1.5 border-t border-slate-100 pt-2">
                <input className="input py-1.5 text-xs" placeholder="Nova etiqueta" maxLength={30} value={newTag} onChange={(e) => setNewTag(e.target.value)} aria-label="Nome da nova etiqueta" />
                <button className="btn btn-secondary py-1.5 text-xs" type="submit">Criar</button>
              </form>
            )}
          </div>
        </details>
      </div>
      {conversation.tags.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {conversation.tags.map((t) => (
            <span key={t.id} className="rounded px-1.5 py-0.5 text-xs text-white" style={{ backgroundColor: t.color }}>{t.name}</span>
          ))}
        </p>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </header>
  );
}
