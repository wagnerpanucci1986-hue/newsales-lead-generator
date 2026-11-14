// Envio pelo painel com um socket falso: confere a troca do id provisório,
// o eco pelo espelhamento e o tratamento de falhas.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AnyMessageContent, WAMessage, WAMessageKey } from 'baileys';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { Mirror } from '../src/whatsapp/mirror.js';
import { sendPendingMessage, sendReadReceipts, type SendSocket } from '../src/whatsapp/sender.js';

const JID = '5511977776666@s.whatsapp.net';
let seq = 0;

async function setup() {
  const number = await prisma.waNumber.create({ data: { nickname: `teste-envio-${Date.now()}-${seq++}` } });
  const conv = await prisma.conversation.create({ data: { numberId: number.id, remoteJid: JID } });
  const pending = (text: string) =>
    prisma.message.create({
      data: { conversationId: conv.id, numberId: number.id, waMessageId: `pending:${seq++}`, fromMe: true, source: 'PANEL', type: 'TEXT', status: 'PENDING', text, timestamp: new Date() },
    });
  return { numberId: number.id, convId: conv.id, pending };
}

function fakeSocket(opts: { fail?: boolean } = {}) {
  const sent: { jid: string; content: AnyMessageContent; id?: string }[] = [];
  const read: WAMessageKey[] = [];
  const sock: SendSocket = {
    user: { id: '5511900000000:1@s.whatsapp.net' },
    async sendMessage(jid, content, options) {
      if (opts.fail) throw new Error('Connection Closed');
      sent.push({ jid, content, id: options?.messageId });
      return { key: { id: options?.messageId, remoteJid: jid, fromMe: true }, message: { conversation: (content as { text: string }).text } } as WAMessage;
    },
    async readMessages(keys) {
      read.push(...keys);
    },
  };
  return { sock, sent, read };
}

after(async () => {
  await prisma.waNumber.deleteMany({ where: { nickname: { startsWith: 'teste-envio-' } } });
  await prisma.$disconnect();
  redis.disconnect();
});

test('envio troca o id provisório, marca SENT e o eco não duplica', async () => {
  const { numberId, pending } = await setup();
  const msg = await pending('Olá! Segue a proposta.');
  const { sock, sent } = fakeSocket();
  await sendPendingMessage({ getSocket: () => sock }, msg.id);

  const saved = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
  assert.equal(saved.status, 'SENT');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.jid, JID);
  assert.equal(saved.waMessageId, sent[0]!.id);
  assert.ok(!saved.waMessageId.startsWith('pending:'));
  assert.ok(saved.raw, 'conteúdo enviado deve ficar guardado para reenvio');

  // O WhatsApp devolve a própria mensagem pelo espelhamento.
  const mirror = new Mirror({ numberId, resolvePn: async () => null, groupSubject: async () => null, enqueueMedia: async () => undefined });
  await mirror.onUpsert([{ key: { id: saved.waMessageId, remoteJid: JID, fromMe: true }, message: { conversation: saved.text }, messageTimestamp: Date.now() / 1000, status: 3 }]);
  const all = await prisma.message.findMany({ where: { numberId } });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.source, 'PANEL');
  assert.equal(all[0]!.status, 'DELIVERED');

  // Reprocessar o mesmo job não reenvia.
  await sendPendingMessage({ getSocket: () => sock }, msg.id);
  assert.equal(sent.length, 1);
});

test('número desconectado ou erro no envio marcam a mensagem como falha', async () => {
  const { pending } = await setup();
  const a = await pending('sem conexão');
  await sendPendingMessage({ getSocket: () => undefined }, a.id);
  const savedA = await prisma.message.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(savedA.status, 'FAILED');
  assert.equal(savedA.error, 'Número desconectado');

  const b = await pending('erro');
  await sendPendingMessage({ getSocket: () => fakeSocket({ fail: true }).sock }, b.id);
  const savedB = await prisma.message.findUniqueOrThrow({ where: { id: b.id } });
  assert.equal(savedB.status, 'FAILED');
  assert.equal(savedB.error, 'Connection Closed');
});

test('mensagens do mesmo número saem em ordem', async () => {
  const { pending } = await setup();
  const msgs = [await pending('1'), await pending('2'), await pending('3')];
  const { sock, sent } = fakeSocket();
  await Promise.all(msgs.map((m) => sendPendingMessage({ getSocket: () => sock }, m.id)));
  assert.deepEqual(sent.map((s) => (s.content as { text: string }).text), ['1', '2', '3']);
});

test('recibos de leitura são enviados uma única vez', async () => {
  const { numberId, convId } = await setup();
  await prisma.message.create({
    data: { conversationId: convId, numberId, waMessageId: 'IN1', fromMe: false, source: 'INBOUND', type: 'TEXT', status: 'RECEIVED', text: 'oi', timestamp: new Date() },
  });
  const { sock, read } = fakeSocket();
  await sendReadReceipts({ getSocket: () => sock }, convId);
  await sendReadReceipts({ getSocket: () => sock }, convId);
  assert.equal(read.length, 1);
  assert.equal(read[0]!.id, 'IN1');
});
