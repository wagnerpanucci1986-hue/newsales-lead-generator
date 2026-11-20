import { z } from 'zod';
import { prisma } from './prisma.js';
import { DEFAULT_KNOWLEDGE_BASE } from '../sdr/knowledge-base.js';

// Configurações globais (tabela Setting). Cada chave tem um schema com padrões,
// então o sistema funciona sem nenhuma linha gravada.
export const settingSchemas = {
  optOut: z.object({
    keywords: z.array(z.string().trim().min(1).max(30)).min(1).max(20).default(['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'DESCADASTRAR']),
    confirmation: z.string().trim().min(1).max(500).default('Pronto! Você não receberá mais nossas mensagens. Se mudar de ideia, é só nos chamar por aqui.'),
  }),
  antiBan: z.object({
    // Aquecimento: limite do 1º dia e crescimento diário até o limite do número.
    warmupStart: z.number().int().min(1).max(500).default(20),
    warmupGrowth: z.number().min(1).max(3).default(1.25),
    // Falhas seguidas que pausam o número.
    maxConsecutiveFailures: z.number().int().min(2).max(50).default(5),
    // Queda de qualidade: taxa mínima de entrega nas últimas mensagens de campanha.
    minDeliveryRate: z.number().min(0).max(1).default(0.5),
    deliverySample: z.number().int().min(10).max(200).default(20),
  }),
  // Horário de atendimento, usado pela resposta automática "fora do horário".
  businessHours: z.object({
    timezone: z.string().default('America/Sao_Paulo'),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
  }),
  // IA do SDR: persona, base de conhecimento, consultores e regras de agenda e follow-up.
  sdr: z.object({
    enabled: z.boolean().default(false),
    agentName: z.string().trim().min(1).max(40).default('Ana'),
    model: z.string().trim().min(1).max(60).default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    knowledgeBase: z.string().max(60_000).default(DEFAULT_KNOWLEDGE_BASE),
    consultants: z
      .array(z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().email(), active: z.boolean().default(true) }))
      .max(20)
      .default([]),
    meetingMinutes: z.number().int().min(10).max(120).default(20),
    meetingDays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
    meetingStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
    meetingEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
    minNoticeHours: z.number().int().min(0).max(72).default(3),
    // Follow-ups sem resposta, em dias depois da última mensagem da IA (o último é a despedida).
    followUpDays: z.array(z.number().int().min(1).max(60)).max(5).default([2, 5, 10]),
    // Espera antes de responder: junta mensagens seguidas do lead e não parece robô.
    replyDelaySeconds: z.number().int().min(5).max(600).default(40),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 15_000; // o worker relê as configurações em até 15 s

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as SettingValue<K>;
  const row = await prisma.setting.findUnique({ where: { key } });
  const parsed = settingSchemas[key].safeParse(row?.value ?? {});
  const value = (parsed.success ? parsed.data : settingSchemas[key].parse({})) as SettingValue<K>;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting<K extends SettingKey>(key: K, input: unknown): Promise<SettingValue<K>> {
  const value = settingSchemas[key].parse(input) as SettingValue<K>;
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  cache.delete(key);
  return value;
}

/** Só para testes. */
export const clearSettingsCache = () => cache.clear();
