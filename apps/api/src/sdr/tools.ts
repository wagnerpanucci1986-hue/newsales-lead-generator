import { AiStatus, BlacklistSource, ConversationStatus, LeadStage, LeadTemperature, RecipientStatus, type Contact, type Conversation, type SdrLead } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';
import type { SettingValue } from '../lib/settings.js';
import { createMeeting, freeBusy, googleConnected, GoogleError } from './google.js';
import { describeSlot, freeSlots, localDate, localHour, spreadSlots, zonedTime, type Busy, type MeetingRules } from './slots.js';

const DAY = 86_400_000;
const str = (description: string) => ({ type: 'string', description });

/** Ferramentas da IA do SDR (sem limites numéricos no schema: são validados aqui, com zod). */
export const SDR_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'atualizar_ficha',
    description: 'Registra na ficha do lead o que você aprendeu na conversa. Chame sempre que surgir dado novo ou quando a etapa ou a temperatura mudarem. Envie só os campos que mudaram.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        etapa: { type: 'string', enum: ['ABERTURA', 'DESCOBERTA', 'CONEXAO', 'CONVITE'], description: 'Etapa atual do fluxo de atendimento' },
        temperatura: { type: 'string', enum: ['QUENTE', 'MORNO', 'FRIO'], description: 'Classificação do lead segundo a base de conhecimento' },
        cargo: str('Cargo ou papel do interlocutor (ex.: dono, sócio, comprador)'),
        produto: str('O que a empresa vende, nas palavras do lead'),
        estados: str('Estados ou regiões em que entrega'),
        porte: str('Porte aproximado'),
        experiencia: str('Experiência com licitação: nenhuma, pouca ou recorrente, com detalhes'),
        dor: str('Principal dor ou interesse, com as palavras do lead'),
        objecao: str('Objeção levantada agora e como foi respondida'),
        melhor_horario: str('Melhor horário e canal de contato'),
        email: str('E-mail informado pelo lead'),
        proximo_passo: str('Próximo passo combinado'),
      },
      required: [],
    },
  },
  {
    name: 'consultar_horarios',
    description: 'Lista horários livres para a reunião com os consultores, já respeitando as regras da agenda. Chame antes de propor horários ao lead.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        a_partir_de: { type: 'string', format: 'date', description: 'Data mínima (AAAA-MM-DD), se o lead pediu um dia específico ou mais para frente' },
        periodo: { type: 'string', enum: ['manha', 'tarde', 'qualquer'], description: 'Preferência do lead' },
      },
      required: [],
    },
  },
  {
    name: 'agendar_reuniao',
    description: 'Marca a reunião no Google Agenda do consultor, com link do Meet. Use só depois que o lead escolher um dos horários devolvidos por consultar_horarios.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inicio: { type: 'string', format: 'date-time', description: 'O valor "inicio" exato do horário escolhido' },
        consultor_email: { type: 'string', format: 'email', description: 'E-mail do consultor daquele horário' },
        email_lead: { type: 'string', format: 'email', description: 'E-mail do lead, se ele informou, para receber o convite' },
      },
      required: ['inicio', 'consultor_email'],
    },
  },
  {
    name: 'passar_para_humano',
    description: 'Passa a conversa para uma pessoa da New Sales e para de responder. Use nas situações da tabela de escalonamento. Avise o lead na mesma resposta.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        destino: { type: 'string', enum: ['consultor', 'carteira', 'time', 'lgpd', 'socio'], description: 'Para quem passar, segundo a tabela de escalonamento' },
        motivo: str('Por que está passando'),
        resumo: str('Resumo do que a pessoa precisa saber para continuar sem o lead repetir nada'),
      },
      required: ['destino', 'motivo', 'resumo'],
    },
  },
  {
    name: 'registrar_descadastro',
    description: 'O lead pediu para não receber mais mensagens (de qualquer forma). Bloqueia o contato para campanhas e encerra o atendimento.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: { motivo: str('O que o lead disse') }, required: ['motivo'] },
  },
  {
    name: 'agendar_retorno',
    description: 'Combina voltar a falar depois (lead pediu, ou está morno sem tempo agora). O sistema escreve para ele no dia marcado.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { dias: { type: 'integer', description: 'Daqui a quantos dias (1 a 30)' }, motivo: str('O que ficou combinado') },
      required: ['dias', 'motivo'],
    },
  },
  {
    name: 'encerrar_atendimento',
    description: 'Encerra o atendimento quando o lead for frio ou a recusa for definitiva. Registre o motivo.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { motivo: str('Motivo do encerramento'), temperatura: { type: 'string', enum: ['MORNO', 'FRIO'] } },
      required: ['motivo', 'temperatura'],
    },
  },
];

export interface ToolContext {
  conversation: Conversation;
  contact: Contact | null;
  lead: SdrLead;
  cfg: SettingValue<'sdr'>;
  timezone: string;
  now: Date;
  /** Teste pela tela: nada é gravado nem marcado de verdade. */
  dryRun: boolean;
  /** O que a execução decidiu e o laço precisa saber ao final. */
  state: { returnSet: boolean; ended: boolean; handedOff: boolean };
}

const ficha = z.object({
  etapa: z.enum(['ABERTURA', 'DESCOBERTA', 'CONEXAO', 'CONVITE']).optional(),
  temperatura: z.nativeEnum(LeadTemperature).optional(),
  cargo: z.string().max(200).optional(),
  produto: z.string().max(300).optional(),
  estados: z.string().max(200).optional(),
  porte: z.string().max(100).optional(),
  experiencia: z.string().max(300).optional(),
  dor: z.string().max(500).optional(),
  objecao: z.string().max(500).optional(),
  melhor_horario: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  proximo_passo: z.string().max(300).optional(),
});

const meetingRules = (cfg: SettingValue<'sdr'>, timezone: string): MeetingRules => ({
  timezone,
  days: cfg.meetingDays,
  start: cfg.meetingStart,
  end: cfg.meetingEnd,
  minutes: cfg.meetingMinutes,
  minNoticeHours: cfg.minNoticeHours,
});

/** Ficha em texto: vai na descrição do evento e na passagem para humano. */
export function leadSheet(lead: SdrLead, contact: Contact | null): string {
  const rows: [string, string | null | undefined][] = [
    ['Nome', contact?.name ?? contact?.pushName],
    ['Empresa', contact?.company],
    ['Telefone', contact?.phone ? `+${contact.phone}` : null],
    ['E-mail', lead.email ?? contact?.email],
    ['Cargo', lead.cargo],
    ['Produto', lead.produto],
    ['Estados', lead.estados],
    ['Porte', lead.porte],
    ['Experiência com licitação', lead.experiencia],
    ['Dor ou interesse', lead.dor],
    ['Objeções', lead.objecoes.join('; ') || null],
    ['Melhor horário', lead.melhorHorario],
    ['Temperatura', lead.temperature],
    ['Próximo passo', lead.proximoPasso],
  ];
  const fields = (contact?.customFields ?? {}) as Record<string, string>;
  for (const k of ['cnpj', 'cnae', 'cidade', 'uf', 'porte', 'capital_social']) if (fields[k] && !rows.some(([r]) => r.toLowerCase() === k)) rows.push([k.toUpperCase().replace('_', ' '), fields[k]]);
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

async function updateLead(ctx: ToolContext, data: Partial<SdrLead>): Promise<void> {
  Object.assign(ctx.lead, data);
  if (!ctx.dryRun) await prisma.sdrLead.update({ where: { id: ctx.lead.id }, data: data as never });
}

async function consultantsBusy(ctx: ToolContext, from: Date, to: Date) {
  const active = ctx.cfg.consultants.filter((c) => c.active);
  const busy = await freeBusy(active.map((c) => c.email), from, to);
  return active.map((c) => ({ ...c, busy: busy.get(c.email) })).filter((c): c is typeof c & { busy: Busy[] } => Array.isArray(c.busy));
}

type Handler = (input: unknown, ctx: ToolContext) => Promise<string>;

const handlers: Record<string, Handler> = {
  async atualizar_ficha(input, ctx) {
    const f = ficha.parse(input);
    const data: Partial<SdrLead> = {};
    if (f.etapa) data.stage = f.etapa as LeadStage;
    if (f.temperatura) data.temperature = f.temperatura;
    if (f.cargo) data.cargo = f.cargo;
    if (f.produto) data.produto = f.produto;
    if (f.estados) data.estados = f.estados;
    if (f.porte) data.porte = f.porte;
    if (f.experiencia) data.experiencia = f.experiencia;
    if (f.dor) data.dor = f.dor;
    if (f.objecao) data.objecoes = [...ctx.lead.objecoes, f.objecao].slice(-10);
    if (f.melhor_horario) data.melhorHorario = f.melhor_horario;
    if (f.email) data.email = f.email.toLowerCase();
    if (f.proximo_passo) data.proximoPasso = f.proximo_passo;
    await updateLead(ctx, data);
    return 'Ficha atualizada.';
  },

  async consultar_horarios(input, ctx) {
    const q = z.object({ a_partir_de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), periodo: z.enum(['manha', 'tarde', 'qualquer']).optional() }).parse(input);
    if (!ctx.cfg.consultants.some((c) => c.active)) return 'Nenhum consultor cadastrado no sistema. Não proponha horários: passe para humano (destino consultor) para marcar.';
    if (!(await googleConnected())) return 'A agenda não está conectada ao sistema. Não proponha horários: pergunte o melhor dia e período para o lead e passe para humano (destino consultor) para marcar.';
    const rules = meetingRules(ctx.cfg, ctx.timezone);
    const from = q.a_partir_de ? (([y, m, d]) => zonedTime(ctx.timezone, y!, m!, d!, '00:00'))(q.a_partir_de.split('-').map(Number)) : undefined;
    const horizonEnd = new Date(Math.max(ctx.now.getTime(), from?.getTime() ?? 0) + 14 * DAY);
    const consultants = await consultantsBusy(ctx, ctx.now, horizonEnd);
    if (!consultants.length) return 'Não consegui ler a agenda dos consultores agora. Passe para humano (destino consultor) para marcar.';
    let slots = freeSlots(rules, consultants, ctx.now, { from, max: 40, horizonDays: 14 });
    if (q.periodo === 'manha') slots = slots.filter((s) => localHour(ctx.timezone, s.start) < 12);
    if (q.periodo === 'tarde') slots = slots.filter((s) => localHour(ctx.timezone, s.start) >= 12);
    slots = spreadSlots(slots, ctx.timezone, 2).slice(0, 6);
    if (!slots.length) return 'Sem horários livres nos próximos 14 dias com essas condições. Pergunte outra preferência ou passe para humano (destino consultor).';
    return [
      'Horários livres (ofereça dois, de dias diferentes):',
      ...slots.map((s, i) => `${i + 1}. ${describeSlot(ctx.timezone, s.start)} — consultor ${s.consultantName} — inicio=${s.start.toISOString()} consultor_email=${s.consultantEmail}`),
    ].join('\n');
  },

  async agendar_reuniao(input, ctx) {
    const q = z.object({ inicio: z.string().datetime({ offset: true }), consultor_email: z.string().email(), email_lead: z.string().email().optional() }).parse(input);
    const consultant = ctx.cfg.consultants.find((c) => c.active && c.email.toLowerCase() === q.consultor_email.toLowerCase());
    if (!consultant) return 'Erro: esse consultor não está na lista. Use um horário devolvido por consultar_horarios.';
    const start = new Date(q.inicio);
    const end = new Date(start.getTime() + ctx.cfg.meetingMinutes * 60_000);
    // Confere de novo: o horário pode ter sido ocupado desde a consulta.
    const rules = meetingRules(ctx.cfg, ctx.timezone);
    const { weekday } = localDate(ctx.timezone, start);
    if (!rules.days.includes(weekday) || start.getTime() < ctx.now.getTime() + rules.minNoticeHours * 3_600_000) return 'Erro: esse horário está fora das regras da agenda. Consulte os horários de novo.';
    if (!ctx.dryRun) {
      const busy = (await freeBusy([consultant.email], start, end)).get(consultant.email);
      if (busy === 'erro' || busy?.length) return 'Esse horário acabou de ser ocupado. Consulte os horários de novo e ofereça outras opções.';
    }
    const email = q.email_lead?.toLowerCase() ?? ctx.lead.email ?? null;
    let link: string | null = null;
    let eventId: string | null = null;
    if (!ctx.dryRun) {
      const name = ctx.contact?.name ?? ctx.contact?.pushName ?? 'Lead';
      const ev = await createMeeting({
        start,
        end,
        summary: `New Sales × ${ctx.contact?.company ?? name} — ${consultant.name}`,
        description: `Reunião marcada pela IA do SDR (${ctx.cfg.agentName}) pelo WhatsApp.\n\n${leadSheet({ ...ctx.lead, email }, ctx.contact)}`,
        attendees: [consultant.email, ...(email ? [email] : [])],
        requestId: randomUUID(),
      });
      link = ev.link;
      eventId = ev.id;
    }
    await updateLead(ctx, {
      stage: LeadStage.AGENDADO,
      temperature: LeadTemperature.QUENTE,
      meetingStart: start,
      meetingEnd: end,
      meetingEventId: eventId,
      meetingLink: link,
      consultantName: consultant.name,
      consultantEmail: consultant.email,
      email,
      remindedDayBefore: false,
      remindedSameDay: false,
      nextFollowUpAt: null,
    });
    if (!ctx.dryRun) {
      await prisma.conversationEvent.create({ data: { conversationId: ctx.conversation.id, type: 'sdr_meeting', data: { start: start.toISOString(), consultant: consultant.name, link, sheet: leadSheet(ctx.lead, ctx.contact) } } });
      await audit({ action: 'sdr.meeting', entity: 'Conversation', entityId: ctx.conversation.id, meta: { start: start.toISOString(), consultant: consultant.email } });
    }
    return `Reunião marcada: ${describeSlot(ctx.timezone, start)} com ${consultant.name}${link ? `, link ${link}` : ''}${email ? `; convite enviado para ${email}` : ''}${ctx.dryRun ? ' (teste: nada foi marcado de verdade)' : ''}. Confirme ao lead data, hora e consultor.`;
  },

  async passar_para_humano(input, ctx) {
    const q = z.object({ destino: z.enum(['consultor', 'carteira', 'time', 'lgpd', 'socio']), motivo: z.string().max(500), resumo: z.string().max(2000) }).parse(input);
    ctx.state.handedOff = true;
    await updateLead(ctx, { handoffTo: q.destino, motivo: q.motivo });
    if (!ctx.dryRun) {
      await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { status: ConversationStatus.PENDING, automationPausedAt: ctx.now } });
      await prisma.conversationEvent.create({
        data: { conversationId: ctx.conversation.id, type: 'handoff', data: { by: 'sdr', destino: q.destino, motivo: q.motivo, resumo: q.resumo, sheet: leadSheet(ctx.lead, ctx.contact) } },
      });
    }
    return 'Conversa passada para a equipe; você não responderá mais nesta conversa. Avise o lead agora, numa frase.';
  },

  async registrar_descadastro(input, ctx) {
    const q = z.object({ motivo: z.string().max(300) }).parse(input);
    ctx.state.ended = true;
    await updateLead(ctx, { stage: LeadStage.ENCERRADO, temperature: LeadTemperature.FRIO, motivo: `Descadastro: ${q.motivo}`, nextFollowUpAt: null });
    if (!ctx.dryRun && ctx.contact) {
      await prisma.blacklistEntry.upsert({ where: { phone: ctx.contact.phone }, create: { phone: ctx.contact.phone, source: BlacklistSource.OPT_OUT, reason: `IA do SDR: ${q.motivo}`.slice(0, 200) }, update: {} });
      await prisma.contact.update({ where: { id: ctx.contact.id }, data: { optedOutAt: ctx.contact.optedOutAt ?? ctx.now } });
      await prisma.campaignRecipient.updateMany({ where: { contactId: ctx.contact.id, status: RecipientStatus.QUEUED }, data: { status: RecipientStatus.SKIPPED, skipReason: 'opt-out' } });
      await audit({ action: 'contact.opt_out', entity: 'Contact', entityId: ctx.contact.id, meta: { by: 'sdr', motivo: q.motivo } });
    }
    return 'Descadastro registrado. Despeça-se em uma frase, sem pergunta.';
  },

  async agendar_retorno(input, ctx) {
    const q = z.object({ dias: z.number().int().min(1).max(30), motivo: z.string().max(300) }).parse(input);
    ctx.state.returnSet = true;
    await updateLead(ctx, { nextFollowUpAt: new Date(ctx.now.getTime() + q.dias * DAY), followUpCount: 0, proximoPasso: q.motivo, temperature: ctx.lead.temperature ?? LeadTemperature.MORNO });
    return `Retorno combinado para daqui a ${q.dias} dia(s).`;
  },

  async encerrar_atendimento(input, ctx) {
    const q = z.object({ motivo: z.string().max(300), temperatura: z.enum(['MORNO', 'FRIO']) }).parse(input);
    ctx.state.ended = true;
    await updateLead(ctx, { stage: LeadStage.ENCERRADO, temperature: q.temperatura, motivo: q.motivo, nextFollowUpAt: null });
    return 'Atendimento encerrado. Despeça-se com cordialidade, se ainda não o fez.';
  },
};

/** Executa uma ferramenta pedida pela IA. Erro vira texto para a IA reagir (nunca derruba a conversa). */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean }> {
  const handler = handlers[name];
  if (!handler) return { text: `Ferramenta desconhecida: ${name}`, isError: true };
  try {
    return { text: await handler(input, ctx), isError: false };
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `Parâmetros inválidos: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
    if (err instanceof GoogleError) return { text: `${err.message} Não insista: passe para humano (destino consultor) para marcar.`, isError: true };
    throw err;
  }
}

/** Estado final da conversa depois da execução. */
export const endedStatus = (s: ToolContext['state']) => (s.ended ? AiStatus.DONE : null);
