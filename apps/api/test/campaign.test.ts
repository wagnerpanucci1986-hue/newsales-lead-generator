// Motor de campanhas com sockets simulados: importação, público, rodízio,
// limites, janela, pausa automática, descadastro e rastreamento.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { WAMessage } from 'baileys';
import { campaignStats, startCampaign } from '../src/campaigns/audience.js';
import { CampaignDispatcher } from '../src/campaigns/dispatcher.js';
import { dailyCap, inSendWindow } from '../src/campaigns/rules.js';
import { handleInbound, trackCampaignReceipt } from '../src/campaigns/tracking.js';
import { runImport, runVerify } from '../src/jobs/contacts.js';
import { prisma } from '../src/lib/prisma.js';
import { closeQueues } from '../src/lib/queues.js';
import { redis } from '../src/lib/redis.js';
import { settingSchemas } from '../src/lib/settings.js';
import { storage } from '../src/lib/storage/index.js';
import { localDay } from '../src/lib/time.js';
import { Mirror } from '../src/whatsapp/mirror.js';
import type { SendSocket } from '../src/whatsapp/sender.js';

const PREFIX = 'tc-';
const PHONE = (n: number) => `55119666${String(n).padStart(5, '0')}`;
let seq = 0;
const uniq = () => `${PREFIX}${Date.now()}-${seq++}`;
const antiBan = settingSchemas.antiBan.parse({});

function fakeSocket(opts: { fail?: boolean; noWhatsApp?: string[] } = {}) {
  const sent: { jid: string; text: string }[] = [];
  const presence: string[] = [];
  const sock: SendSocket = {
    user: { id: '5511900000000:1@s.whatsapp.net' },
    async sendMessage(jid, content, options) {
      if (opts.fail) throw new Error('Connection Closed');
      const text = (content as { text?: string }).text ?? '';
      sent.push({ jid, text });
      return { key: { id: options?.messageId, remoteJid: jid, fromMe: true }, message: { conversation: text } } as WAMessage;
    },
    async readMessages() {},
    async onWhatsApp(...phones) {
      return phones.filter((p) => !opts.noWhatsApp?.includes(p)).map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: true }));
    },
    async presenceSubscribe() {},
    async sendPresenceUpdate(type) {
      presence.push(type);
    },
  };
  return { sock, sent, presence };
}

const mkNumber = (over: object = {}) => prisma.waNumber.create({ data: { nickname: uniq(), status: 'CONNECTED', warmupEnabled: false, dailyLimit: 100, ...over } });

async function mkCampaign(numberIds: string[], phones: number[], over: object = {}) {
  const list = await prisma.contactList.create({ data: { name: uniq() } });
  for (const n of phones) {
    const contact = await prisma.contact.upsert({ where: { phone: PHONE(n) }, create: { phone: PHONE(n), name: `Cliente ${n}`, customFields: { Cidade: 'Campinas' } }, update: {} });
    await prisma.contactListMember.create({ data: { listId: list.id, contactId: contact.id } });
  }
  const campaign = await prisma.campaign.create({
    data: {
      name: uniq(),
      body: '{Olá|Oi} {{primeiro_nome}}, novidades em {{cidade}}!',
      status: 'SCHEDULED',
      consentConfirmed: true,
      sendDays: [0, 1, 2, 3, 4, 5, 6],
      windowStart: '00:00',
      windowEnd: '00:00',
      minDelayS: 15,
      maxDelayS: 60,
      longPauseEvery: 3,
      longPauseMinS: 300,
      longPauseMaxS: 900,
      numbers: { create: numberIds.map((numberId) => ({ numberId })) },
      lists: { create: { listId: list.id } },
      ...over,
    },
  });
  return campaign;
}

const noSleep = async () => undefined;

before(async () => {
  await prisma.blacklistEntry.deleteMany({ where: { phone: { startsWith: '55119666' } } });
  await prisma.contact.deleteMany({ where: { phone: { startsWith: '55119666' } } });
});
after(async () => {
  await prisma.campaign.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.contactList.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.waNumber.deleteMany({ where: { nickname: { startsWith: PREFIX } } });
  await prisma.blacklistEntry.deleteMany({ where: { phone: { startsWith: '55119666' } } });
  await prisma.contact.deleteMany({ where: { phone: { startsWith: '55119666' } } });
  await prisma.importJob.deleteMany({ where: { fileName: { startsWith: PREFIX } } });
  await closeQueues();
  await prisma.$disconnect();
  redis.disconnect();
});

test('janela de envio e rampa de aquecimento', () => {
  const base = { timezone: 'America/Sao_Paulo', sendDays: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '18:00' };
  // 2026-11-16 é segunda-feira; 15:00 UTC = 12:00 em São Paulo
  assert.equal(inSendWindow(base, new Date('2026-11-16T15:00:00Z')), true);
  assert.equal(inSendWindow(base, new Date('2026-11-16T11:30:00Z')), false, '08:30 é antes da janela');
  assert.equal(inSendWindow(base, new Date('2026-11-16T21:00:00Z')), false, '18:00 já está fora');
  assert.equal(inSendWindow(base, new Date('2026-11-15T15:00:00Z')), false, 'domingo');
  assert.equal(inSendWindow({ ...base, windowStart: '22:00', windowEnd: '02:00' }, new Date('2026-11-17T03:30:00Z')), true, 'janela que cruza a meia-noite');

  const number = { dailyLimit: 200, warmupEnabled: true, warmupStartedAt: new Date('2026-11-10T12:00:00Z') };
  const cap = (day: string) => dailyCap(number, antiBan, new Date(`${day}T15:00:00Z`));
  assert.equal(cap('2026-11-10'), 20);
  assert.equal(cap('2026-11-11'), 25);
  assert.equal(cap('2026-11-14'), 49);
  assert.equal(cap('2026-12-30'), 200, 'nunca passa do limite diário');
  assert.equal(dailyCap({ ...number, warmupEnabled: false }, antiBan), 200);
});

test('importação valida, deduplica e atualiza sem apagar dados', async () => {
  await prisma.contact.create({ data: { phone: PHONE(1), name: 'Nome antigo', company: 'ACME', customFields: { Plano: 'Pro' } } });
  await prisma.blacklistEntry.create({ data: { phone: PHONE(3) } });
  const csv = ['Nome;Celular;Cidade;Obs', 'Maria;(11) 96660-0001;Campinas;x', 'João;11 96660-0002;Santos;y', 'João Duplicado;+55 11 96660-0002;Santos;z', 'Bloqueado;11966600003;;', 'Inválido;12345;;', ';;;'].join('\n');
  const key = `importacoes/${uniq()}.csv`;
  await storage.put(key, Buffer.from(csv, 'latin1'), 'text/csv');
  const list = await prisma.contactList.create({ data: { name: uniq() } });
  const job = await prisma.importJob.create({
    data: { fileName: `${uniq()}.csv`, storageKey: key, status: 'PROCESSING', listId: list.id, consentSource: 'Formulário do site', columnMapping: { columns: { Nome: 'name', Celular: 'phone', Cidade: 'custom:Cidade', Obs: 'ignore' } } },
  });
  await runImport(job.id);

  const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(done.status, 'COMPLETED');
  assert.deepEqual([done.created, done.updated, done.invalid, done.blacklisted], [2, 1, 2, 1]);
  assert.equal((done.errorReport as { duplicatedInFile: number }).duplicatedInFile, 1);

  const maria = await prisma.contact.findUniqueOrThrow({ where: { phone: PHONE(1) } });
  assert.equal(maria.name, 'Maria');
  assert.equal(maria.company, 'ACME', 'coluna ausente não apaga o que já existia');
  assert.deepEqual(maria.customFields, { Plano: 'Pro', Cidade: 'Campinas' });
  assert.equal(maria.consentSource, 'Formulário do site');
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { phone: PHONE(2) } })).name, 'João Duplicado');
  assert.equal(await prisma.contactListMember.count({ where: { listId: list.id } }), 3);
});

test('verificação marca quem tem e quem não tem WhatsApp', async () => {
  const number = await mkNumber();
  await prisma.contact.createMany({ data: [{ phone: PHONE(10) }, { phone: PHONE(11) }] });
  const ids = (await prisma.contact.findMany({ where: { phone: { in: [PHONE(10), PHONE(11)] } } })).map((c) => c.id);
  const { sock } = fakeSocket({ noWhatsApp: [PHONE(11)] });
  const result = await runVerify({ getSocket: () => sock }, { kind: 'verify', numberId: number.id, contactIds: ids }, noSleep);
  assert.deepEqual(result, { valid: 1, invalid: 1 });
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { phone: PHONE(10) } })).waJid, `${PHONE(10)}@s.whatsapp.net`);
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { phone: PHONE(11) } })).waStatus, 'INVALID');
});

test('campanha: público, rodízio entre números, ritmo e conclusão', async () => {
  const [n1, n2] = [await mkNumber(), await mkNumber()];
  const s1 = fakeSocket({ noWhatsApp: [PHONE(26)] });
  const s2 = fakeSocket({ noWhatsApp: [PHONE(26)] });
  const sessions = { getSocket: (id: string) => (id === n1.id ? s1.sock : id === n2.id ? s2.sock : undefined) };
  const campaign = await mkCampaign([n1.id, n2.id], [20, 21, 22, 23, 24, 25, 26]);
  await prisma.blacklistEntry.create({ data: { phone: PHONE(24) } });
  await prisma.contact.update({ where: { phone: PHONE(25) }, data: { optedOutAt: new Date() } });

  await startCampaign(campaign.id);
  let stats = (await campaignStats([campaign.id])).get(campaign.id)!;
  assert.deepEqual([stats.total, stats.queued, stats.skipped], [7, 5, 2], 'blacklist e opt-out já entram como pulados');

  const dispatcher = new CampaignDispatcher(sessions, { sleep: noSleep, random: () => 0.5 });
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) {
    for (const n of [n1, n2]) {
      await prisma.waNumber.update({ where: { id: n.id }, data: { nextSendAt: null } });
      outcomes.push(await dispatcher.tick(n.id));
    }
  }
  assert.equal(outcomes.filter((o) => o === 'sent').length, 4);
  assert.equal(outcomes.filter((o) => o === 'skipped').length, 1, 'contato sem WhatsApp é pulado no envio');
  assert.ok(s1.sent.length >= 1 && s2.sent.length >= 1, 'os dois números participaram');
  assert.equal(s1.sent.length + s2.sent.length, 4);
  assert.match(s1.sent[0]!.text, /^(Olá|Oi) Cliente, novidades em Campinas!$/);
  assert.deepEqual(s1.presence.slice(0, 2), ['composing', 'paused'], 'simula digitando antes de enviar');

  stats = (await campaignStats([campaign.id])).get(campaign.id)!;
  assert.deepEqual([stats.sent, stats.skipped, stats.queued, stats.failed], [4, 3, 0, 0]);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'COMPLETED');
  const rec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id, status: 'SENT' }, include: { message: true } });
  assert.equal(rec.message?.source, 'CAMPAIGN');
  assert.equal(rec.message?.status, 'SENT');
  assert.ok(rec.renderedText && rec.sentAt);
  const day = await prisma.numberDailyStat.findMany({ where: { numberId: { in: [n1.id, n2.id] }, date: localDay() } });
  assert.equal(day.reduce((a, d) => a + d.campaignSent, 0), 4);
});

test('ritmo: intervalo aleatório entre envios e pausa longa a cada N', async () => {
  const number = await mkNumber();
  const { sock } = fakeSocket();
  const campaign = await mkCampaign([number.id], [30, 31, 32, 33]);
  await startCampaign(campaign.id);
  const dispatcher = new CampaignDispatcher({ getSocket: () => sock }, { sleep: noSleep, random: () => 0.5 });
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    await prisma.waNumber.update({ where: { id: number.id }, data: { nextSendAt: null } });
    assert.equal(await dispatcher.tick(number.id), 'sent');
    const next = (await prisma.waNumber.findUniqueOrThrow({ where: { id: number.id } })).nextSendAt!;
    waits.push(Math.round((next.getTime() - before) / 1000));
  }
  assert.ok(waits[0]! >= 15 && waits[0]! <= 61, `1º intervalo dentro de 15–60 s (foi ${waits[0]})`);
  assert.ok(waits[2]! >= 300 && waits[2]! <= 901, `3º envio dispara a pausa longa de 300–900 s (foi ${waits[2]})`);
});

test('limite diário e janela de envio seguram o disparo', async () => {
  const limited = await mkNumber({ warmupEnabled: true, dailyLimit: 200 });
  const { sock, sent } = fakeSocket();
  const c1 = await mkCampaign([limited.id], [40, 41]);
  await startCampaign(c1.id);
  await prisma.numberDailyStat.create({ data: { numberId: limited.id, date: localDay(), campaignSent: 20 } });
  const dispatcher = new CampaignDispatcher({ getSocket: () => sock }, { sleep: noSleep });
  assert.equal(await dispatcher.tick(limited.id), 'daily-limit', 'número em aquecimento para em 20 no primeiro dia');
  const next = (await prisma.waNumber.findUniqueOrThrow({ where: { id: limited.id } })).nextSendAt!;
  assert.ok(next.getTime() > Date.now() && next.getTime() - Date.now() <= 86_400_000);

  const other = await mkNumber();
  const today = new Date().getDay();
  const c2 = await mkCampaign([other.id], [42], { sendDays: [(today + 3) % 7] });
  await startCampaign(c2.id);
  assert.equal(await dispatcher.tick(other.id), 'out-of-window');

  await prisma.campaign.update({ where: { id: c2.id }, data: { sendDays: [0, 1, 2, 3, 4, 5, 6], status: 'PAUSED' } });
  await prisma.waNumber.update({ where: { id: other.id }, data: { nextSendAt: null } });
  assert.equal(await dispatcher.tick(other.id), 'out-of-window', 'campanha pausada não envia');
  assert.equal(sent.length, 0);
});

test('falhas em sequência pausam o número automaticamente', async () => {
  const number = await mkNumber();
  const { sock } = fakeSocket({ fail: true });
  const campaign = await mkCampaign([number.id], [50, 51, 52, 53, 54, 55, 56]);
  await prisma.contact.updateMany({ where: { phone: { startsWith: '5511966600005' } }, data: { waStatus: 'VALID' } });
  await startCampaign(campaign.id);
  const dispatcher = new CampaignDispatcher({ getSocket: () => sock }, { sleep: noSleep });
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i++) {
    await prisma.waNumber.update({ where: { id: number.id }, data: { nextSendAt: null } });
    outcomes.push(await dispatcher.tick(number.id));
  }
  assert.deepEqual(outcomes, ['failed', 'failed', 'failed', 'failed', 'failed', 'idle']);
  const paused = await prisma.waNumber.findUniqueOrThrow({ where: { id: number.id } });
  assert.equal(paused.status, 'SUSPECT');
  assert.match(paused.pauseReason ?? '', /5 falhas/);
  const stats = (await campaignStats([campaign.id])).get(campaign.id)!;
  assert.deepEqual([stats.failed, stats.queued], [5, 2], 'o restante da fila fica intacto para outro número');
});

test('queda na taxa de entrega pausa o número', async () => {
  const number = await mkNumber();
  const campaign = await mkCampaign([number.id], []);
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (let i = 0; i < 20; i++) {
    const contact = await prisma.contact.create({ data: { phone: PHONE(600 + i) } });
    await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: contact.id, numberId: number.id, status: 'SENT', sentAt: old, deliveredAt: i < 4 ? old : null } });
  }
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
  const dispatcher = new CampaignDispatcher({ getSocket: () => undefined });
  await dispatcher.maintain();
  const n = await prisma.waNumber.findUniqueOrThrow({ where: { id: number.id } });
  assert.equal(n.status, 'SUSPECT');
  assert.match(n.pauseReason ?? '', /20%/);
});

test('recibos, resposta e descadastro (SAIR) entram no relatório', async () => {
  const number = await mkNumber();
  const { sock } = fakeSocket();
  const campaign = await mkCampaign([number.id], [70]);
  const later = await mkCampaign([number.id], [70], { status: 'SCHEDULED' });
  await startCampaign(campaign.id);
  await startCampaign(later.id);
  await prisma.campaign.update({ where: { id: later.id }, data: { status: 'PAUSED' } }); // fica na fila
  const dispatcher = new CampaignDispatcher({ getSocket: () => sock }, { sleep: noSleep });
  assert.equal(await dispatcher.tick(number.id), 'sent');

  const rec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { message: true } });
  const jid = `${PHONE(70)}@s.whatsapp.net`;
  const mirror = new Mirror({ numberId: number.id, resolvePn: async () => null, groupSubject: async () => null, enqueueMedia: async () => undefined, onInbound: handleInbound, onReceipt: trackCampaignReceipt });
  await mirror.onMessagesUpdate([{ key: { id: rec.message!.waMessageId, remoteJid: jid, fromMe: true }, update: { status: 4 } }]);
  await mirror.onUpsert([{ key: { id: uniq(), remoteJid: jid, fromMe: false }, message: { conversation: ' Sair! ' }, messageTimestamp: Date.now() / 1000 }]);

  const stats = (await campaignStats([campaign.id])).get(campaign.id)!;
  assert.deepEqual([stats.sent, stats.delivered, stats.read, stats.replied, stats.optOut], [1, 1, 1, 1, 1]);
  const contact = await prisma.contact.findUniqueOrThrow({ where: { phone: PHONE(70) } });
  assert.ok(contact.optedOutAt);
  assert.equal((await prisma.blacklistEntry.findUniqueOrThrow({ where: { phone: PHONE(70) } })).source, 'OPT_OUT');
  assert.equal((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: later.id } })).skipReason, 'opt-out', 'sai das campanhas que ainda não enviaram');

  const confirmations = await prisma.message.findMany({ where: { numberId: number.id, source: 'AUTOMATION' } });
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!.text ?? '', /não receberá mais/);
  // Pedir de novo não gera segunda confirmação.
  await mirror.onUpsert([{ key: { id: uniq(), remoteJid: jid, fromMe: false }, message: { conversation: 'PARAR' }, messageTimestamp: Date.now() / 1000 }]);
  assert.equal(await prisma.message.count({ where: { numberId: number.id, source: 'AUTOMATION' } }), 1);
});
