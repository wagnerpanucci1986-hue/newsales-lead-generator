import { MessageType, type Contact, type Conversation, type SdrLead } from '@prisma/client';
import { getSetting, type SettingValue } from '../lib/settings.js';
import { think, type ThinkResult } from './agent.js';
import type { ToolContext } from './tools.js';

/**
 * Conversa de teste pela tela: a IA responde como responderia no WhatsApp, mas nada é
 * enviado, gravado ou marcado (a agenda só é lida). A ficha volta para a próxima rodada.
 */
export async function simulate(input: {
  messages: { fromMe: boolean; text: string }[];
  contact: { name?: string; company?: string; customFields?: Record<string, string> };
  lead?: Partial<SdrLead>;
  cfgOverride?: Partial<SettingValue<'sdr'>>;
  now?: Date;
}): Promise<ThinkResult & { lead: SdrLead }> {
  const cfg = { ...(await getSetting('sdr')), ...input.cfgOverride };
  const hours = await getSetting('businessHours');
  const now = input.now ?? new Date();
  const contact = {
    id: 'teste',
    phone: '5543999990000',
    name: input.contact.name ?? null,
    company: input.contact.company ?? null,
    email: null,
    pushName: null,
    customFields: input.contact.customFields ?? {},
    optedOutAt: null,
  } as unknown as Contact;
  const lead = {
    id: 'teste',
    conversationId: 'teste',
    stage: 'ABERTURA',
    temperature: null,
    objecoes: [],
    followUpCount: 0,
    ...input.lead,
  } as unknown as SdrLead;
  const ctx: ToolContext = { conversation: { id: 'teste' } as Conversation, contact, lead, cfg, timezone: hours.timezone, now, dryRun: true, state: { returnSet: false, ended: false, handedOff: false } };
  const history = input.messages.map((m) => ({ fromMe: m.fromMe, text: m.text, type: MessageType.TEXT, revokedAt: null }));
  const last = input.messages[input.messages.length - 1];
  const r = await think({ cfg, timezone: hours.timezone, now, contact, history, trigger: last && last.fromMe ? { kind: 'followup', number: 1, total: cfg.followUpDays.length, days: cfg.followUpDays[0] ?? 2 } : { kind: 'reply' }, ctx });
  return { ...r, lead: ctx.lead };
}
