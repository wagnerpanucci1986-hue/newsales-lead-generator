import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

export const cnpjFiltersSchema = z.object({
  uf: z.string().trim().length(2).transform((u) => u.toUpperCase()),
  municipios: z.array(z.string().trim().min(1).max(10)).max(100).default([]),
  bairro: z.string().trim().max(80).optional(),
  cep: z.string().trim().regex(/^\d{1,8}$/, 'CEP: só números').optional().or(z.literal('')),
  ddds: z.array(z.string().regex(/^\d{2}$/)).max(30).default([]),
  cnaes: z.array(z.string().regex(/^\d{7}$/, 'CNAE com 7 dígitos')).max(50).default([]),
  includeSecondary: z.boolean().default(false),
  naturezas: z.array(z.string().trim().max(10)).max(30).default([]),
  portes: z.array(z.enum(['00', '01', '03', '05'])).max(4).default([]),
  capitalMin: z.number().nonnegative().optional(),
  capitalMax: z.number().nonnegative().optional(),
  mei: z.enum(['any', 'only', 'exclude']).default('any'),
  matriz: z.enum(['any', 'matriz', 'filial']).default('any'),
  phone: z.enum(['mobile', 'any', 'fixed']).default('mobile'),
  withEmail: z.boolean().default(false),
  q: z.string().trim().max(100).optional(),
  // Esconde telefones usados por SHARED_PHONE_LIMIT ou mais empresas (em geral, o contador).
  hideSharedPhones: z.boolean().default(true),
  // Esconde quem já é contato ou está na lista de bloqueio.
  hideKnown: z.boolean().default(true),
});
export type CnpjFilters = z.infer<typeof cnpjFiltersSchema>;

export const SHARED_PHONE_LIMIT = 3;

// Telefone que vira o contato: celular se houver, senão o primeiro telefone.
const CONTACT_PHONE = Prisma.sql`COALESCE(e."mobile", e."phone")`;

export function cnpjWhere(f: CnpjFilters): Prisma.Sql {
  const and: Prisma.Sql[] = [Prisma.sql`e."uf" = ${f.uf}`];
  if (f.municipios.length) and.push(Prisma.sql`e."municipioCodigo" IN (${Prisma.join(f.municipios)})`);
  if (f.bairro) and.push(Prisma.sql`e."bairro" ILIKE ${`%${f.bairro}%`}`);
  if (f.cep) and.push(Prisma.sql`e."cep" LIKE ${`${f.cep}%`}`);
  if (f.ddds.length) and.push(Prisma.sql`substring(${CONTACT_PHONE} from 3 for 2) IN (${Prisma.join(f.ddds)})`);
  if (f.cnaes.length) {
    and.push(
      f.includeSecondary
        ? Prisma.sql`(e."cnaePrincipal" IN (${Prisma.join(f.cnaes)}) OR e."cnaesSecundarios" && ${f.cnaes}::text[])`
        : Prisma.sql`e."cnaePrincipal" IN (${Prisma.join(f.cnaes)})`,
    );
  }
  if (f.naturezas.length) and.push(Prisma.sql`c."naturezaJuridica" IN (${Prisma.join(f.naturezas)})`);
  if (f.portes.length) and.push(Prisma.sql`c."porte" IN (${Prisma.join(f.portes)})`);
  if (f.capitalMin !== undefined) and.push(Prisma.sql`c."capitalSocial" >= ${f.capitalMin}`);
  if (f.capitalMax !== undefined) and.push(Prisma.sql`c."capitalSocial" <= ${f.capitalMax}`);
  if (f.mei === 'only') and.push(Prisma.sql`c."isMei" = true`);
  if (f.mei === 'exclude') and.push(Prisma.sql`COALESCE(c."isMei", false) = false`);
  if (f.matriz === 'matriz') and.push(Prisma.sql`e."isMatriz" = true`);
  if (f.matriz === 'filial') and.push(Prisma.sql`e."isMatriz" = false`);
  if (f.phone === 'mobile') and.push(Prisma.sql`e."hasMobile" = true`);
  if (f.phone === 'fixed') and.push(Prisma.sql`e."hasMobile" = false`);
  if (f.withEmail) and.push(Prisma.sql`e."email" IS NOT NULL`);
  if (f.hideSharedPhones) and.push(Prisma.sql`e."phoneShared" < ${SHARED_PHONE_LIMIT}`);
  if (f.q) {
    const like = `%${f.q}%`;
    const digits = f.q.replace(/\D/g, '');
    and.push(
      Prisma.sql`(e."nomeFantasia" ILIKE ${like} OR c."razaoSocial" ILIKE ${like}${digits.length >= 4 ? Prisma.sql` OR e."cnpj" LIKE ${`%${digits}%`}` : Prisma.empty})`,
    );
  }
  if (f.hideKnown) {
    and.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."phone" = ${CONTACT_PHONE})`);
    and.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "BlacklistEntry" b WHERE b."phone" = ${CONTACT_PHONE})`);
  }
  return Prisma.join(and, ' AND ');
}

export interface CnpjResult {
  cnpj: string;
  isMatriz: boolean;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  porte: string | null;
  isMei: boolean | null;
  capitalSocial: number | null;
  naturezaJuridica: string | null;
  cnaePrincipal: string;
  cnaeDescricao: string | null;
  cnaesSecundarios: string[];
  uf: string;
  municipio: string | null;
  bairro: string | null;
  cep: string | null;
  endereco: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  dataInicio: Date | null;
  phoneShared: number;
}

const SELECT = Prisma.sql`
  SELECT e."cnpj", e."isMatriz", c."razaoSocial", e."nomeFantasia", c."porte", c."isMei", c."capitalSocial", c."naturezaJuridica",
         e."cnaePrincipal", cn."description" AS "cnaeDescricao", e."cnaesSecundarios", e."uf", e."municipio", e."bairro", e."cep",
         e."endereco", e."phone", e."mobile", e."email", e."dataInicio", e."phoneShared"
  FROM "CnpjEstablishment" e
  LEFT JOIN "CnpjCompany" c ON c."cnpjBase" = e."cnpjBase"
  LEFT JOIN "CnpjCnae" cn ON cn."code" = e."cnaePrincipal"`;

// Maiores capitais primeiro: em geral, empresas com mais estrutura para vender ao governo.
const ORDER = Prisma.sql`ORDER BY c."capitalSocial" DESC NULLS LAST, e."cnpj"`;

export async function searchCnpj(f: CnpjFilters, page: number, limit: number) {
  const where = cnpjWhere(f);
  const [rows, count] = await Promise.all([
    prisma.$queryRaw<CnpjResult[]>`${SELECT} WHERE ${where} ${ORDER} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "CnpjEstablishment" e LEFT JOIN "CnpjCompany" c ON c."cnpjBase" = e."cnpjBase" WHERE ${where}`,
  ]);
  return { total: Number(count[0]?.n ?? 0), rows };
}

/** Linhas para importar: as marcadas (cnpjs) ou as primeiras `limit` do filtro. */
export async function selectForImport(f: CnpjFilters, opts: { cnpjs?: string[]; limit: number }): Promise<CnpjResult[]> {
  const where = cnpjWhere(f);
  if (opts.cnpjs?.length) {
    return prisma.$queryRaw<CnpjResult[]>`${SELECT} WHERE e."cnpj" IN (${Prisma.join(opts.cnpjs)}) ${ORDER} LIMIT ${opts.limit}`;
  }
  return prisma.$queryRaw<CnpjResult[]>`${SELECT} WHERE ${where} ${ORDER} LIMIT ${opts.limit}`;
}
