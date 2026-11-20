export type NumberStatus = 'DISCONNECTED' | 'CONNECTING' | 'QR_PENDING' | 'CONNECTED' | 'SUSPECT' | 'BANNED';

export interface WaNumber {
  id: string;
  nickname: string;
  color: string;
  phone: string | null;
  status: NumberStatus;
  statusReason: string | null;
  dailyLimit: number;
  warmupEnabled: boolean;
  campaignEnabled: boolean;
  lastConnectedAt: string | null;
  conversations: number;
  messages: number;
  today: { sent: number; received: number; campaignSent: number } | null;
}

export interface QrPayload {
  qr: string;
  attempt: number;
  maxAttempts: number;
}

export const STATUS_INFO: Record<NumberStatus, { label: string; className: string }> = {
  CONNECTED: { label: 'Conectado', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  CONNECTING: { label: 'Conectando…', className: 'bg-sky-50 text-sky-700 ring-sky-200' },
  QR_PENDING: { label: 'Aguardando QR', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  DISCONNECTED: { label: 'Desconectado', className: 'bg-slate-100 text-slate-600 ring-slate-200' },
  SUSPECT: { label: 'Suspeito — pausado', className: 'bg-orange-50 text-orange-800 ring-orange-200' },
  BANNED: { label: 'Banido', className: 'bg-red-50 text-red-700 ring-red-200' },
};

/** 5511988887777 → +55 (11) 98888-7777 */
export function formatPhone(phone: string | null): string {
  if (!phone) return 'Ainda não pareado';
  const br = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${phone}`;
}
