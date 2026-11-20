// Captação pelo Instagram: leitura dos @, extração de contatos da bio, consulta à Graph API
// (simulada: a rede de testes não fala com a Meta) e importação para Contatos.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { extractContacts, parseUsernames } from '../src/instagram/extract.js';
import { discoverAccount, getConnection, removeConnection, saveConnection } from '../src/instagram/graph.js';
import { lookupProfiles } from '../src/instagram/lookup.js';
import { runInstagramToContacts } from '../src/instagram/to-contacts.js';
import { prisma } from '../src/lib/prisma.js';
import { closeQueues } from '../src/lib/queues.js';
import { redis } from '../src/lib/redis.js';

const PREFIX = 'tig_';
const PHONES = ['5569991110001', '5569991110002', '5569991110003'];
const realFetch = globalThis.fetch;
const calls: string[] = [];

type Fake = (url: URL) => { status?: number; body: unknown };
function mockFetch(fake: Fake) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const r = fake(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function cleanup() {
  await prisma.instagramProfile.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prisma.contact.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.blacklistEntry.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.importJob.deleteMany({ where: { fileName: 'teste-instagram' } });
}

// Guarda a conexão do banco de desenvolvimento, se houver, para devolver no fim.
let savedConnection: unknown = null;
before(async () => {
  savedConnection = (await prisma.setting.findUnique({ where: { key: 'instagram.credentials' } }))?.value ?? null;
  await cleanup();
});
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
  await removeConnection();
  if (savedConnection) await prisma.setting.create({ data: { key: 'instagram.credentials', value: savedConnection as object } });
  await closeQueues();
  await prisma.$disconnect();
  redis.disconnect();
});

test('lê @, links e separadores; recusa o que não é perfil', () => {
  const r = parseUsernames('@Loja.Um\nhttps://www.instagram.com/loja_dois/?igsh=abc, instagram.com/p/XYZ loja.um  bad-name!');
  assert.deepEqual(r.usernames, ['loja.um', 'loja_dois']);
  assert.deepEqual(r.invalid, ['instagram.com/p/XYZ', 'bad-name!']);
});

test('extrai celulares (primeiro), fixos e e-mails da bio e do link', () => {
  const r = extractContacts('📞 (69) 3221-4455 | Whats 69 9 9111-0001\nCNPJ 12.345.678/0001-90 · contato@Loja.com.br', 'https://wa.me/5569991110002?text=oi');
  assert.deepEqual(r.phones, ['5569991110002', '5569991110001', '556932214455']);
  assert.deepEqual(r.emails, ['contato@loja.com.br']);
  assert.deepEqual(extractContacts('api.whatsapp.com/send?phone=5569991110003&text=x').phones, ['5569991110003']);
  assert.deepEqual(extractContacts('CEP 86010-000, nº 1234').phones, [], 'não confunde CEP com telefone');
});

test('conexão: descobre a conta pelo token e guarda cifrado', async () => {
  mockFetch((url) => {
    if (url.pathname.endsWith('/me/accounts')) return { body: { data: [{ name: 'Página A' }, { name: 'New Sales', instagram_business_account: { id: '178400', username: 'newsales' } }] } };
    return { status: 400, body: { error: { message: 'x', code: 100 } } };
  });
  const conn = await discoverAccount('token-de-teste-bem-comprido');
  assert.equal(conn.igUserId, '178400');
  assert.equal(conn.pageName, 'New Sales');
  await saveConnection('token-de-teste-bem-comprido', conn);
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'instagram.credentials' } });
  assert.ok(!JSON.stringify(row.value).includes('token-de-teste'), 'token não fica em texto puro');
  assert.equal((await getConnection())?.igUsername, 'newsales');

  mockFetch(() => ({ status: 400, body: { error: { message: 'Session has expired', code: 190 } } }));
  await assert.rejects(discoverAccount('token-vencido-bem-comprido'), /expirou/);
});

test('pesquisa: grava perfis, marca inexistentes, usa cache e para no limite da Meta', async () => {
  calls.length = 0;
  mockFetch((url) => {
    const fields = url.searchParams.get('fields') ?? '';
    assert.equal(url.searchParams.get('access_token'), 'token-de-teste-bem-comprido');
    const u = /username\(([^)]+)\)/.exec(fields)?.[1];
    if (u === `${PREFIX}loja`) {
      return { body: { business_discovery: { id: '1', username: u, name: 'Loja Teste', biography: 'Moda feminina 👗 Whats (69) 99111-0001', website: 'https://wa.me/5569991110002', followers_count: 12500, media_count: 300, media: { data: [{ timestamp: '2026-11-10T12:00:00+0000' }] } } } };
    }
    if (u === `${PREFIX}semfone`) return { body: { business_discovery: { id: '2', username: u, name: 'Sem Fone', biography: 'Só pelo direct', followers_count: 800 } } };
    if (u === `${PREFIX}pessoal`) return { status: 400, body: { error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 } } };
    return { status: 400, body: { error: { message: 'Application request limit reached', code: 4 } } };
  });
  const r = await lookupProfiles([`${PREFIX}loja`, `${PREFIX}semfone`, `${PREFIX}pessoal`, `${PREFIX}limite`, `${PREFIX}depois`], { pauseMs: 0 });
  assert.equal(r.profiles.length, 3);
  const loja = r.profiles.find((p) => p.username === `${PREFIX}loja`)!;
  assert.deepEqual(loja.phones, ['5569991110002', '5569991110001']);
  assert.equal(loja.followersCount, 12500);
  assert.equal(loja.lastPostAt?.toISOString(), '2026-11-10T12:00:00.000Z');
  assert.match(r.profiles.find((p) => p.username === `${PREFIX}pessoal`)!.error ?? '', /comerciais/);
  assert.deepEqual(r.pending, [`${PREFIX}limite`, `${PREFIX}depois`], 'limite interrompe o lote');
  assert.match(r.stopReason ?? '', /limitou/);
  assert.equal(calls.length, 4, 'depois do limite não consulta mais');

  calls.length = 0;
  const again = await lookupProfiles([`${PREFIX}loja`, `${PREFIX}pessoal`], { pauseMs: 0 });
  assert.equal(again.profiles.length, 2);
  assert.equal(calls.length, 0, 'cache de 7 dias, inclusive para perfil inexistente');
});

test('importa para Contatos só quem tem telefone e respeita o bloqueio', async () => {
  await prisma.blacklistEntry.create({ data: { phone: '5569991110003', source: 'MANUAL' } });
  await prisma.instagramProfile.create({ data: { username: `${PREFIX}bloqueado`, name: 'Bloqueado', phones: ['5569991110003'], emails: [] } });
  const job = await prisma.importJob.create({
    data: {
      fileName: 'teste-instagram', storageKey: 'instagram', status: 'PROCESSING', tagIds: [], consentSource: 'teste',
      columnMapping: { instagram: { usernames: [`${PREFIX}loja`, `${PREFIX}semfone`, `${PREFIX}pessoal`, `${PREFIX}bloqueado`] } },
    },
  });
  await runInstagramToContacts(job.id);
  const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(done.status, 'COMPLETED', done.error ?? '');
  assert.equal(done.created, 1);
  assert.equal(done.blacklisted, 1);
  assert.equal(done.invalid, 2, 'sem telefone e perfil inexistente');
  const c = await prisma.contact.findUniqueOrThrow({ where: { phone: '5569991110002' } });
  assert.equal(c.name, 'Loja Teste');
  assert.deepEqual(c.customFields, { instagram: `@${PREFIX}loja`, seguidores: '12.500', site: 'https://wa.me/5569991110002' });
});
