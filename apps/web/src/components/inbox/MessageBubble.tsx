'use client';

import { formatSize, formatTime, mediaUrl, TYPE_LABEL, type Message } from '@/lib/inbox';

const SOURCE_LABEL: Partial<Record<Message['source'], string>> = { PHONE: 'pelo celular', CAMPAIGN: 'campanha', AUTOMATION: 'automático', AI: 'IA do SDR' };

/** Tiques do WhatsApp: 1 = enviada, 2 = entregue, 2 azuis = lida. */
function Ticks({ status }: { status: Message['status'] }) {
  if (status === 'PENDING') return <span title="Enviando" aria-label="Enviando">🕓</span>;
  if (status === 'FAILED') return <span title="Não enviada" aria-label="Não enviada" className="text-red-600">⚠</span>;
  const read = status === 'READ' || status === 'PLAYED';
  const label = read ? 'Lida' : status === 'DELIVERED' ? 'Entregue' : 'Enviada';
  return (
    <span title={label} aria-label={label} className={`font-semibold tracking-[-0.2em] ${read ? 'text-sky-500' : 'text-slate-400'}`}>
      {status === 'SENT' ? '✓' : '✓✓'}
    </span>
  );
}

function MediaBlock({ message }: { message: Message }) {
  const m = message.media;
  if (!m) return null;
  if (m.status === 'PENDING') return <p className="rounded-lg bg-black/5 px-3 py-4 text-center text-xs text-slate-500">Baixando {TYPE_LABEL[message.type]?.toLowerCase() ?? 'mídia'}…</p>;
  if (m.status === 'FAILED' || !m.url) {
    return <p className="rounded-lg bg-black/5 px-3 py-3 text-xs text-slate-500">{TYPE_LABEL[message.type] ?? 'Mídia'} indisponível{m.error ? ` — ${m.error}` : ''}</p>;
  }
  const url = mediaUrl(m.url);
  switch (message.type) {
    case 'IMAGE':
    case 'STICKER':
      return (
        <a href={url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={message.text ?? TYPE_LABEL[message.type] ?? ''} loading="lazy" className={`rounded-lg object-contain ${message.type === 'STICKER' ? 'h-32 w-32' : 'max-h-80 w-full bg-black/5'}`} />
        </a>
      );
    case 'AUDIO':
      return <audio controls preload="none" src={url} className="w-64 max-w-full" />;
    case 'VIDEO':
      return <video controls preload="metadata" src={url} className="max-h-80 w-full rounded-lg bg-black" />;
    default:
      return (
        <a href={mediaUrl(m.url, true)} className="flex items-center gap-3 rounded-lg bg-black/5 px-3 py-2.5 hover:bg-black/10">
          <span aria-hidden className="text-xl">📄</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{m.fileName ?? 'Documento'}</span>
            <span className="block text-xs text-slate-500">{[formatSize(m.size), 'Baixar'].filter(Boolean).join(' · ')}</span>
          </span>
        </a>
      );
  }
}

export function MessageBubble({ message, isGroup }: { message: Message; isGroup: boolean }) {
  const mine = message.fromMe;
  const origin = mine ? (SOURCE_LABEL[message.source] ?? message.sentBy?.name) : null;
  const unsupported = !message.media && !message.text && message.type !== 'TEXT';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`relative max-w-[85%] rounded-xl px-3 py-2 shadow-sm sm:max-w-[70%] ${mine ? 'bg-emerald-100' : 'bg-white'} ${message.revokedAt ? 'opacity-70' : ''}`}>
        {isGroup && !mine && <p className="mb-0.5 text-xs font-semibold text-brand-700">{message.pushName ?? message.participantJid?.split('@')[0] ?? 'Participante'}</p>}
        {message.quoted && (
          <div className="mb-1.5 rounded-md border-l-4 border-brand-500 bg-black/5 px-2 py-1 text-xs text-slate-600">
            <p className="font-semibold">{message.quoted.fromMe ? 'Você' : (message.quoted.pushName ?? 'Contato')}</p>
            <p className="line-clamp-2">{message.quoted.text ?? TYPE_LABEL[message.quoted.type] ?? ''}</p>
          </div>
        )}
        {message.revokedAt && <p className="mb-1 text-xs italic text-slate-500">Mensagem apagada para todos</p>}
        <div className="space-y-1.5">
          <MediaBlock message={message} />
          {message.text && <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>}
          {unsupported && <p className="text-sm italic text-slate-500">{TYPE_LABEL[message.type] ?? 'Mensagem não suportada'}</p>}
        </div>
        {message.status === 'FAILED' && <p className="mt-1 text-xs text-red-700">Não enviada{message.error ? `: ${message.error}` : ''}</p>}
        <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-slate-500">
          {origin && <span className="truncate">{origin} ·</span>}
          {message.editedAt && <span>editada</span>}
          <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>
          {mine && <Ticks status={message.status} />}
        </p>
        {message.reactions.length > 0 && (
          <span className="absolute -bottom-3 right-2 rounded-full border border-slate-200 bg-white px-1.5 text-sm shadow-sm">{message.reactions.join('')}</span>
        )}
      </div>
    </div>
  );
}
