export type LeadStage = 'ABERTURA' | 'DESCOBERTA' | 'CONEXAO' | 'CONVITE' | 'AGENDADO' | 'ENCERRADO';
export type LeadTemperature = 'QUENTE' | 'MORNO' | 'FRIO';
export type AiStatus = 'OFF' | 'ACTIVE' | 'DONE';

export const STAGE_LABEL: Record<LeadStage, string> = {
  ABERTURA: 'Abertura',
  DESCOBERTA: 'Descoberta',
  CONEXAO: 'Conexão de valor',
  CONVITE: 'Convite',
  AGENDADO: 'Reunião marcada',
  ENCERRADO: 'Encerrado',
};
export const TEMP_LABEL: Record<LeadTemperature, string> = { QUENTE: 'Quente', MORNO: 'Morno', FRIO: 'Frio' };
export const TEMP_CLASS: Record<LeadTemperature, string> = {
  QUENTE: 'bg-red-50 text-red-700',
  MORNO: 'bg-amber-50 text-amber-800',
  FRIO: 'bg-sky-50 text-sky-800',
};

export interface SdrLead {
  id: string;
  conversationId: string;
  stage: LeadStage;
  temperature: LeadTemperature | null;
  cargo: string | null;
  produto: string | null;
  estados: string | null;
  porte: string | null;
  experiencia: string | null;
  dor: string | null;
  objecoes: string[];
  melhorHorario: string | null;
  email: string | null;
  proximoPasso: string | null;
  motivo: string | null;
  followUpCount: number;
  nextFollowUpAt: string | null;
  meetingStart: string | null;
  meetingLink: string | null;
  consultantName: string | null;
  handoffTo: string | null;
  updatedAt: string;
}

export interface SdrRun {
  id: string;
  trigger: string;
  status: 'ok' | 'skipped' | 'error';
  reply: string | null;
  error: string | null;
  toolCalls: { name: string; input: unknown; result: string; isError: boolean }[] | null;
  createdAt: string;
}

export interface SdrConfig {
  enabled: boolean;
  agentName: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  knowledgeBase: string;
  consultants: { name: string; email: string; active: boolean }[];
  meetingMinutes: number;
  meetingDays: number[];
  meetingStart: string;
  meetingEnd: string;
  minNoticeHours: number;
  followUpDays: number[];
  replyDelaySeconds: number;
}

export interface GoogleStatus {
  clientId: string | null;
  email: string | null;
  connectedAt: string | null;
  redirectUri: string;
}

export interface SdrStatus {
  enabled: boolean;
  hasApiKey: boolean;
  consultants: number;
  google: GoogleStatus;
  temperature: Record<string, number>;
  stage: Record<string, number>;
  upcomingMeetings: number;
  week: { runs: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

const dt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const formatWhen = (iso: string | null) => (iso ? dt.format(new Date(iso)) : '—');
