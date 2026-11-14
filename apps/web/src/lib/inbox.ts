import { API_URL } from './api';

export type ConversationStatus = 'OPEN' | 'PENDING' | 'CLOSED';
export type MessageType = 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER' | 'LOCATION' | 'CONTACT' | 'REACTION' | 'OTHER';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'PLAYED' | 'FAILED' | 'RECEIVED';

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Conversation {
  id: string;
  isGroup: boolean;
  name: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromMe: boolean;
  automationPaused: boolean;
  number: { id: string; nickname: string; color: string; phone: string | null; status: string };
  contact: { id: string; name: string | null; phone: string; pushName: string | null; company: string | null; optedOutAt: string | null } | null;
  assignee: { id: string; name: string } | null;
  tags: Tag[];
}

export interface Message {
  id: string;
  conversationId: string;
  fromMe: boolean;
  source: 'INBOUND' | 'PANEL' | 'PHONE' | 'CAMPAIGN' | 'AUTOMATION';
  type: MessageType;
  status: MessageStatus;
  text: string | null;
  timestamp: string;
  pushName: string | null;
  participantJid: string | null;
  editedAt: string | null;
  revokedAt: string | null;
  error: string | null;
  sentBy: { id: string; name: string } | null;
  media: {
    id: string;
    status: 'PENDING' | 'STORED' | 'FAILED';
    mimeType: string;
    fileName: string | null;
    size: number | null;
    durationS: number | null;
    isPtt: boolean;
    error: string | null;
    url: string | null;
  } | null;
  quoted: { text: string | null; type: MessageType; fromMe: boolean; pushName: string | null } | null;
  reactions: string[];
}

export interface Filters {
  numberId: string;
  status: '' | ConversationStatus;
  tagId: string;
  assignee: string;
  unread: boolean;
  q: string;
}

export const EMPTY_FILTERS: Filters = { numberId: '', status: '', tagId: '', assignee: '', unread: false, q: '' };

export const STATUS_LABEL: Record<ConversationStatus, string> = { OPEN: 'Aberta', PENDING: 'Pendente', CLOSED: 'Encerrada' };

export const TYPE_LABEL: Partial<Record<MessageType, string>> = {
  IMAGE: 'Imagem',
  VIDEO: 'Vídeo',
  AUDIO: 'Áudio',
  DOCUMENT: 'Documento',
  STICKER: 'Figurinha',
  LOCATION: 'Localização',
  CONTACT: 'Contato',
  OTHER: 'Mensagem não suportada',
};

export const mediaUrl = (path: string, download = false) => `${API_URL}${path}${download ? '&download=1' : ''}`;

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Hoje", "Ontem", dia da semana (última semana) ou data. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return weekdayFmt.format(date);
  return dayFmt.format(date);
}

/** Na lista: hora se for hoje, senão o dia. */
export function formatListTime(iso: string | null): string {
  if (!iso) return '';
  const label = formatDay(iso);
  return label === 'Hoje' ? formatTime(iso) : label;
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
