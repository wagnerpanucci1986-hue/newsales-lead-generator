import { MessageStatus, MessageType } from '@prisma/client';
import { BufferJSON, getContentType, normalizeMessageContent, proto, toNumber, type WAMessage } from 'baileys';

export interface ParsedMedia {
  mimeType: string;
  fileName?: string;
  size?: number;
  durationS?: number;
  width?: number;
  height?: number;
  isPtt: boolean;
}

export type ParsedMessage =
  | { kind: 'skip' }
  | { kind: 'revoke'; targetId: string }
  | { kind: 'edit'; targetId: string; text: string | null }
  | {
      kind: 'message';
      type: MessageType;
      text: string | null;
      quotedWaId: string | null;
      media: ParsedMedia | null;
      /** conteúdo normalizado, serializável, sem miniaturas */
      raw: unknown;
    };

// Mensagens de controle do protocolo: não são conteúdo de conversa.
const IGNORED = new Set([
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'encReactionMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'encEventResponseMessage',
  'call',
]);

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = toNumber(v as number);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function textOf(content: proto.IMessage): string | null {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

/** Interpreta o conteúdo de uma mensagem do Baileys no formato do nosso banco. */
export function parseMessage(msg: WAMessage): ParsedMessage {
  const content = normalizeMessageContent(msg.message);
  if (!content) return { kind: 'skip' }; // stubs (entrou no grupo, chamada perdida etc.)

  const contentType = getContentType(content);
  if (!contentType || IGNORED.has(contentType)) return { kind: 'skip' };

  if (contentType === 'protocolMessage') {
    const p = content.protocolMessage!;
    const targetId = p.key?.id;
    if (!targetId) return { kind: 'skip' };
    if (p.type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: 'revoke', targetId };
    if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && p.editedMessage) {
      const edited = normalizeMessageContent(p.editedMessage);
      return { kind: 'edit', targetId, text: edited ? textOf(edited) : null };
    }
    return { kind: 'skip' };
  }

  let type: MessageType = MessageType.OTHER;
  let text: string | null = textOf(content);
  let media: ParsedMedia | null = null;
  let quotedWaId: string | null = null;

  switch (contentType) {
    case 'conversation':
    case 'extendedTextMessage':
      type = MessageType.TEXT;
      break;
    case 'imageMessage': {
      const m = content.imageMessage!;
      type = MessageType.IMAGE;
      media = { mimeType: m.mimetype ?? 'image/jpeg', size: num(m.fileLength), width: num(m.width), height: num(m.height), isPtt: false };
      break;
    }
    case 'videoMessage':
    case 'ptvMessage': {
      const m = (content.videoMessage ?? content.ptvMessage)!;
      type = MessageType.VIDEO;
      media = { mimeType: m.mimetype ?? 'video/mp4', size: num(m.fileLength), durationS: num(m.seconds), width: num(m.width), height: num(m.height), isPtt: false };
      break;
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      type = MessageType.AUDIO;
      media = { mimeType: m.mimetype ?? 'audio/ogg', size: num(m.fileLength), durationS: num(m.seconds), isPtt: Boolean(m.ptt) };
      break;
    }
    case 'documentMessage': {
      const m = content.documentMessage!;
      type = MessageType.DOCUMENT;
      media = { mimeType: m.mimetype ?? 'application/octet-stream', fileName: m.fileName ?? m.title ?? undefined, size: num(m.fileLength), isPtt: false };
      break;
    }
    case 'stickerMessage': {
      const m = content.stickerMessage!;
      type = MessageType.STICKER;
      media = { mimeType: m.mimetype ?? 'image/webp', size: num(m.fileLength), width: num(m.width), height: num(m.height), isPtt: false };
      break;
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const m = (content.locationMessage ?? content.liveLocationMessage)!;
      type = MessageType.LOCATION;
      text = [(m as proto.Message.ILocationMessage).name, `${m.degreesLatitude},${m.degreesLongitude}`].filter(Boolean).join(' — ');
      break;
    }
    case 'contactMessage':
      type = MessageType.CONTACT;
      text = content.contactMessage?.displayName ?? null;
      break;
    case 'contactsArrayMessage':
      type = MessageType.CONTACT;
      text = (content.contactsArrayMessage?.contacts ?? []).map((c) => c.displayName).filter(Boolean).join(', ') || null;
      break;
    case 'reactionMessage':
      type = MessageType.REACTION;
      text = content.reactionMessage?.text || null; // vazio = reação removida
      quotedWaId = content.reactionMessage?.key?.id ?? null;
      break;
    default:
      type = MessageType.OTHER;
  }

  if (type !== MessageType.REACTION) {
    const inner = content[contentType] as { contextInfo?: proto.IContextInfo } | string | null | undefined;
    if (inner && typeof inner === 'object') quotedWaId = inner.contextInfo?.stanzaId ?? null;
  }

  return { kind: 'message', type, text, quotedWaId, media, raw: toRaw(content) };
}

/** JSON serializável do conteúdo (Buffers em base64), sem as miniaturas embutidas. */
function toRaw(content: proto.IMessage): unknown {
  return JSON.parse(
    JSON.stringify(content, (key, value) => (key === 'jpegThumbnail' || key === 'thumbnail' ? undefined : BufferJSON.replacer(key, value))),
  );
}

/** Reconstrói o conteúdo gravado em Message.raw (para baixar mídia ou reenviar). */
export function fromRaw(raw: unknown): proto.IMessage {
  return JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as proto.IMessage;
}

const STATUS_RANK: Record<MessageStatus, number> = {
  FAILED: 0,
  PENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  PLAYED: 5,
  RECEIVED: 9,
};

/** Status do WhatsApp (0–5) → o nosso. */
export function mapWaStatus(status: number | null | undefined): MessageStatus | null {
  switch (status) {
    case proto.WebMessageInfo.Status.ERROR:
      return MessageStatus.FAILED;
    case proto.WebMessageInfo.Status.PENDING:
      return MessageStatus.PENDING;
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return MessageStatus.SENT;
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return MessageStatus.DELIVERED;
    case proto.WebMessageInfo.Status.READ:
      return MessageStatus.READ;
    case proto.WebMessageInfo.Status.PLAYED:
      return MessageStatus.PLAYED;
    default:
      return null;
  }
}

/** Status anteriores a `status`: recibos chegam fora de ordem e nunca devem regredir. */
export function statusesBelow(status: MessageStatus): MessageStatus[] {
  return (Object.keys(STATUS_RANK) as MessageStatus[]).filter((s) => STATUS_RANK[s] < STATUS_RANK[status] && s !== MessageStatus.RECEIVED);
}

export function previewOf(type: MessageType, text: string | null): string {
  const labels: Partial<Record<MessageType, string>> = {
    IMAGE: '📷 Imagem',
    VIDEO: '🎥 Vídeo',
    AUDIO: '🎤 Áudio',
    DOCUMENT: '📄 Documento',
    STICKER: 'Figurinha',
    LOCATION: '📍 Localização',
    CONTACT: '👤 Contato',
    OTHER: 'Mensagem não suportada',
  };
  const label = labels[type];
  const body = text?.replace(/\s+/g, ' ').trim();
  return (label && body ? `${label}: ${body}` : (body ?? label ?? '')).slice(0, 200);
}
