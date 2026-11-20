import type { Tag } from './inbox';

export type WaCheckStatus = 'UNKNOWN' | 'VALID' | 'INVALID';

export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  company: string | null;
  email: string | null;
  customFields: Record<string, string>;
  waStatus: WaCheckStatus;
  pushName: string | null;
  consentSource: string | null;
  optedOutAt: string | null;
  createdAt: string;
  tags: Tag[];
  lists: { id: string; name: string }[];
}

export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  members: number;
}

export interface BlacklistEntry {
  phone: string;
  source: 'OPT_OUT' | 'MANUAL' | 'IMPORT';
  reason: string | null;
  createdAt: string;
}

export interface ImportJob {
  id: string;
  fileName: string;
  status: 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  created: number;
  updated: number;
  invalid: number;
  blacklisted: number;
  error: string | null;
  errorReport: { rejected: { line: number; value: string; reason: string }[]; duplicatedInFile: number } | null;
}

export const WA_STATUS: Record<WaCheckStatus, { label: string; className: string }> = {
  VALID: { label: 'Tem WhatsApp', className: 'bg-emerald-50 text-emerald-700' },
  INVALID: { label: 'Sem WhatsApp', className: 'bg-red-50 text-red-700' },
  UNKNOWN: { label: 'Não verificado', className: 'bg-slate-100 text-slate-600' },
};

export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELED';
export type RecipientStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SKIPPED';

export interface CampaignStats {
  total: number;
  queued: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  replied: number;
  optOut: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  body: string;
  audienceFilter: { tagIds: string[]; onlyWaValid: boolean } | null;
  scheduledAt: string | null;
  timezone: string;
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  minDelayS: number;
  maxDelayS: number;
  longPauseEvery: number;
  longPauseMinS: number;
  longPauseMaxS: number;
  simulateTyping: boolean;
  consentConfirmed: boolean;
  legalBasis: 'CONSENT' | 'LEGITIMATE_INTEREST' | null;
  sdrEnabled: boolean;
  variants: string[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  numbers: { id: string; nickname: string; color: string; status: string }[];
  lists: { id: string; name: string }[];
  media: { id: string; fileName: string | null; mimeType: string; size: number | null; url: string } | null;
  createdBy: { id: string; name: string } | null;
  stats: CampaignStats;
}

export interface Recipient {
  id: string;
  status: RecipientStatus;
  renderedText: string | null;
  skipReason: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  optedOutAt: string | null;
  contact: { name: string | null; phone: string };
  number: { nickname: string } | null;
}

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Rascunho', className: 'bg-slate-100 text-slate-600' },
  SCHEDULED: { label: 'Agendada', className: 'bg-sky-50 text-sky-700' },
  RUNNING: { label: 'Em andamento', className: 'bg-emerald-50 text-emerald-700' },
  PAUSED: { label: 'Pausada', className: 'bg-amber-50 text-amber-800' },
  COMPLETED: { label: 'Concluída', className: 'bg-slate-100 text-slate-700' },
  CANCELED: { label: 'Cancelada', className: 'bg-red-50 text-red-700' },
};

export const RECIPIENT_STATUS: Record<RecipientStatus, string> = {
  QUEUED: 'Na fila',
  SENDING: 'Enviando',
  SENT: 'Enviada',
  DELIVERED: 'Entregue',
  READ: 'Lida',
  FAILED: 'Falhou',
  SKIPPED: 'Pulada',
};

export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const dateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '—');
export const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '—');
