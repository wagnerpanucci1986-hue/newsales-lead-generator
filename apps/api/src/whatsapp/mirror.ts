import { MediaStatus, MessageSource, MessageStatus, MessageType, WaCheckStatus, type Prisma } from '@prisma/client';
import { proto, toNumber, type Chat, type ChatUpdate, type Contact as WaContact, type MessageUserReceiptUpdate, type WAMessage, type WAMessageUpdate } from 'baileys';
import { env } from '../config/env.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { isUniqueViolation, prisma } from '../lib/prisma.js';
import { bumpDailyStat, type StatField } from '../lib/stats.js';
import { brPhoneVariants, isJidGroup, isLidUser, isMirroredJid, isPnUser, normalizeJid, phoneFromJid } from './jid.js';
import { mapWaStatus, parseMessage, previewOf, statusesBelow } from './parse.js';

/** O que o espelhamento precisa do socket. Injetado para poder testar sem WhatsApp. */
export interface MirrorDeps {
  numberId: string;
  /** Telefone (JID) correspondente a um LID, se o Baileys já conhece o par. */
  resolvePn(lid: string): Promise<string | null>;
  /** Nome do grupo (consulta ao WhatsApp). */
  groupSubject(jid: string): Promise<string | null>;
  enqueueMedia(mediaId: string): Promise<void>;
  /** Origem de uma mensagem enviada pelo próprio sistema (painel, campanha, automação). */
  ownSource?(waMessageId: string): MessageSource | undefined;
}


const MAX_CACHE = 5000;

/**
 * Espelhamento: transforma os eventos do Baileys em Conversation/Message.
 * Tudo aqui é idempotente — o WhatsApp reentrega eventos após reconexão e o
 * histórico se sobrepõe às mensagens em tempo real.
 */
export class Mirror {
  private readonly log;
  /** jid (telefone ou LID) → id da conversa */
  private readonly convCache = new Map<string, string>();
  /** nomes da agenda do aparelho, só em memória (não viram contatos de marketing) */
  private readonly names = new Map<string, string>();
  /** conversa → último nome de perfil já gravado */
  private readonly pushNames = new Map<string, string>();

  constructor(private readonly deps: MirrorDeps) {
    this.log = logger.child({ numberId: deps.numberId, mod: 'mirror' });
  }

  private get numberId() {
    return this.deps.numberId;
  }

  // ───────────── eventos de entrada ─────────────

  /** messages.upsert: mensagens novas, recebidas ou enviadas por qualquer aparelho da conta. */
  async onUpsert(messages: WAMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.saveMessage(msg, false).catch((err) => this.log.error({ err, waId: msg.key?.id }, 'falha ao espelhar mensagem'));
    }
  }

  /** messaging-history.set: histórico entregue pelo celular após o pareamento. */
  async onHistory(data: { chats: Chat[]; contacts: WaContact[]; messages: WAMessage[] }): Promise<void> {
    this.onContacts(data.contacts);

    const messages = [...data.messages].sort((a, b) => toNumber(a.messageTimestamp) - toNumber(b.messageTimestamp));
    let saved = 0;
    for (let i = 0; i < messages.length; i += 500) {
      const chunk = messages.slice(i, i + 500);
      const ids = chunk.map((m) => m.key?.id).filter((id): id is string => Boolean(id));
      const existing = new Set(
        (await prisma.message.findMany({ where: { numberId: this.numberId, waMessageId: { in: ids } }, select: { waMessageId: true } })).map(
          (m) => m.waMessageId,
        ),
      );
      for (const msg of chunk) {
        if (!msg.key?.id || existing.has(msg.key.id)) continue;
        await this.saveMessage(msg, true)
          .then(() => saved++)
          .catch((err) => this.log.error({ err, waId: msg.key?.id }, 'falha ao espelhar mensagem do histórico'));
      }
    }

    // Nome dos grupos e contagem de não lidas vêm na lista de chats.
    for (const chat of data.chats) {
      const jid = normalizeJid(chat.id);
      if (!jid || !isMirroredJid(jid)) continue;
      const data: Prisma.ConversationUpdateManyMutationInput = {};
      if (isJidGroup(jid) && chat.name) data.title = chat.name;
      if (typeof chat.unreadCount === 'number' && chat.unreadCount >= 0) data.unreadCount = chat.unreadCount;
      if (Object.keys(data).length) {
        await prisma.conversation.updateMany({ where: { numberId: this.numberId, OR: [{ remoteJid: jid }, { altJid: jid }] }, data });
      }
    }
    this.log.info({ received: data.messages.length, saved, chats: data.chats.length }, 'histórico processado');
  }

  /** messages.update: tiques (enviada/entregue/lida), edição e exclusão. */
  async onMessagesUpdate(updates: WAMessageUpdate[]): Promise<void> {
    for (const { key, update } of updates) {
      if (!key.id) continue;
      try {
        if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          await this.markRevoked(key.id);
          continue;
        }
        const edited = update.message?.editedMessage?.message;
        if (edited) {
          const parsed = parseMessage({ key, message: edited });
          if (parsed.kind === 'message') await this.markEdited(key.id, parsed.text);
          else if (parsed.kind === 'edit') await this.markEdited(parsed.targetId, parsed.text);
        }
        if (key.fromMe && update.status !== null && update.status !== undefined) {
          const status = mapWaStatus(update.status);
          if (status) await this.advanceStatus(key.id, status);
        }
      } catch (err) {
        this.log.error({ err, waId: key.id }, 'falha ao aplicar atualização de mensagem');
      }
    }
  }

  /** message-receipt.update: recibos por participante (grupos). */
  async onReceipts(updates: MessageUserReceiptUpdate[]): Promise<void> {
    for (const { key, receipt } of updates) {
      if (!key.id || !key.fromMe) continue;
      const status = receipt.playedTimestamp
        ? MessageStatus.PLAYED
        : receipt.readTimestamp
          ? MessageStatus.READ
          : receipt.receiptTimestamp
            ? MessageStatus.DELIVERED
            : null;
      if (status) await this.advanceStatus(key.id, status).catch((err) => this.log.error({ err, waId: key.id }, 'falha ao aplicar recibo'));
    }
  }

  /** chats.update: quando a conversa é lida no celular, zera as não lidas no painel. */
  async onChatsUpdate(updates: ChatUpdate[]): Promise<void> {
    for (const chat of updates) {
      const jid = normalizeJid(chat.id);
      if (!jid || chat.unreadCount !== 0) continue;
      const convs = await prisma.conversation.findMany({
        where: { numberId: this.numberId, unreadCount: { gt: 0 }, OR: [{ remoteJid: jid }, { altJid: jid }] },
        select: { id: true },
      });
      for (const c of convs) {
        await prisma.conversation.update({ where: { id: c.id }, data: { unreadCount: 0 } });
        await publishEvent({ type: 'conversation.updated', numberId: this.numberId, payload: { conversationId: c.id } });
      }
    }
  }

  /** contacts.upsert / contacts.update: guarda nomes da agenda para titular conversas novas. */
  onContacts(contacts: Partial<WaContact>[]): void {
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (!name) continue;
      for (const id of [c.id, c.lid, c.phoneNumber]) {
        const jid = normalizeJid(id);
        if (!jid) continue;
        if (this.names.size >= MAX_CACHE) this.names.clear();
        this.names.set(jid, name);
      }
    }
  }

  async onGroupsUpdate(groups: { id?: string; subject?: string }[]): Promise<void> {
    for (const g of groups) {
      if (!g.id || !g.subject) continue;
      await prisma.conversation.updateMany({ where: { numberId: this.numberId, remoteJid: g.id }, data: { title: g.subject } });
    }
  }

  /** lid-mapping.update: o WhatsApp revelou o telefone de um LID — unifica a conversa. */
  async onLidMapping(mapping: { pn: string; lid: string }): Promise<void> {
    const lid = normalizeJid(mapping.lid);
    const pn = normalizeJid(mapping.pn);
    if (!lid || !pn) return;
    const pending = await prisma.conversation.findFirst({ where: { numberId: this.numberId, remoteJid: lid }, select: { id: true } });
    if (!pending) return;
    this.convCache.clear();
    const conv = await this.resolveConversation(lid, pn, undefined);
    await publishEvent({ type: 'conversation.updated', numberId: this.numberId, payload: { conversationId: conv } });
  }

  // ───────────── gravação ─────────────

  private async saveMessage(msg: WAMessage, history: boolean): Promise<void> {
    const key = msg.key;
    const jid = normalizeJid(key?.remoteJid);
    if (!jid || !key.id || !isMirroredJid(jid)) return;

    const parsed = parseMessage(msg);
    if (parsed.kind === 'skip') return;
    if (parsed.kind === 'revoke') return this.markRevoked(parsed.targetId);
    if (parsed.kind === 'edit') return this.markEdited(parsed.targetId, parsed.text);

    const fromMe = Boolean(key.fromMe);
    const group = Boolean(isJidGroup(jid));
    const seconds = toNumber(msg.messageTimestamp);
    const timestamp = seconds > 0 ? new Date(seconds * 1000) : new Date();

    const conversationId = await this.resolveConversation(jid, normalizeJid(key.remoteJidAlt), fromMe || group ? undefined : (msg.pushName ?? undefined));

    if (!fromMe && !group && msg.pushName) await this.rememberPushName(conversationId, msg.pushName);

    const source = fromMe ? (this.deps.ownSource?.(key.id) ?? MessageSource.PHONE) : MessageSource.INBOUND;
    const waStatus = mapWaStatus(msg.status);
    const status = fromMe ? (!waStatus || waStatus === MessageStatus.PENDING ? MessageStatus.SENT : waStatus) : MessageStatus.RECEIVED;

    // Política de mídia: histórico antigo e arquivos acima do limite não são baixados.
    let mediaCreate: Prisma.MediaCreateWithoutMessageInput | undefined;
    if (parsed.media) {
      const tooOld = history && timestamp.getTime() < Date.now() - env.HISTORY_MEDIA_DAYS * 86_400_000;
      const tooBig = (parsed.media.size ?? 0) > env.MAX_MEDIA_MB * 1024 * 1024;
      mediaCreate = {
        ...parsed.media,
        status: tooOld || tooBig ? MediaStatus.FAILED : MediaStatus.PENDING,
        error: tooBig ? 'arquivo acima do limite configurado' : tooOld ? 'mídia do histórico anterior ao período de download' : null,
      };
    }

    let created;
    try {
      created = await prisma.message.create({
        data: {
          conversationId,
          numberId: this.numberId,
          waMessageId: key.id,
          fromMe,
          source,
          type: parsed.type,
          status,
          text: parsed.text,
          participantJid: group ? (normalizeJid(key.participantAlt) ?? normalizeJid(key.participant)) : null,
          pushName: fromMe ? null : (msg.pushName ?? null),
          quotedWaId: parsed.quotedWaId,
          raw: parsed.raw as Prisma.InputJsonValue,
          timestamp,
          media: mediaCreate ? { create: mediaCreate } : undefined,
        },
        include: { media: { select: { id: true, status: true } } },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Já espelhada (reentrega, ou gravada pelo envio do painel): só avança o status.
      if (fromMe && waStatus) await this.advanceStatus(key.id, status);
      return;
    }

    // Reação não é uma "mensagem nova" na lista de conversas.
    if (parsed.type !== MessageType.REACTION) {
      await prisma.conversation.updateMany({
        where: { id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: timestamp } }] },
        data: { lastMessageAt: timestamp, lastMessagePreview: previewOf(parsed.type, parsed.text), lastMessageFromMe: fromMe },
      });

      if (!history) {
        if (fromMe) {
          // Respondeu pelo celular/WhatsApp Web: conversa lida e um humano assumiu.
          if (source === MessageSource.PHONE) {
            await prisma.conversation.update({ where: { id: conversationId }, data: { unreadCount: 0, automationPausedAt: new Date() } });
          }
        } else {
          await prisma.conversation.update({ where: { id: conversationId }, data: { unreadCount: { increment: 1 }, lastInboundAt: timestamp } });
          // Cliente voltou a falar em conversa encerrada: reabre.
          await prisma.conversation.updateMany({ where: { id: conversationId, status: 'CLOSED' }, data: { status: 'OPEN', automationPausedAt: null } });
        }
        await this.bumpStat(fromMe ? 'sent' : 'received');
      }
    }

    if (created.media?.status === MediaStatus.PENDING) {
      await this.deps.enqueueMedia(created.media.id).catch((err) => this.log.error({ err, mediaId: created.media?.id }, 'falha ao enfileirar mídia'));
    }

    if (!history) {
      await publishEvent({ type: 'message.new', numberId: this.numberId, payload: { conversationId, messageId: created.id } });
    }
  }

  /** Avança o status de uma mensagem enviada. Nunca regride (recibos chegam fora de ordem). */
  private async advanceStatus(waMessageId: string, status: MessageStatus): Promise<void> {
    const from = status === MessageStatus.FAILED ? [MessageStatus.PENDING, MessageStatus.SENT] : statusesBelow(status);
    if (!from.length) return;
    const now = new Date();
    const delivered = status === MessageStatus.DELIVERED || status === MessageStatus.READ || status === MessageStatus.PLAYED;
    const read = status === MessageStatus.READ || status === MessageStatus.PLAYED;

    const before = await prisma.message.findUnique({
      where: { numberId_waMessageId: { numberId: this.numberId, waMessageId } },
      select: { id: true, conversationId: true, status: true, deliveredAt: true, readAt: true },
    });
    if (!before || !from.includes(before.status)) return;

    const { count } = await prisma.message.updateMany({
      where: { id: before.id, status: { in: from } },
      data: {
        status,
        deliveredAt: delivered && !before.deliveredAt ? now : undefined,
        readAt: read && !before.readAt ? now : undefined,
      },
    });
    if (!count) return;

    if (delivered && !before.deliveredAt) await this.bumpStat('delivered');
    if (read && !before.readAt) await this.bumpStat('read');
    if (status === MessageStatus.FAILED) await this.bumpStat('failed');
    await publishEvent({
      type: 'message.status',
      numberId: this.numberId,
      payload: { conversationId: before.conversationId, messageId: before.id, status },
    });
  }

  private async markRevoked(waMessageId: string): Promise<void> {
    await this.touchMessage(waMessageId, { revokedAt: new Date() });
  }

  private async markEdited(waMessageId: string, text: string | null): Promise<void> {
    await this.touchMessage(waMessageId, { text, editedAt: new Date() });
  }

  private async touchMessage(waMessageId: string, data: Prisma.MessageUpdateInput): Promise<void> {
    const msg = await prisma.message.findUnique({
      where: { numberId_waMessageId: { numberId: this.numberId, waMessageId } },
      select: { id: true, conversationId: true },
    });
    if (!msg) return;
    await prisma.message.update({ where: { id: msg.id }, data });
    await publishEvent({ type: 'conversation.updated', numberId: this.numberId, payload: { conversationId: msg.conversationId } });
  }

  private bumpStat(field: StatField): Promise<void> {
    return bumpDailyStat(this.numberId, field);
  }

  // ───────────── conversas e contatos ─────────────

  /**
   * Acha ou cria a conversa de um chat. O mesmo contato pode aparecer como
   * telefone (…@s.whatsapp.net) ou como LID (…@lid); a conversa é sempre uma só,
   * com o telefone como identificador principal assim que ele for conhecido.
   */
  private async resolveConversation(jid: string, alt: string | null, pushName: string | undefined): Promise<string> {
    const cached = this.convCache.get(jid);
    if (cached) return cached;

    const group = Boolean(isJidGroup(jid));
    let pn: string | null = null;
    let lid: string | null = null;
    if (!group) {
      pn = isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : null;
      lid = isLidUser(jid) ? jid : alt && isLidUser(alt) ? alt : null;
      if (!pn && lid) pn = normalizeJid(await this.deps.resolvePn(lid).catch(() => null));
    }
    const canonical = group ? jid : (pn ?? lid ?? jid);
    const altJid = pn && lid ? lid : null;
    const jids = [...new Set([canonical, altJid, jid].filter((j): j is string => Boolean(j)))];

    const found = await prisma.conversation.findMany({
      where: { numberId: this.numberId, OR: [{ remoteJid: { in: jids } }, { altJid: { in: jids } }] },
      orderBy: { createdAt: 'asc' },
    });

    let conv = found.find((c) => c.remoteJid === canonical) ?? found[0];

    if (conv) {
      // Havia duas conversas para o mesmo contato (uma por LID, outra por telefone): funde.
      for (const dup of found) {
        if (dup.id === conv.id) continue;
        await prisma.$transaction([
          prisma.message.updateMany({ where: { conversationId: dup.id }, data: { conversationId: conv.id } }),
          prisma.conversationEvent.updateMany({ where: { conversationId: dup.id }, data: { conversationId: conv.id } }),
          prisma.conversation.delete({ where: { id: dup.id } }),
          prisma.conversation.update({
            where: { id: conv.id },
            data: {
              unreadCount: { increment: dup.unreadCount },
              ...(dup.lastMessageAt && (!conv.lastMessageAt || dup.lastMessageAt > conv.lastMessageAt)
                ? { lastMessageAt: dup.lastMessageAt, lastMessagePreview: dup.lastMessagePreview, lastMessageFromMe: dup.lastMessageFromMe }
                : {}),
            },
          }),
        ]);
        this.convCache.clear();
        this.log.info({ kept: conv.id, merged: dup.id }, 'conversas LID/telefone unificadas');
      }

      const patch: Prisma.ConversationUncheckedUpdateInput = {};
      if (conv.remoteJid !== canonical) patch.remoteJid = canonical; // LID → telefone
      if (altJid && conv.altJid !== altJid) patch.altJid = altJid;
      if (!group && pn && !conv.contactId) patch.contactId = await this.findOrCreateContact(pn, pushName);
      if (!group && pushName && !conv.title) patch.title = pushName;
      if (Object.keys(patch).length) conv = await prisma.conversation.update({ where: { id: conv.id }, data: patch });
      else if (!group && pn && pushName && conv.contactId) await this.touchPushName(conv.contactId, pushName);
    } else {
      const contactId = !group && pn ? await this.findOrCreateContact(pn, pushName) : null;
      const title = group
        ? await this.deps.groupSubject(jid).catch(() => null)
        : (pushName ?? this.names.get(canonical) ?? (altJid ? this.names.get(altJid) : undefined) ?? null);
      try {
        conv = await prisma.conversation.create({
          data: { numberId: this.numberId, remoteJid: canonical, altJid, isGroup: group, contactId, title },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        conv = await prisma.conversation.findUniqueOrThrow({ where: { numberId_remoteJid: { numberId: this.numberId, remoteJid: canonical } } });
      }
    }

    if (this.convCache.size >= MAX_CACHE) this.convCache.clear();
    // Sem telefone ainda, não fixa no cache: a próxima mensagem tenta resolver o LID de novo.
    if (group || pn) for (const j of jids) this.convCache.set(j, conv.id);
    return conv.id;
  }

  private async findOrCreateContact(pnJid: string, pushName: string | undefined): Promise<string | null> {
    const phone = phoneFromJid(pnJid);
    if (!phone) return null;
    const where = { OR: [{ waJid: pnJid }, { phone: { in: brPhoneVariants(phone) } }] };
    const existing = await prisma.contact.findFirst({ where, select: { id: true, waJid: true, pushName: true } });
    if (existing) {
      if (!existing.waJid || (pushName && existing.pushName !== pushName)) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: { waJid: existing.waJid ?? pnJid, waStatus: WaCheckStatus.VALID, waCheckedAt: new Date(), pushName: pushName ?? undefined },
        });
      }
      return existing.id;
    }
    try {
      const created = await prisma.contact.create({
        data: { phone, waJid: pnJid, pushName, waStatus: WaCheckStatus.VALID, waCheckedAt: new Date() },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await prisma.contact.findFirst({ where, select: { id: true } }))?.id ?? null;
    }
  }

  private async touchPushName(contactId: string, pushName: string): Promise<void> {
    await prisma.contact.updateMany({ where: { id: contactId, OR: [{ pushName: null }, { pushName: { not: pushName } }] }, data: { pushName } });
  }

  /** Nome de perfil visto numa mensagem recebida: titula a conversa e atualiza o contato (uma vez por mudança). */
  private async rememberPushName(conversationId: string, pushName: string): Promise<void> {
    if (this.pushNames.get(conversationId) === pushName) return;
    if (this.pushNames.size >= MAX_CACHE) this.pushNames.clear();
    this.pushNames.set(conversationId, pushName);
    await prisma.conversation.updateMany({ where: { id: conversationId, title: null }, data: { title: pushName } });
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } });
    if (conv?.contactId) await this.touchPushName(conv.contactId, pushName);
  }
}
