'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatDay, type Conversation, type Message, type Tag } from '@/lib/inbox';
import { useSocketEvent } from '@/lib/socket';
import { ChatHeader, type Assignable } from './ChatHeader';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';

const byTime = (a: Message, b: Message) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);

/** Junta mensagens novas às existentes, sem duplicar, em ordem cronológica. */
function merge(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}

export function ChatPane({
  conversationId,
  users,
  tags,
  onBack,
  onConversationChange,
  onTagsChanged,
}: {
  conversationId: string;
  users: Assignable[];
  tags: Tag[];
  onBack: () => void;
  onConversationChange: (c: Conversation) => void;
  onTagsChanged: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // O que fazer com a rolagem depois de renderizar: ir ao fim ou manter a posição ao carregar antigas.
  const scrollIntent = useRef<{ kind: 'bottom' } | { kind: 'keep'; fromBottom: number } | null>(null);

  const applyConversation = useCallback(
    (c: Conversation) => {
      setConversation(c);
      onConversationChange(c);
    },
    [onConversationChange],
  );

  const markRead = useCallback(() => {
    api(`/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    setConversation(null);
    setMessages([]);
    setError(null);
    Promise.all([
      api<{ conversation: Conversation }>(`/conversations/${conversationId}`),
      api<{ messages: Message[]; hasMore: boolean }>(`/conversations/${conversationId}/messages`),
    ])
      .then(([c, m]) => {
        if (!active) return;
        scrollIntent.current = { kind: 'bottom' };
        setConversation(c.conversation);
        setMessages(m.messages);
        setHasMore(m.hasMore);
        markRead();
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Não foi possível abrir a conversa'));
    return () => {
      active = false;
    };
  }, [conversationId, markRead]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const intent = scrollIntent.current;
    if (!el || !intent) return;
    el.scrollTop = intent.kind === 'bottom' ? el.scrollHeight : el.scrollHeight - intent.fromBottom;
    scrollIntent.current = null;
  }, [messages]);

  const nearBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };

  const fetchMessage = useCallback(
    async (messageId: string, opts: { scroll: boolean }) => {
      const res = await api<{ message: Message }>(`/conversations/${conversationId}/messages/${messageId}`).catch(() => null);
      // Reações não aparecem como mensagem; a rota devolve a reação, então ignoramos aqui.
      if (!res || res.message.type === 'REACTION') return;
      if (opts.scroll && (res.message.fromMe || nearBottom())) scrollIntent.current = { kind: 'bottom' };
      setMessages((list) => merge(list, [res.message]));
      if (opts.scroll && !res.message.fromMe) markRead();
    },
    [conversationId, markRead],
  );

  useSocketEvent<{ conversationId: string; messageId: string }>('message.new', (e) => {
    if (e.conversationId === conversationId) void fetchMessage(e.messageId, { scroll: true });
  });
  useSocketEvent<{ conversationId: string; messageId: string; status: Message['status'] }>('message.status', (e) => {
    if (e.conversationId !== conversationId) return;
    setMessages((list) => list.map((m) => (m.id === e.messageId ? { ...m, status: e.status } : m)));
    if (e.status === 'FAILED') void fetchMessage(e.messageId, { scroll: false }); // traz o motivo
  });
  useSocketEvent<{ conversationId: string; messageId: string }>('media.ready', (e) => {
    if (e.conversationId === conversationId) void fetchMessage(e.messageId, { scroll: false });
  });
  useSocketEvent<{ conversationId: string }>('conversation.updated', (e) => {
    if (e.conversationId !== conversationId) return;
    api<{ conversation: Conversation }>(`/conversations/${conversationId}`).then((r) => setConversation(r.conversation)).catch(() => undefined);
  });

  async function loadOlder() {
    const first = messages[0];
    const el = scroller.current;
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api<{ messages: Message[]; hasMore: boolean }>(`/conversations/${conversationId}/messages?before=${first.id}`);
      if (el) scrollIntent.current = { kind: 'keep', fromBottom: el.scrollHeight - el.scrollTop };
      setMessages((list) => merge(list, res.messages));
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar mensagens anteriores');
    } finally {
      setLoadingOlder(false);
    }
  }

  if (error && !conversation) return <p role="alert" className="m-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!conversation) return <p className="p-6 text-sm text-slate-500">Abrindo conversa…</p>;

  const disabledReason = conversation.number.status !== 'CONNECTED' && conversation.number.status !== 'SUSPECT' ? `O número “${conversation.number.nickname}” está desconectado. Reconecte-o em Números para responder.` : null;

  let lastDay = '';
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Conversa com ${conversation.name}`}>
      <ChatHeader conversation={conversation} users={users} tags={tags} onChange={applyConversation} onBack={onBack} onTagsChanged={onTagsChanged} />
      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-100 px-3 py-4 sm:px-6">
        {hasMore && (
          <div className="text-center">
            <button className="btn btn-secondary text-xs" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores'}</button>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {messages.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Nenhuma mensagem nesta conversa.</p>}
        {messages.map((m) => {
          const day = formatDay(m.timestamp);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={m.id}>
              {showDay && (
                <p className="py-1 text-center">
                  <span className="rounded-full bg-white px-3 py-1 text-xs capitalize text-slate-500 shadow-sm">{day}</span>
                </p>
              )}
              <MessageBubble message={m} isGroup={conversation.isGroup} />
            </Fragment>
          );
        })}
      </div>
      <Composer
        conversationId={conversationId}
        disabledReason={disabledReason}
        onSent={(m) => {
          scrollIntent.current = { kind: 'bottom' };
          setMessages((list) => merge(list, [m]));
        }}
      />
    </section>
  );
}
