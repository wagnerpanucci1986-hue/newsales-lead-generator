// Captação pela base de CNPJ: ZIPs sintéticos no layout oficial da Receita (latin1, ";", aspas).
// Usa a UF fictícia "ZZ" para nunca apagar dados reais de uma UF carregada no banco de desenvolvimento.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { legalBasisProblem } from '../src/campaigns/legal.js';
import { runCnpjImport } from '../src/cnpj/importer.js';
import { parsePhone, titleCase } from '../src/cnpj/layout.js';
import { cnpjFiltersSchema, searchCnpj } from '../src/cnpj/search.js';
import { localSource, parseMonthFolders, parsePropfind, parseZipLinks } from '../src/cnpj/source.js';
import { runCnpjToContacts } from '../src/cnpj/to-contacts.js';
import { prisma } from '../src/lib/prisma.js';
import { closeQueues } from '../src/lib/queues.js';
import { redis } from '../src/lib/redis.js';

const BASES = ['91111111', '92222222', '93333333', '94444444', '95555555', '96666666', '9ABC1234'];
let dir = '';

// Uma linha de Estabelecimentos com 30 colunas.
function est(o: Partial<Record<string, string>>): string[] {
  const r = Array(30).fill('');
  const set = (i: number, v: string | undefined) => v !== undefined && (r[i] = v);
  set(0, o.base); set(1, o.ordem ?? '0001'); set(2, o.dv ?? '00'); set(3, o.mf ?? '1'); set(4, o.fantasia);
  set(5, o.situacao ?? '02'); set(10, o.inicio ?? '20150312'); set(11, o.cnae); set(12, o.secundarios);
  set(13, 'RUA'); set(14, o.logradouro ?? 'XV DE NOVEMBRO'); set(15, '100'); set(17, o.bairro); set(18, '80000000');
  set(19, o.uf ?? 'ZZ'); set(20, o.mun ?? '7535'); set(21, o.ddd1); set(22, o.tel1); set(23, o.ddd2); set(24, o.tel2); set(27, o.email);
  return r;
}
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((v) => `"${v}"`).join(';')).join('\r\n') + '\r\n', 'latin1');

function writeZip(file: string, inner: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(data, inner);
    zip.end();
    zip.outputStream.pipe(createWriteStream(file)).on('close', () => resolve()).on('error', reject);
  });
}

async function writeFixtures(includeFilial2: boolean) {
  const rows = [
    est({ base: '91111111', fantasia: 'PADARIA SÃO JOÃO', cnae: '4711302', secundarios: '4729699,1091102', bairro: 'CENTRO CÍVICO', ddd1: '41', tel1: '999998888', email: 'Contato@Padaria.com.br' }),
    est({ base: '92222222', mf: '2', ordem: '0002', fantasia: 'TRANSPORTES NORTE', cnae: '4930202', mun: '7563', ddd1: '43', tel1: '33334444' }),
    est({ base: '93333333', situacao: '08', cnae: '4711302', ddd1: '41', tel1: '988887777' }),
    est({ base: '94444444', uf: 'SP', cnae: '4711302', ddd1: '11', tel1: '977776666' }),
    est({ base: '95555555', cnae: '4711302' }),
    est({ base: '96666666', fantasia: '', cnae: '4781400', ddd1: '41', tel1: '98887777' }),
    est({ base: '9ABC1234', dv: '90', cnae: '4711302', ddd1: '', tel1: '41987654321' }),
  ];
  if (includeFilial2) rows.push(est({ base: '91111111', ordem: '0002', mf: '2', fantasia: 'PADARIA SÃO JOÃO FILIAL', cnae: '4711302', ddd1: '41', tel1: '999998888' }));
  await writeZip(path.join(dir, 'Estabelecimentos0.zip'), 'K3241.ESTABELE', csv(rows.slice(0, 4)));
  await writeZip(path.join(dir, 'Estabelecimentos1.zip'), 'K3241.ESTABELE', csv(rows.slice(4)));
  await writeZip(path.join(dir, 'Empresas0.zip'), 'K3241.EMPRECSV', csv([
    ['91111111', 'PADARIA SAO JOAO LTDA', '2062', '49', '150000,00', '03', ''],
    ['92222222', 'TRANSPORTES NORTE S/A', '2054', '10', '2500000,00', '05', ''],
    ['96666666', '96.666.666 JOAO DA SILVA', '2135', '50', '5000,00', '01', ''],
    ['9ABC1234', 'MERCADO ALFA LTDA', '2062', '49', '80000,00', '01', ''],
    ['94444444', 'NAO DEVE ENTRAR LTDA', '2062', '49', '1,00', '01', ''],
  ]));
  await writeZip(path.join(dir, 'Simples.zip'), 'SIMPLES.CSV', csv([
    ['91111111', 'S', '20150312', '00000000', 'N', '00000000', '00000000'],
    ['96666666', 'S', '20180101', '00000000', 'S', '20180101', '00000000'],
    ['9ABC1234', 'S', '20180101', '20200101', 'S', '20180101', '20200101'],
  ]));
  await writeZip(path.join(dir, 'Municipios.zip'), 'MUNICCSV', csv([['7535', 'CURITIBA'], ['7563', 'LONDRINA'], ['7107', 'SAO PAULO']]));
  await writeZip(path.join(dir, 'Cnaes.zip'), 'CNAECSV', csv([['4711302', 'Comércio varejista de mercadorias em geral - supermercados'], ['4930202', 'Transporte rodoviário de carga'], ['4781400', 'Comércio varejista de artigos do vestuário']]));
  await writeZip(path.join(dir, 'Naturezas.zip'), 'NATJUCSV', csv([['2062', 'Sociedade Empresária Limitada'], ['2135', 'Empresário (Individual)']]));
}

async function runImport() {
  const job = await prisma.cnpjImport.create({ data: { ufs: ['ZZ'] } });
  await runCnpjImport(job.id, (await localSource(dir))!);
  return prisma.cnpjImport.findUniqueOrThrow({ where: { id: job.id } });
}

const F = (o: object = {}) => cnpjFiltersSchema.parse({ uf: 'ZZ', hideKnown: false, hideSharedPhones: false, ...o });

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cnpj-test-'));
  await cleanup();
});
async function cleanup() {
  await prisma.cnpjEstablishment.deleteMany({ where: { cnpjBase: { in: BASES } } });
  await prisma.cnpjCompany.deleteMany({ where: { cnpjBase: { in: BASES } } });
  await prisma.contact.deleteMany({ where: { phone: { in: ['5541999998888', '5541998887777', '5541987654321', '554333334444'] } } });
  await prisma.blacklistEntry.deleteMany({ where: { phone: '5541987654321' } });
  await prisma.tag.deleteMany({ where: { name: 'teste-cnpj' } });
}
after(async () => {
  await cleanup();
  await prisma.cnpjImport.deleteMany({ where: { ufs: { has: 'ZZ' } } });
  await prisma.importJob.deleteMany({ where: { fileName: { startsWith: 'teste-cnpj' } } });
  await rm(dir, { recursive: true, force: true });
  await closeQueues();
  await prisma.$disconnect();
  redis.disconnect();
});

test('telefone, nome e listagens da Receita', () => {
  assert.deepEqual(parsePhone('41', '999998888'), { phone: '5541999998888', mobile: true });
  assert.deepEqual(parsePhone('41', '98887777'), { phone: '5541998887777', mobile: true }, 'celular antigo ganha o 9');
  assert.deepEqual(parsePhone('043', '33334444'), { phone: '554333334444', mobile: false }, 'DDD com zero à esquerda');
  assert.deepEqual(parsePhone('', '41987654321'), { phone: '5541987654321', mobile: true }, 'DDD dentro do número');
  assert.equal(parsePhone('41', '0'), null);
  assert.equal(titleCase('PADARIA SÃO JOÃO DE DEUS LTDA'), 'Padaria São João de Deus LTDA');
  assert.deepEqual(parseMonthFolders('<a href="2026-09/">2026-09/</a> <a href="2026-11/">x</a> <a href="/dados/2026-10/">y</a>'), ['2026-11', '2026-10', '2026-09']);
  assert.deepEqual(parseZipLinks('<a href="Empresas0.zip">E</a><a href="/x/Estabelecimentos1.zip">x</a><a href="LAYOUT.pdf">p</a>').sort(), ['Empresas0.zip', 'Estabelecimentos1.zip']);
  assert.deepEqual(parsePropfind('<d:multistatus><d:response><d:href>/public.php/webdav/2026-11/</d:href></d:response><d:response><d:href>/public.php/webdav/2026-11/Simples.zip</d:href></d:response></d:multistatus>'), [
    '/public.php/webdav/2026-11/',
    '/public.php/webdav/2026-11/Simples.zip',
  ]);
});

test('importação mantém só ativas, da UF e com telefone; junta empresa, Simples e MEI', async () => {
  await writeFixtures(true);
  const job = await runImport();
  assert.equal(job.status, 'COMPLETED', job.error ?? '');
  const stats = job.stats as Record<string, number>;
  assert.equal(stats.estabelecimentosLidos, 8);
  assert.equal(stats.mantidos, 5, 'fora: inativa, outra UF, sem telefone');
  assert.equal(stats.comCelular, 4);

  const padaria = await prisma.cnpjEstablishment.findUniqueOrThrow({ where: { cnpj: '91111111000100' } });
  assert.equal(padaria.nomeFantasia, 'PADARIA SÃO JOÃO', 'latin1 decodificado');
  assert.equal(padaria.bairro, 'CENTRO CÍVICO');
  assert.equal(padaria.municipio, 'CURITIBA');
  assert.equal(padaria.email, 'contato@padaria.com.br');
  assert.deepEqual(padaria.cnaesSecundarios, ['4729699', '1091102']);
  assert.ok(await prisma.cnpjEstablishment.findUnique({ where: { cnpj: '9ABC12340001' + '90' } }), 'CNPJ alfanumérico');

  const mei = await prisma.cnpjCompany.findUniqueOrThrow({ where: { cnpjBase: '96666666' } });
  assert.equal(mei.isMei, true);
  assert.equal((await prisma.cnpjCompany.findUniqueOrThrow({ where: { cnpjBase: '9ABC1234' } })).isMei, false, 'MEI com data de exclusão não conta');
  assert.equal((await prisma.cnpjCompany.findUniqueOrThrow({ where: { cnpjBase: '91111111' } })).capitalSocial, 150000);
  assert.equal(await prisma.cnpjCompany.count({ where: { cnpjBase: '94444444' } }), 0, 'empresa de outra UF não é guardada');
});

test('filtros da busca', async () => {
  const total = async (o: object) => (await searchCnpj(F(o), 1, 50)).total;
  assert.equal(await total({ phone: 'any' }), 5);
  assert.equal(await total({}), 4, 'padrão: só com celular');
  assert.equal(await total({ phone: 'fixed' }), 1);
  assert.equal(await total({ cnaes: ['4711302'] }), 3);
  assert.equal(await total({ cnaes: ['4729699'] }), 0);
  assert.equal(await total({ cnaes: ['4729699'], includeSecondary: true }), 1, 'atividade secundária');
  assert.equal(await total({ municipios: ['7563'], phone: 'any' }), 1);
  assert.equal(await total({ mei: 'only' }), 1);
  assert.equal(await total({ mei: 'exclude' }), 3);
  assert.equal(await total({ matriz: 'filial', phone: 'any' }), 2);
  assert.equal(await total({ withEmail: true }), 1);
  assert.equal(await total({ capitalMin: 100000, phone: 'any' }), 3);
  assert.equal(await total({ portes: ['01'] }), 2);
  assert.equal(await total({ q: 'são joão' }), 2, 'busca com acento');
  assert.equal(await total({ ddds: ['43'], phone: 'any' }), 1);
  // Matriz e filial da padaria: mesmo CNPJ base, então o telefone não conta como compartilhado.
  assert.equal(await total({ hideSharedPhones: true, phone: 'any' }), 5);
  const first = (await searchCnpj(F({ phone: 'any' }), 1, 1)).rows[0]!;
  assert.equal(first.razaoSocial, 'TRANSPORTES NORTE S/A', 'maior capital primeiro');
});

test('importar para Contatos: título, MEI, telefone repetido, bloqueio e etiquetas', async () => {
  await prisma.blacklistEntry.create({ data: { phone: '5541987654321' } });
  const tag = await prisma.tag.create({ data: { name: 'teste-cnpj' } });
  const job = await prisma.importJob.create({
    data: {
      fileName: 'teste-cnpj', storageKey: 'cnpj', status: 'PROCESSING', tagIds: [tag.id], consentSource: 'teste',
      columnMapping: { cnpj: { filters: F(), limit: 100, includeFixed: false } },
    },
  });
  await runCnpjToContacts(job.id);
  const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(done.status, 'COMPLETED', done.error ?? '');
  assert.equal(done.created, 2, 'matriz e filial com o mesmo celular viram um contato');
  assert.equal(done.blacklisted, 1);

  const padaria = await prisma.contact.findUniqueOrThrow({ where: { phone: '5541999998888' }, include: { tags: true } });
  assert.equal(padaria.name, 'Padaria São João');
  assert.equal(padaria.company, 'Padaria Sao Joao LTDA');
  assert.equal((padaria.customFields as Record<string, string>).cnpj, '91.111.111/0001-00');
  assert.equal(padaria.tags.length, 1);
  const mei = await prisma.contact.findUniqueOrThrow({ where: { phone: '5541998887777' } });
  assert.equal(mei.name, 'Joao da Silva', 'MEI sem nome fantasia usa a razão sem o número');
  assert.equal((mei.customFields as Record<string, string>).porte, 'MEI');

  assert.equal((await searchCnpj(F({ hideKnown: true }), 1, 50)).total, 0, 'quem virou contato ou está bloqueado some da busca');
});

test('telefone repetido em 3+ empresas (contador) some da busca padrão', async () => {
  const contador = '5543999990000';
  await prisma.cnpjEstablishment.updateMany({ where: { cnpjBase: { in: ['91111111', '92222222', '96666666'] } }, data: { mobile: contador, hasMobile: true, phoneShared: 3 } });
  const shared = await searchCnpj(F({ hideSharedPhones: true }), 1, 50);
  assert.ok(shared.rows.every((r) => r.mobile !== contador));
  assert.equal((await searchCnpj(F({ hideSharedPhones: false, q: 'joão' }), 1, 50)).total, 2);
});

test('nova atualização remove o que saiu da base', async () => {
  await rm(path.join(dir, 'Estabelecimentos0.zip'));
  await rm(path.join(dir, 'Estabelecimentos1.zip'));
  await writeFile(path.join(dir, 'leia-me.txt'), 'x');
  await writeFixtures(false);
  const job = await runImport();
  assert.equal((job.stats as Record<string, number>).removidos, 1, 'a filial que sumiu é removida');
  assert.equal((await prisma.cnpjEstablishment.findUniqueOrThrow({ where: { cnpj: '91111111000100' } })).phoneShared, 1, 'recalculado na importação');
  assert.equal(await prisma.cnpjEstablishment.count({ where: { uf: 'ZZ' } }), 4);
});

test('base legal da campanha', () => {
  const kw = ['SAIR', 'PARAR'];
  assert.match(legalBasisProblem({ consentConfirmed: true, legalBasis: null, body: 'Oi' }, kw)!, /base legal/);
  assert.match(legalBasisProblem({ consentConfirmed: false, legalBasis: 'CONSENT', body: 'Oi' }, kw)!, /Confirme/);
  assert.equal(legalBasisProblem({ consentConfirmed: true, legalBasis: 'CONSENT', body: 'Oi' }, kw), null);
  assert.match(legalBasisProblem({ consentConfirmed: true, legalBasis: 'LEGITIMATE_INTEREST', body: 'Oi, vocês vendem para o governo?' }, kw)!, /como sair/);
  assert.equal(legalBasisProblem({ consentConfirmed: true, legalBasis: 'LEGITIMATE_INTEREST', body: 'Oi! Se não quiser receber, responda "sair".' }, kw), null);
  assert.match(legalBasisProblem({ consentConfirmed: true, legalBasis: 'LEGITIMATE_INTEREST', body: 'Não vamos te deixar sairmos' }, kw)!, /como sair/, 'palavra inteira');
});
