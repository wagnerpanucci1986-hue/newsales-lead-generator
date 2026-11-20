import { CnpjImportStatus, Prisma } from '@prisma/client';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { EMP, parseCapital, parseDate, parseEstablishment, SIMPLES, type EstablishmentRow } from './layout.js';
import { SHARED_PHONE_LIMIT } from './search.js';
import { filesOf, resolveSource, type CnpjSource } from './source.js';
import { readZipCsv } from './zip-csv.js';

const BATCH = 1000;
const PROGRESS_EVERY = 200_000;

const progress = async (importId: string, text: string) => {
  await prisma.cnpjImport.update({ where: { id: importId }, data: { progress: text } }).catch(() => undefined);
  await publishEvent({ type: 'cnpj.updated', payload: { importId } });
};

const fmt = (n: number) => n.toLocaleString('pt-BR');

/** Baixa (se preciso) e lê cada arquivo de um grupo, liberando o espaço ao terminar. */
async function* eachRecord(source: CnpjSource, files: string[], label: (file: string, i: number) => string, importId: string) {
  for (const [i, file] of files.entries()) {
    let lastReport = 0;
    await progress(importId, `${label(file, i)}: baixando`);
    const local = await source.fetch(file, (bytes) => {
      if (bytes - lastReport >= 50 * 1024 * 1024) {
        lastReport = bytes;
        void progress(importId, `${label(file, i)}: baixando (${Math.round(bytes / 1024 / 1024)} MB)`);
      }
    });
    try {
      await progress(importId, `${label(file, i)}: lendo`);
      yield* readZipCsv(local);
    } finally {
      await source.release(local);
    }
  }
}

async function upsertLookup(table: 'CnpjCnae' | 'CnpjMunicipio' | 'CnpjNatureza', rows: [string, string][]) {
  const col = table === 'CnpjMunicipio' ? 'name' : 'description';
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map(([code, text]) => Prisma.sql`(${code}, ${text})`);
    await prisma.$executeRaw`
      INSERT INTO ${Prisma.raw(`"${table}"`)} ("code", ${Prisma.raw(`"${col}"`)}) VALUES ${Prisma.join(values)}
      ON CONFLICT ("code") DO UPDATE SET ${Prisma.raw(`"${col}" = EXCLUDED."${col}"`)}`;
  }
}

async function flushEstablishments(rows: (EstablishmentRow & { municipio: string | null })[], importId: string) {
  if (!rows.length) return;
  const values = rows.map(
    (r) => Prisma.sql`(${r.cnpj}, ${r.cnpjBase}, ${r.isMatriz}, ${r.nomeFantasia}, ${r.cnaePrincipal}, ${r.cnaesSecundarios}::text[],
      ${r.uf}, ${r.municipioCodigo}, ${r.municipio}, ${r.bairro}, ${r.cep}, ${r.endereco}, ${r.phone}, ${r.mobile},
      ${r.hasMobile}, ${r.email}, ${r.dataInicio}::date, ${importId})`,
  );
  await prisma.$executeRaw`
    INSERT INTO "CnpjEstablishment" ("cnpj","cnpjBase","isMatriz","nomeFantasia","cnaePrincipal","cnaesSecundarios","uf",
      "municipioCodigo","municipio","bairro","cep","endereco","phone","mobile","hasMobile","email","dataInicio","importId")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("cnpj") DO UPDATE SET
      "cnpjBase"=EXCLUDED."cnpjBase", "isMatriz"=EXCLUDED."isMatriz", "nomeFantasia"=EXCLUDED."nomeFantasia",
      "cnaePrincipal"=EXCLUDED."cnaePrincipal", "cnaesSecundarios"=EXCLUDED."cnaesSecundarios", "uf"=EXCLUDED."uf",
      "municipioCodigo"=EXCLUDED."municipioCodigo", "municipio"=EXCLUDED."municipio", "bairro"=EXCLUDED."bairro",
      "cep"=EXCLUDED."cep", "endereco"=EXCLUDED."endereco", "phone"=EXCLUDED."phone", "mobile"=EXCLUDED."mobile",
      "hasMobile"=EXCLUDED."hasMobile", "email"=EXCLUDED."email", "dataInicio"=EXCLUDED."dataInicio", "importId"=EXCLUDED."importId"`;
}

type CompanyRow = { base: string; razao: string; natureza: string | null; capital: number | null; porte: string | null };

async function flushCompanies(rows: CompanyRow[]) {
  if (!rows.length) return;
  const values = rows.map((r) => Prisma.sql`(${r.base}, ${r.razao}, ${r.natureza}, ${r.capital}, ${r.porte}, false, false)`);
  await prisma.$executeRaw`
    INSERT INTO "CnpjCompany" ("cnpjBase","razaoSocial","naturezaJuridica","capitalSocial","porte","isMei","isSimples")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("cnpjBase") DO UPDATE SET "razaoSocial"=EXCLUDED."razaoSocial", "naturezaJuridica"=EXCLUDED."naturezaJuridica",
      "capitalSocial"=EXCLUDED."capitalSocial", "porte"=EXCLUDED."porte", "isMei"=false, "isSimples"=false`;
}

async function flushSimples(rows: { base: string; mei: boolean; simples: boolean }[]) {
  if (!rows.length) return;
  const values = rows.map((r) => Prisma.sql`(${r.base}, ${r.mei}, ${r.simples})`);
  await prisma.$executeRaw`
    UPDATE "CnpjCompany" c SET "isMei" = v.mei, "isSimples" = v.simples
    FROM (VALUES ${Prisma.join(values)}) AS v(base, mei, simples) WHERE c."cnpjBase" = v.base`;
}

const active = (opcao: string | undefined, exclusao: string | undefined) => (opcao ?? '').trim().toUpperCase() === 'S' && !parseDate(exclusao);

/**
 * Atualiza a base de captação com as UFs pedidas: só estabelecimentos ativos e com
 * telefone. Idempotente: rodar de novo substitui os dados dessas UFs.
 */
export async function runCnpjImport(importId: string, sourceOverride?: CnpjSource): Promise<void> {
  const job = await prisma.cnpjImport.findUnique({ where: { id: importId } });
  if (!job || job.status !== CnpjImportStatus.RUNNING) return;
  const ufs = new Set(job.ufs.map((u) => u.toUpperCase()));
  const started = Date.now();
  const stats = { estabelecimentosLidos: 0, mantidos: 0, comCelular: 0, empresas: 0, mei: 0, removidos: 0, telefonesCompartilhados: 0, arquivos: [] as string[] };

  try {
    await progress(importId, 'Localizando os arquivos da Receita');
    const source = sourceOverride ?? (await resolveSource());
    await prisma.cnpjImport.update({ where: { id: importId }, data: { source: source.label, competencia: source.competencia } });
    const groups = {
      estabelecimentos: filesOf(source, 'estabelecimentos'),
      empresas: filesOf(source, 'empresas'),
      simples: filesOf(source, 'simples'),
      municipios: filesOf(source, 'municipios'),
      cnaes: filesOf(source, 'cnaes'),
      naturezas: filesOf(source, 'naturezas'),
    };
    if (!groups.empresas.length || !groups.municipios.length) {
      throw new Error('Faltam arquivos: são necessários ao menos Estabelecimentos, Empresas e Municipios.');
    }

    // 1) Tabelas de apoio (pequenas).
    const municipios = new Map<string, string>();
    for (const [group, table] of [['municipios', 'CnpjMunicipio'], ['cnaes', 'CnpjCnae'], ['naturezas', 'CnpjNatureza']] as const) {
      const rows: [string, string][] = [];
      for await (const r of eachRecord(source, groups[group], (f) => `Tabela ${f}`, importId)) {
        const code = (r[0] ?? '').trim();
        const text = (r[1] ?? '').trim();
        if (!code || !text) continue;
        rows.push([code, text]);
        if (group === 'municipios') municipios.set(code, text);
      }
      await upsertLookup(table, rows);
      stats.arquivos.push(...groups[group]);
    }

    // 2) Estabelecimentos: filtra ativos, UF e telefone.
    const bases = new Set<string>();
    let batch: (EstablishmentRow & { municipio: string | null })[] = [];
    const total = groups.estabelecimentos.length;
    for await (const r of eachRecord(source, groups.estabelecimentos, (f, i) => `Estabelecimentos ${i + 1} de ${total}`, importId)) {
      stats.estabelecimentosLidos++;
      if (stats.estabelecimentosLidos % PROGRESS_EVERY === 0) {
        await progress(importId, `Estabelecimentos: ${fmt(stats.estabelecimentosLidos)} lidos, ${fmt(stats.mantidos)} mantidos`);
      }
      const row = parseEstablishment(r, ufs);
      if (!row) continue;
      stats.mantidos++;
      if (row.hasMobile) stats.comCelular++;
      bases.add(row.cnpjBase);
      batch.push({ ...row, municipio: municipios.get(row.municipioCodigo) ?? null });
      if (batch.length >= BATCH) {
        await flushEstablishments(batch, importId);
        batch = [];
      }
    }
    await flushEstablishments(batch, importId);
    stats.arquivos.push(...groups.estabelecimentos);

    // 3) Empresas: só as que têm estabelecimento mantido.
    let companies: CompanyRow[] = [];
    for await (const r of eachRecord(source, groups.empresas, (f, i) => `Empresas ${i + 1} de ${groups.empresas.length}`, importId)) {
      const base = (r[EMP.cnpjBase] ?? '').trim().toUpperCase();
      if (!bases.has(base)) continue;
      companies.push({
        base,
        razao: (r[EMP.razaoSocial] ?? '').trim(),
        natureza: (r[EMP.naturezaJuridica] ?? '').trim() || null,
        capital: parseCapital(r[EMP.capitalSocial]),
        porte: (r[EMP.porte] ?? '').trim().padStart(2, '0') || null,
      });
      stats.empresas++;
      if (companies.length >= BATCH) {
        await flushCompanies(companies);
        companies = [];
      }
    }
    await flushCompanies(companies);
    stats.arquivos.push(...groups.empresas);

    // 4) Simples e MEI.
    let simples: { base: string; mei: boolean; simples: boolean }[] = [];
    for await (const r of eachRecord(source, groups.simples, () => 'Simples e MEI', importId)) {
      const base = (r[SIMPLES.cnpjBase] ?? '').trim().toUpperCase();
      if (!bases.has(base)) continue;
      const mei = active(r[SIMPLES.opcaoMei], r[SIMPLES.exclusaoMei]);
      if (mei) stats.mei++;
      simples.push({ base, mei, simples: active(r[SIMPLES.opcaoSimples], r[SIMPLES.exclusaoSimples]) });
      if (simples.length >= BATCH) {
        await flushSimples(simples);
        simples = [];
      }
    }
    await flushSimples(simples);
    stats.arquivos.push(...groups.simples);

    // 5) Remove o que saiu da base (baixadas, sem telefone) nas UFs atualizadas.
    await progress(importId, 'Removendo empresas que saíram da base');
    stats.removidos = await prisma.cnpjEstablishment.deleteMany({ where: { uf: { in: [...ufs] }, importId: { not: importId } } }).then((r) => r.count);
    await prisma.$executeRaw`DELETE FROM "CnpjCompany" c WHERE NOT EXISTS (SELECT 1 FROM "CnpjEstablishment" e WHERE e."cnpjBase" = c."cnpjBase")`;

    // 6) Telefones compartilhados: o mesmo número em várias empresas costuma ser do contador.
    await progress(importId, 'Marcando telefones compartilhados (contadores)');
    await prisma.$executeRaw`
      UPDATE "CnpjEstablishment" e SET "phoneShared" = s.n
      FROM (SELECT COALESCE("mobile", "phone") AS p, count(DISTINCT "cnpjBase")::int AS n FROM "CnpjEstablishment" GROUP BY 1) s
      WHERE COALESCE(e."mobile", e."phone") = s.p AND e."phoneShared" IS DISTINCT FROM s.n`;
    stats.telefonesCompartilhados = await prisma.cnpjEstablishment.count({ where: { uf: { in: [...ufs] }, phoneShared: { gte: SHARED_PHONE_LIMIT } } });

    await prisma.cnpjImport.update({
      where: { id: importId },
      data: { status: CnpjImportStatus.COMPLETED, finishedAt: new Date(), progress: 'Concluída', stats: { ...stats, segundos: Math.round((Date.now() - started) / 1000) } },
    });
    logger.info({ importId, ...stats, arquivos: stats.arquivos.length }, 'base de CNPJ atualizada');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, importId }, 'falha ao atualizar a base de CNPJ');
    await prisma.cnpjImport.update({
      where: { id: importId },
      data: { status: CnpjImportStatus.FAILED, finishedAt: new Date(), error: message.slice(0, 1000), stats },
    });
  } finally {
    await publishEvent({ type: 'cnpj.updated', payload: { importId } });
  }
}

/** Atualizações que ficaram "em andamento" porque o worker parou no meio. */
export async function failInterruptedCnpjImports(): Promise<void> {
  await prisma.cnpjImport.updateMany({
    where: { status: CnpjImportStatus.RUNNING },
    data: { status: CnpjImportStatus.FAILED, finishedAt: new Date(), error: 'Interrompida: o worker foi reiniciado durante a atualização. Rode de novo.' },
  });
}
