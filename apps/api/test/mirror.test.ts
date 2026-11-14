// Testes de integração do espelhamento: eventos sintéticos do Baileys contra um
// Postgres real (DATABASE_URL). Não precisam de conexão com o WhatsApp.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { proto, type WAMessage } from 'baileys';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { clearAuthState, usePostgresAuthState } from '../src/whatsapp/auth-state.js';
import { Mirror } from '../src/whatsapp/mirror.js';

const PN = '5511988887777@s.whatsapp.net';
const LID = '123456789012345@lid';
let seq = 0;
const now = () => Math.floor(Date.now() / 1000);

async function setup(opts: { pnForLid?: string | null } = {}) {
  const number = await prisma.waNumber.create({ data: { nickname: `teste-${Date.now()}-${seq++}` } });
  const queued: string[] = [];
  const mirror = new Mirror({
    numberId: number.id,
    resolvePn: async () => opts.pnForLid ?? null,
    groupSubject: async () => 'Grupo de teste',
    enqueueMedia: async (id) => void queued.push(id),
  });
  return { numberId: number.id, mirror, queued };
}

const text = (id: string, body: string, over: Partial<WAMessage['key']> = {}, extra: Partial<WAMessage> = {}): WAMessage => ({
  key: { id, remoteJid: PN, fromMe: false, ...over },
  message: { conversation: body },
  messageTimestamp: now(),
  pushName: 'Maria',
  ...extra,
});

const created: string[] = [];
before(async () => {
  await prisma.contact.deleteMany({ where: { phone: { startsWith: '55119888877' } } });
});
after(async () => {
  await prisma.waNumber.deleteMany({ where: { nickname: { startsWith: 'teste-' } } });
  await prisma.contact.deleteMany({ where: { phone: { startsWith: '55119888877' } } });
  await prisma.$disconnect();
  redis.disconnect();
});

test('mensagem recebida cria contato, conversa e mensagem', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('A1', 'Olá, quero um orçamento')]);

  const conv = await prisma.conversation.findFirstOrThrow({ where: { numberId }, include: { contact: true, messages: true } });
  assert.equal(conv.remoteJid, PN);
  assert.equal(conv.unreadCount, 1);
  assert.equal(conv.title, 'Maria');
  assert.equal(conv.lastMessagePreview, 'Olá, quero um orçamento');
  assert.equal(conv.contact?.phone, '5511988887777');
  assert.equal(conv.messages.length, 1);
  assert.equal(conv.messages[0]!.source, 'INBOUND');
  assert.equal(conv.messages[0]!.status, 'RECEIVED');

  const stat = await prisma.numberDailyStat.findFirstOrThrow({ where: { numberId } });
  assert.equal(stat.received, 1);
});

test('reentrega do mesmo evento não duplica nem conta duas vezes', async () => {
  const { numberId, mirror } = await setup();
  const msg = text('B1', 'oi');
  await mirror.onUpsert([msg]);
  await mirror.onUpsert([msg]);
  assert.equal(await prisma.message.count({ where: { numberId } }), 1);
  assert.equal((await prisma.conversation.findFirstOrThrow({ where: { numberId } })).unreadCount, 1);
});

test('mensagem enviada pelo celular é espelhada como PHONE e zera não lidas', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('C1', 'tem estoque?')]);
  await mirror.onUpsert([text('C2', 'Temos sim!', { fromMe: true }, { pushName: undefined, status: proto.WebMessageInfo.Status.SERVER_ACK })]);

  const sent = await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'C2' } });
  assert.equal(sent.source, 'PHONE');
  assert.equal(sent.status, 'SENT');
  const conv = await prisma.conversation.findFirstOrThrow({ where: { numberId } });
  assert.equal(conv.unreadCount, 0);
  assert.equal(conv.lastMessageFromMe, true);
  assert.ok(conv.automationPausedAt, 'automação deve pausar quando um humano responde');
});

test('recibos avançam o status e nunca regridem', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('D1', 'enviada', { fromMe: true })]);
  const key = { id: 'D1', remoteJid: PN, fromMe: true };
  await mirror.onMessagesUpdate([{ key, update: { status: proto.WebMessageInfo.Status.READ } }]);
  await mirror.onMessagesUpdate([{ key, update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK } }]);

  const msg = await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'D1' } });
  assert.equal(msg.status, 'READ');
  assert.ok(msg.readAt && msg.deliveredAt);
  const stat = await prisma.numberDailyStat.findFirstOrThrow({ where: { numberId } });
  assert.equal(stat.read, 1);
  assert.equal(stat.delivered, 1);
});

test('conversa por LID é unificada quando o telefone é revelado', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('E1', 'via lid', { remoteJid: LID })]);
  let convs = await prisma.conversation.findMany({ where: { numberId } });
  assert.equal(convs.length, 1);
  assert.equal(convs[0]!.remoteJid, LID);
  assert.equal(convs[0]!.contactId, null);

  // Depois chega uma mensagem com os dois identificadores.
  await mirror.onUpsert([text('E2', 'via telefone', { remoteJid: LID, remoteJidAlt: PN })]);
  convs = await prisma.conversation.findMany({ where: { numberId }, include: { messages: true } });
  assert.equal(convs.length, 1);
  assert.equal(convs[0]!.remoteJid, PN);
  assert.equal(convs[0]!.altJid, LID);
  assert.ok(convs[0]!.contactId);
  assert.equal((convs[0] as { messages: unknown[] }).messages.length, 2);
});

test('conversas separadas por LID e por telefone são fundidas pelo mapeamento', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('F1', 'pelo lid', { remoteJid: LID })]);
  await mirror.onUpsert([text('F2', 'pelo telefone', { remoteJid: PN })]);
  assert.equal(await prisma.conversation.count({ where: { numberId } }), 2);

  // Agora o Baileys conhece o par e avisa.
  const linked = new Mirror({ numberId, resolvePn: async () => PN, groupSubject: async () => null, enqueueMedia: async () => undefined });
  await linked.onLidMapping({ pn: PN, lid: LID });
  const convs = await prisma.conversation.findMany({ where: { numberId }, include: { _count: { select: { messages: true } } } });
  assert.equal(convs.length, 1);
  assert.equal(convs[0]!.remoteJid, PN);
  assert.equal(convs[0]!._count.messages, 2);
  assert.equal(convs[0]!.unreadCount, 2);
});

test('imagem gera mídia pendente e entra na fila de download', async () => {
  const { numberId, mirror, queued } = await setup();
  await mirror.onUpsert([
    {
      key: { id: 'G1', remoteJid: PN, fromMe: false },
      messageTimestamp: now(),
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'comprovante', fileLength: 2048, width: 800, height: 600, mediaKey: Buffer.from('k'), jpegThumbnail: Buffer.alloc(5000) } },
    },
  ]);
  const msg = await prisma.message.findFirstOrThrow({ where: { numberId }, include: { media: true } });
  assert.equal(msg.type, 'IMAGE');
  assert.equal(msg.text, 'comprovante');
  assert.equal(msg.media?.status, 'PENDING');
  assert.equal(msg.media?.size, 2048);
  assert.deepEqual(queued, [msg.media!.id]);
  assert.ok(!JSON.stringify(msg.raw).includes('jpegThumbnail'), 'miniatura não deve ser gravada');
  assert.equal((await prisma.conversation.findFirstOrThrow({ where: { numberId } })).lastMessagePreview, '📷 Imagem: comprovante');
});

test('histórico não conta como não lida e não baixa mídia antiga', async () => {
  const { numberId, mirror, queued } = await setup();
  const old = now() - 60 * 86_400;
  await mirror.onHistory({
    contacts: [],
    chats: [{ id: PN, unreadCount: 3 }],
    messages: [
      { key: { id: 'H2', remoteJid: PN, fromMe: true }, messageTimestamp: old + 10, message: { conversation: 'resposta antiga' }, status: proto.WebMessageInfo.Status.READ },
      { key: { id: 'H1', remoteJid: PN, fromMe: false }, messageTimestamp: old, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 12 } } },
    ],
  });
  const conv = await prisma.conversation.findFirstOrThrow({ where: { numberId } });
  assert.equal(conv.unreadCount, 3, 'não lidas vêm da lista de chats, não da contagem de mensagens');
  assert.equal(conv.lastMessagePreview, 'resposta antiga');
  const audio = await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'H1' }, include: { media: true } });
  assert.equal(audio.media?.status, 'FAILED');
  assert.equal(audio.media?.isPtt, true);
  assert.equal(queued.length, 0);
  assert.equal((await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'H2' } })).status, 'READ');
  assert.equal(await prisma.numberDailyStat.count({ where: { numberId } }), 0);
});

test('edição e exclusão são registradas sem perder o original', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([text('I1', 'texto com ero')]);
  await mirror.onUpsert([
    {
      key: { id: 'I2', remoteJid: PN, fromMe: false },
      messageTimestamp: now(),
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'I1' }, editedMessage: { conversation: 'texto com erro' } } },
    },
  ]);
  let msg = await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'I1' } });
  assert.equal(msg.text, 'texto com erro');
  assert.ok(msg.editedAt);

  await mirror.onUpsert([
    { key: { id: 'I3', remoteJid: PN, fromMe: false }, messageTimestamp: now(), message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'I1' } } } },
  ]);
  msg = await prisma.message.findFirstOrThrow({ where: { numberId, waMessageId: 'I1' } });
  assert.ok(msg.revokedAt);
  assert.equal(msg.text, 'texto com erro');
  assert.equal(await prisma.message.count({ where: { numberId } }), 1, 'mensagens de protocolo não viram mensagens');
});

test('grupo é espelhado com título e autor; status e canais são ignorados', async () => {
  const { numberId, mirror } = await setup();
  await mirror.onUpsert([
    text('J1', 'bom dia grupo', { remoteJid: '120363000000000001@g.us', participant: LID, participantAlt: PN }),
    text('J2', 'status', { remoteJid: 'status@broadcast' }),
    text('J3', 'canal', { remoteJid: '120363000000000002@newsletter' }),
  ]);
  const convs = await prisma.conversation.findMany({ where: { numberId }, include: { messages: true } });
  assert.equal(convs.length, 1);
  assert.equal(convs[0]!.isGroup, true);
  assert.equal(convs[0]!.title, 'Grupo de teste');
  assert.equal(convs[0]!.contactId, null);
  assert.equal(convs[0]!.messages[0]!.participantJid, PN);
});

test('credenciais da sessão ficam cifradas e sobrevivem a recarga', async () => {
  const { numberId } = await setup();
  const first = await usePostgresAuthState(numberId);
  await first.saveCreds();
  await first.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') }, '2': { public: Buffer.from('a'), private: Buffer.from('b') } } });
  await first.state.keys.set({ 'pre-key': { '2': null } });

  const rows = await prisma.waAuthKey.findMany({ where: { numberId } });
  assert.equal(rows.length, 2);
  for (const r of rows) assert.ok(!r.valueEnc.includes('noiseKey') && !r.valueEnc.includes('private'), 'valor não pode estar em texto claro');

  const second = await usePostgresAuthState(numberId);
  assert.deepEqual(second.state.creds.noiseKey.public, first.state.creds.noiseKey.public);
  const keys = await second.state.keys.get('pre-key', ['1', '2']);
  assert.deepEqual(Buffer.from(keys['1']!.private), Buffer.from('priv'));
  assert.equal(keys['2'], undefined);

  await clearAuthState(numberId);
  assert.equal(await prisma.waAuthKey.count({ where: { numberId } }), 0);
});
