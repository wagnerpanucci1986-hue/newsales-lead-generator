'use client';

import { formatListTime, STATUS_LABEL, type Conversation } from '@/lib/inbox';

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  loading,
}: {
  conversations: Conversation[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}) {
  if (!conversations) return <p className="p-4 text-sm text-slate-500">Carregando conversas…</p>;
  if (!conversations.length) {
    return <p className="p-6 text-center text-sm text-slate-500">Nenhuma conversa encontrada com estes filtros.</p>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {conversations.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => onSelect(c.id)}
            aria-current={c.id === selectedId}
            className={`flex w-full gap-3 px-3 py-3 text-left hover:bg-slate-50 ${c.id === selectedId ? 'bg-brand-50 hover:bg-brand-50' : ''}`}
          >
            <span className="mt-1 h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: c.number.color }} title={c.number.nickname} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-sm ${c.unreadCount ? 'font-semibold' : 'font-medium'}`}>{c.name}</span>
                <span className={`shrink-0 text-xs ${c.unreadCount ? 'font-semibold text-brand-700' : 'text-slate-400'}`}>{formatListTime(c.lastMessageAt)}</span>
              </span>
              <span className="mt-0.5 flex items-center justify-between gap-2">
                <span className={`truncate text-sm ${c.unreadCount ? 'text-slate-800' : 'text-slate-500'}`}>
                  {c.lastMessageFromMe && <span className="text-slate-400">Você: </span>}
                  {c.lastMessagePreview}
                </span>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white" aria-label={`${c.unreadCount} não lidas`}>
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <span className="truncate">{c.number.nickname}</span>
                {c.status !== 'OPEN' && <span className="rounded bg-slate-100 px-1.5 py-0.5">{STATUS_LABEL[c.status]}</span>}
                {c.assignee && <span className="truncate">· {c.assignee.name}</span>}
                {c.tags.map((t) => (
                  <span key={t.id} className="rounded px-1.5 py-0.5 text-white" style={{ backgroundColor: t.color }}>{t.name}</span>
                ))}
              </span>
            </span>
          </button>
        </li>
      ))}
      {hasMore && (
        <li className="p-3">
          <button className="btn btn-secondary w-full" onClick={onLoadMore} disabled={loading}>{loading ? 'Carregando…' : 'Carregar mais'}</button>
        </li>
      )}
    </ul>
  );
}
