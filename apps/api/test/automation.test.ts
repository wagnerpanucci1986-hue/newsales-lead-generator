// Respostas automáticas e segundo fator de autenticação.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { matchesKeyword, processInbound, runAutomations } from '../src/automation/engine.js';
import { prisma } from '../src/lib/prisma.js';
import { closeQueues } from '../src/lib/queues.js';
import { redis } from '../src/lib/redis.js';
import { clearSettingsCache, setSetting } from '../src/lib/settings.js';
import { base32Encode, generateRecoveryCodes, generateSecret, totpAt, verifyTotp } from '../src/lib/totp.js';

const PREFIX = 'ta-';
let seq = 0;
const uniq = () => `${PREFIX}${Date.now()}-${seq++}`;

async function setup() {
  const number = await prisma.waNumber.create({ data: { nickname: uniq(), status: 'CONNECTED' } });
  const contact = await prisma.contact.create({ data: { phone: `5511955${String(Date.now() % 100000).padStart(5, '0')}${seq++ % 10}`.slice(0, 13), name: 'Paula Reis' } });
  const conv = await prisma.conversation.create({ data: { numberId: number.id, remoteJid: `${contact.phone}@s.whatsapp.net`, contactId: contact.id } });
  const ctx = (text: string, at = new Date()) => ({ numberId: number.id, conversationId: conv.id, text, timestamp: at });
  const replies = () => prisma.message.findMany({ where: { conversationId: conv.id, source: 'AUTOMATION' }, orderBy: { createdAt: 'asc' } });
  return { number, contact, conv, ctx, replies };
}

const rule = (numberId: string | null, over: object = {}) =>
  prisma.automationRule.create({ data: { name: uniq(), trigger: 'KEYWORD', matchType: 'CONTAINS', keywords: ['preço', 'valor'], responseText: 'Oi {{primeiro_nome}}! Nossos planos começam em R$ 99.', numberId, cooldownMinutes: 60, ...over } });

after(async () => {
  await prisma.automationRule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.waNumber.deleteMany({ where: { nickname: { startsWith: PREFIX } } });
  await prisma.blacklistEntry.deleteMany({ where: { phone: { startsWith: '5511955' } } });
  await prisma.contact.deleteMany({ where: { phone: { startsWith: '5511955' } } });
  await prisma.setting.deleteMany({ where: { key: 'businessHours' } });
  await closeQueues();
  await prisma.$disconnect();
  redis.disconnect();
});

test('TOTP segue a RFC 6238 e tolera ±30 s', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.equal(totpAt(secret, 1111111109_000), '081804');
  const now = 1_700_000_000_000;
  assert.equal(verifyTotp(secret, totpAt(secret, now), now), true);
  assert.equal(verifyTotp(secret, totpAt(secret, now - 30_000), now), true, 'código anterior ainda vale');
  assert.equal(verifyTotp(secret, totpAt(secret, now - 90_000), now), false, 'código velho não vale');
  assert.equal(verifyTotp(secret, '000000', now), totpAt(secret, now) === '000000');
  assert.equal(verifyTotp(secret, '12345', now), false);
  assert.match(generateSecret(), /^[A-Z2-7]{32}$/);
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
});

test('palavra-chave casa por palavra inteira, sem acento nem caixa', () => {
  const contains = { matchType: 'CONTAINS' as const, keywords: ['preço', 'oi'] };
  assert.equal(matchesKeyword(contains, 'Qual o PRECO do plano?'), true);
  assert.equal(matchesKeyword(contains, 'oi, tudo bem?'), true);
  assert.equal(matchesKeyword(contains, 'que coisa boa'), false, '"oi" não casa dentro de "coisa"');
  assert.equal(matchesKeyword({ matchType: 'EXACT', keywords: ['menu'] }, ' Menu! '), true);
  assert.equal(matchesKeyword({ matchType: 'EXACT', keywords: ['menu'] }, 'menu por favor'), false);
  assert.equal(matchesKeyword({ matchType: 'STARTS_WITH', keywords: ['quero comprar'] }, 'Quero comprar o plano Pro'), true);
  assert.equal(matchesKeyword({ matchType: 'STARTS_WITH', keywords: ['quero'] }, 'não quero'), false);
});

test('resposta por palavra-chave, com variável e intervalo mínimo', async () => {
  const { number, ctx, replies } = await setup();
  await rule(number.id);
  assert.equal(await runAutomations(ctx('bom dia')), null);
  assert.equal(await runAutomations(ctx('Qual o valor?')), 'replied');
  assert.equal(await runAutomations(ctx('e o preço?')), null, 'dentro do intervalo não repete');
  const sent = await replies();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, 'Oi Paula! Nossos planos começam em R$ 99.');
  assert.equal(sent[0]!.status, 'PENDING');
  // mensagem antiga (sincronizada depois) não é respondida
  const other = await setup();
  await rule(other.number.id);
  assert.equal(await runAutomations(other.ctx('valor', new Date(Date.now() - 3_600_000))), null);
});

test('encaminhamento para humano pausa a automação até a conversa ser encerrada', async () => {
  const { number, conv, ctx, replies } = await setup();
  await rule(number.id, { keywords: ['atendente', 'humano'], action: 'HANDOFF', responseText: 'Um atendente já vai falar com você.', priority: 10, cooldownMinutes: 1 });
  await rule(number.id, { cooldownMinutes: 1 });
  assert.equal(await runAutomations(ctx('quero falar com um atendente')), 'handoff');
  const after1 = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  assert.equal(after1.status, 'PENDING');
  assert.ok(after1.automationPausedAt);
  assert.equal(await runAutomations(ctx('qual o preço?')), null, 'com humano na conversa a automação não responde');
  assert.equal((await replies()).length, 1);

  // Encerrar a conversa devolve o controle à automação.
  await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'CLOSED', automationPausedAt: null } });
  assert.equal(await runAutomations(ctx('qual o preço?')), 'replied');
});

test('fora do horário responde só fora do expediente; regra de outro número não vale', async () => {
  const { number, ctx, replies } = await setup();
  const elsewhere = await prisma.waNumber.create({ data: { nickname: uniq() } });
  await rule(elsewhere.id, { keywords: ['oi'] });
  await rule(number.id, { trigger: 'OUT_OF_HOURS', keywords: [], responseText: 'Estamos fora do horário. Voltamos às 9h.' });
  await setSetting('businessHours', { timezone: 'America/Sao_Paulo', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
  clearSettingsCache();

  const monday = new Date('2026-11-16T15:00:00Z'); // 12:00 em São Paulo
  const mondayNight = new Date('2026-11-17T01:00:00Z'); // 22:00 de segunda
  assert.equal(await runAutomations(ctx('oi', monday), monday), null, 'no expediente, e a regra de "oi" é de outro número');
  assert.equal(await runAutomations(ctx('oi', mondayNight), mondayNight), 'replied');
  assert.equal((await replies())[0]!.text, 'Estamos fora do horário. Voltamos às 9h.');
});

test('descadastro tem precedência e quem está bloqueado não recebe resposta automática', async () => {
  const { number, contact, ctx, replies } = await setup();
  await rule(number.id, { keywords: ['sair', 'valor'], cooldownMinutes: 1 });
  await processInbound(ctx('SAIR'));
  const sent = await replies();
  assert.equal(sent.length, 1, 'só a confirmação de descadastro');
  assert.match(sent[0]!.text ?? '', /não receberá mais/);
  assert.ok(await prisma.blacklistEntry.findUnique({ where: { phone: contact.phone } }));
  await processInbound(ctx('qual o valor?'));
  assert.equal((await replies()).length, 1);
});
