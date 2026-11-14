'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Assignable } from '@/components/inbox/ChatHeader';
import { ChatPane } from '@/components/inbox/ChatPane';
import { ConversationList } from '@/components/inbox/ConversationList';
import { api } from '@/lib/api';
import { EMPTY_FILTERS, STATUS_LABEL, type Conversation, type ConversationStatus, type Filters, type Tag } from '@/lib/inbox';
import type { WaNumber } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';

function toQuery(f: Filters, cursor?: string | null): string {
  const p = new URLSearchParams();
  if (f.numberId) p.set('numberId', f.numberId);
  if (f.status) p.set('status', f.status);
  if (f.tagId) p.set('tagId', f.tagId);
  if (f.assignee) p.set('assignee', f.assignee);
  if (f.unread) p.set('unread', '1');
  if (f.q.trim()) p.set('q', f.q.trim());
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

const sortByRecent = (list: Conversation[]) => [...list].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.id.localeCompare(a.id));

export default function InboxPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [users, setUsers] = useState<Assignable[]>([]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const loadTags = useCallback(() => api<{ tags: Tag[] }>('/tags').then((r) => setTags(r.tags)).catch(() => undefined), []);

  useEffect(() => {
    api<{ numbers: WaNumber[] }>('/numbers').then((r) => setNumbers(r.numbers)).catch(() => undefined);
    api<{ users: Assignable[] }>('/users/assignable').then((r) => setUsers(r.users)).catch(() => undefined);
    void loadTags();
  }, [loadTags]);

  // Busca com atraso: só consulta quando a pessoa para de digitar.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Carrega a primeira página sempre que os filtros mudam.
  useEffect(() => {
    let active = true;
    setConversations(null);
    setError(null);
    api<{ conversations: Conversation[]; nextCursor: string | null }>(`/conversations?${toQuery(filters)}`)
      .then((r) => {
        if (!active) return;
        setConversations(r.conversations);
        setNextCursor(r.nextCursor);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Não foi possível carregar as conversas'));
    return () => {
      active = false;
    };
  }, [filters]);

  // Tempo real: várias mensagens seguidas viram uma única atualização da primeira página.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      const current = filtersRef.current;
      api<{ conversations: Conversation[] }>(`/conversations?${toQuery(current)}`)
        .then((r) => {
          if (filtersRef.current !== current) return; // filtros mudaram no meio do caminho
          setConversations((list) => {
            const map = new Map((list ?? []).map((c) => [c.id, c]));
            for (const c of r.conversations) map.set(c.id, c);
            return sortByRecent([...map.values()]);
          });
        })
        .catch(() => undefined);
    }, 400);
  }, []);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);
  useSocketEvent('message.new', refreshSoon);
  useSocketEvent('conversation.updated', refreshSoon);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ conversations: Conversation[]; nextCursor: string | null }>(`/conversations?${toQuery(filters, nextCursor)}`);
      setConversations((list) => [...(list ?? []), ...r.conversations.filter((c) => !list?.some((x) => x.id === c.id))]);
      setNextCursor(r.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar mais conversas');
    } finally {
      setLoadingMore(false);
    }
  }

  const onConversationChange = useCallback((c: Conversation) => {
    setConversations((list) => list?.map((x) => (x.id === c.id ? c : x)) ?? list);
  }, []);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const filtered = JSON.stringify({ ...filters, q: '' }) !== JSON.stringify(EMPTY_FILTERS) || search !== '';

  return (
    <div className="flex h-full min-h-0">
      {/* Lista: no celular ocupa a tela toda até uma conversa ser aberta. */}
      <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} min-h-0 w-full flex-col border-r border-slate-200 bg-white md:w-80 lg:w-96`}>
        <div className="space-y-2 border-b border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold">Conversas</h1>
            {filtered && (
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => { setSearch(''); setFilters(EMPTY_FILTERS); }}>Limpar filtros</button>
            )}
          </div>
          <input type="search" className="input" placeholder="Buscar por contato, telefone ou texto" aria-label="Buscar conversas" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <select className="input py-1.5 text-xs" aria-label="Número" value={filters.numberId} onChange={(e) => set('numberId', e.target.value)}>
              <option value="">Todos os números</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.nickname}</option>)}
            </select>
            <select className="input py-1.5 text-xs" aria-label="Status" value={filters.status} onChange={(e) => set('status', e.target.value as Filters['status'])}>
              <option value="">Todos os status</option>
              {(Object.keys(STATUS_LABEL) as ConversationStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select className="input py-1.5 text-xs" aria-label="Responsável" value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
              <option value="">Todos os responsáveis</option>
              <option value="me">Minhas</option>
              <option value="none">Sem responsável</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select className="input py-1.5 text-xs" aria-label="Etiqueta" value={filters.tagId} onChange={(e) => set('tagId', e.target.value)}>
              <option value="">Todas as etiquetas</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={filters.unread} onChange={(e) => set('unread', e.target.checked)} />
            Somente não lidas
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p role="alert" className="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : (
            <ConversationList conversations={conversations} selectedId={selectedId} onSelect={setSelectedId} onLoadMore={() => void loadMore()} hasMore={Boolean(nextCursor)} loading={loadingMore} />
          )}
        </div>
      </aside>

      <div className={`${selectedId ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        {selectedId ? (
          <ChatPane key={selectedId} conversationId={selectedId} users={users} tags={tags} onBack={() => setSelectedId(null)} onConversationChange={onConversationChange} onTagsChanged={() => void loadTags()} />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-slate-100 p-6 text-center text-sm text-slate-500">Selecione uma conversa para ver as mensagens.</div>
        )}
      </div>
    </div>
  );
}
