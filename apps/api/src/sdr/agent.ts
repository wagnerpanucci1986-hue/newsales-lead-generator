import { AiStatus, LeadStage, LeadTemperature, MessageSource, MessageStatus, MessageType, type Contact, type Conversation, type Message, type SdrLead } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { SdrJob } from '../lib/queues.js';
import { getSetting, type SettingValue } from '../lib/settings.js';
import { sendPendingMessage, type SocketProvider } from '../whatsapp/sender.js';
import { createMessage, hasApiKey } from './model.js';
import { contextPrompt, splitReply, staticPrompt, transcript, type SdrTrigger } from './prompt.js';
import { runTool, SDR_TOOLS, type ToolContext } from './tools.js';

const DAY = 86_400_000;
const MAX_TURNS = 8;
const HISTORY = 40;
// Modelos que aceitam o fallback do servidor em caso de recusa ("default": a API escolhe o modelo).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1']);

export class SdrRefusal extends Error {}

export interface ThinkResult {
  replies: string[];
  toolCalls: { name: string; input: unknown; result: string; isError: boolean }[];
  usage: { input: number; output: number; cacheRead: number };
}

/**
 * Uma rodada da IA: monta o prompt, chama o Claude e executa as ferramentas até a resposta final.
 * Não envia nada: devolve os balões de texto para quem chamou decidir.
 */
export async function think(input: {
  cfg: SettingValue<'sdr'>;
  timezone: string;
  now: Date;
  contact: Contact | null;
  history: Pick<Message, 'fromMe' | 'type' | 'text' | 'revokedAt'>[];
  trigger: SdrTrigger;
  ctx: ToolContext;
}): Promise<ThinkResult> {
  const { cfg } = input;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    // Persona + base de conhecimento: fixos, ficam em cache (as ferramentas vêm antes e entram junto).
    { type: 'text', text: staticPrompt(cfg), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextPrompt({ cfg, timezone: input.timezone, now: input.now, contact: input.contact, lead: input.ctx.lead, trigger: input.trigger }) },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = transcript(input.history, input.trigger);
  const result: ThinkResult = { replies: [], toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0 } };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await createMessage({
      model: cfg.model,
      max_tokens: 8000,
      system,
      tools: SDR_TOOLS,
      messages,
      output_config: { effort: cfg.effort },
      ...(FALLBACK_MODELS.has(cfg.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    result.usage.input += res.usage.input_tokens;
    result.usage.output += res.usage.output_tokens;
    result.usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;

    if (res.stop_reason === 'refusal') throw new SdrRefusal('O modelo recusou responder a esta conversa.');
    if (res.stop_reason === 'max_tokens') throw new Error('A resposta da IA foi cortada (limite de tokens).');
    // Conteúdo completo (inclusive blocos de raciocínio) volta inalterado na próxima chamada.
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason === 'tool_use' && uses.length) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const r = await runTool(use.name, use.input, input.ctx);
        result.toolCalls.push({ name: use.name, input: use.input, result: r.text, isError: r.isError });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, is_error: r.isError || undefined });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n');
    result.replies = splitReply(text);
    return result;
  }
  throw new Error('A IA não concluiu a resposta (muitas chamadas de ferramenta seguidas).');
}

export type RunOutcome = { status: 'ok' | 'skipped' | 'error'; reason?: string; replies?: string[] };

async function recordRun(conversationId: string, trigger: string, outcome: RunOutcome, r?: ThinkResult): Promise<RunOutcome> {
  await prisma.sdrRun.create({
    data: {
      conversationId,
      trigger,
      status: outcome.status,
      reply: outcome.replies?.join('\n\n') ?? null,
      toolCalls: r?.toolCalls.length ? (r.toolCalls as object) : undefined,
      inputTokens: r?.usage.input ?? 0,
      outputTokens: r?.usage.output ?? 0,
      cacheReadTokens: r?.usage.cacheRead ?? 0,
      error: outcome.status === 'ok' ? null : (outcome.reason ?? null),
    },
  });
  return outcome;
}

const skip = (reason: string): RunOutcome => ({ status: 'skipped', reason });

/** Grava e envia um balão da IA (com "digitando…", como uma pessoa). */
async function sendReply(sessions: SocketProvider, conv: Conversation, text: string, opts: { sleep?: (ms: number) => Promise<void> }): Promise<boolean> {
  const now = new Date();
  const message = await prisma.message.create({
    data: { conversationId: conv.id, numberId: conv.numberId, waMessageId: `pending:${randomUUID()}`, fromMe: true, source: MessageSource.AI, type: MessageType.TEXT, status: MessageStatus.PENDING, text, timestamp: now },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: now, lastMessagePreview: text.replace(/\s+/g, ' ').slice(0, 200), lastMessageFromMe: true } });
  await publishEvent({ type: 'message.new', numberId: conv.numberId, payload: { conversationId: conv.id, messageId: message.id } });
  return sendPendingMessage(sessions, message.id, { simulateTyping: true, sleep: opts.sleep });
}

/** Execução real a partir da fila: confere se ainda faz sentido, pensa, envia e atualiza a ficha. */
export async function runSdrJob(sessions: SocketProvider, job: SdrJob, opts: { now?: Date; sleep?: (ms: number) => Promise<void> } = {}): Promise<RunOutcome> {
  const now = opts.now ?? new Date();
  const cfg = await getSetting('sdr');
  const trigger = job.kind;
  const conv = await prisma.conversation.findUnique({ where: { id: job.conversationId }, include: { contact: true, sdrLead: true } });
  if (!conv) return skip('conversa não existe');
  if (!cfg.enabled) return recordRun(conv.id, trigger, skip('IA do SDR desligada'));
  if (!hasApiKey()) return recordRun(conv.id, trigger, skip('sem chave da API da Anthropic'));
  if (conv.aiStatus !== AiStatus.ACTIVE) return skip('IA não está ativa nesta conversa');
  if (conv.automationPausedAt) return skip('um humano assumiu a conversa');
  if (conv.contact?.optedOutAt) return skip('contato descadastrado');

  const last = await prisma.message.findFirst({ where: { conversationId: conv.id, type: { not: MessageType.REACTION } }, orderBy: { timestamp: 'desc' } });
  if (job.kind === 'reply') {
    // Junta mensagens seguidas: só o job da mensagem mais recente responde.
    if (!last || last.fromMe) return skip('última mensagem já é nossa');
    if (last.timestamp.getTime() > job.triggerAt) return skip('há mensagem mais nova do lead');
  }
  if (job.kind === 'followup' && last && !last.fromMe) return skip('o lead respondeu');

  const sock = sessions.getSocket(conv.numberId);
  if (!sock?.user) throw new Error('Número desconectado: a resposta da IA será tentada de novo');

  const lead = conv.sdrLead ?? (await prisma.sdrLead.create({ data: { conversationId: conv.id } }));
  const hours = await getSetting('businessHours');
  const history = (await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { timestamp: 'desc' }, take: HISTORY })).reverse();

  let sdrTrigger: SdrTrigger;
  if (job.kind === 'reply') sdrTrigger = { kind: 'reply' };
  else if (job.kind === 'reminder') sdrTrigger = { kind: 'reminder', when: job.when };
  else {
    const days = last ? Math.max(1, Math.round((now.getTime() - last.timestamp.getTime()) / DAY)) : 1;
    sdrTrigger = { kind: 'followup', number: Math.min(lead.followUpCount + 1, cfg.followUpDays.length), total: cfg.followUpDays.length, days };
  }

  const ctx: ToolContext = { conversation: conv, contact: conv.contact, lead, cfg, timezone: hours.timezone, now, dryRun: false, state: { returnSet: false, ended: false, handedOff: false } };
  let r: ThinkResult;
  try {
    r = await think({ cfg, timezone: hours.timezone, now, contact: conv.contact, history, trigger: sdrTrigger, ctx });
  } catch (err) {
    if (err instanceof SdrRefusal) {
      // Sem resposta segura da IA: uma pessoa assume.
      await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'PENDING', automationPausedAt: now } });
      await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: 'handoff', data: { by: 'sdr', motivo: 'A IA não respondeu a esta conversa (recusa do modelo).' } } });
      await publishEvent({ type: 'conversation.updated', numberId: conv.numberId, payload: { conversationId: conv.id } });
      return recordRun(conv.id, trigger, { status: 'error', reason: err.message });
    }
    await recordRun(conv.id, trigger, { status: 'error', reason: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  // Enquanto a IA pensava, um humano pode ter assumido ou o lead mandado mais uma mensagem.
  const fresh = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { automationPausedAt: true } });
  if (fresh?.automationPausedAt && !ctx.state.handedOff) return recordRun(conv.id, trigger, skip('um humano assumiu enquanto a IA pensava'), r);
  if (job.kind === 'reply') {
    const newer = await prisma.message.findFirst({ where: { conversationId: conv.id, fromMe: false, timestamp: { gt: last!.timestamp } }, select: { id: true } });
    if (newer) return recordRun(conv.id, trigger, skip('o lead mandou outra mensagem; a próxima execução responde tudo'), r);
  }

  for (const [i, text] of r.replies.entries()) {
    if (i > 0) await (opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(1_500 + Math.random() * 2_500);
    if (!(await sendReply(sessions, conv, text, opts))) throw new Error('Falha ao enviar a resposta da IA pelo WhatsApp');
  }

  // Próximos passos: follow-up, encerramento e lembretes.
  const data: Partial<SdrLead> = {};
  const l = ctx.lead;
  const finished = l.stage === LeadStage.ENCERRADO || ctx.state.ended;
  if (job.kind === 'reply' && !ctx.state.returnSet) {
    data.followUpCount = 0;
    data.nextFollowUpAt = finished || l.stage === LeadStage.AGENDADO || !cfg.followUpDays[0] ? null : new Date(now.getTime() + cfg.followUpDays[0] * DAY);
  } else if (job.kind === 'followup' && !ctx.state.returnSet) {
    const count = l.followUpCount + 1;
    data.followUpCount = count;
    if (count >= cfg.followUpDays.length) {
      data.nextFollowUpAt = null;
      data.stage = LeadStage.ENCERRADO;
      data.temperature = l.temperature ?? LeadTemperature.FRIO;
      data.motivo = l.motivo ?? 'Sem resposta depois dos follow-ups';
      ctx.state.ended = true;
    } else {
      data.nextFollowUpAt = new Date(now.getTime() + (cfg.followUpDays[count]! - cfg.followUpDays[count - 1]!) * DAY);
    }
  } else if (job.kind === 'reminder') {
    if (job.when === 'vespera') data.remindedDayBefore = true;
    else data.remindedSameDay = data.remindedDayBefore = true;
  }
  if (Object.keys(data).length) await prisma.sdrLead.update({ where: { id: lead.id }, data: data as never });
  if (ctx.state.ended) await prisma.conversation.update({ where: { id: conv.id }, data: { aiStatus: AiStatus.DONE } });

  await publishEvent({ type: 'sdr.updated', payload: { conversationId: conv.id } });
  await publishEvent({ type: 'conversation.updated', numberId: conv.numberId, payload: { conversationId: conv.id } });
  logger.info({ conversationId: conv.id, trigger, replies: r.replies.length, tools: r.toolCalls.map((t) => t.name) }, 'IA do SDR respondeu');
  return recordRun(conv.id, trigger, { status: 'ok', replies: r.replies }, r);
}
