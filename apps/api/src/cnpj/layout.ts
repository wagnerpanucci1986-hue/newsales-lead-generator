// Layout dos arquivos de dados abertos do CNPJ (Receita Federal): CSV sem cabeçalho,
// separador ";", campos entre aspas, codificação ISO-8859-1. Índices das colunas usadas.
import { normalizePhone } from '../lib/phone.js';

export const EST = {
  cnpjBase: 0,
  cnpjOrdem: 1,
  cnpjDv: 2,
  matrizFilial: 3, // 1 = matriz, 2 = filial
  nomeFantasia: 4,
  situacao: 5, // 02 = ativa
  dataInicio: 10,
  cnaePrincipal: 11,
  cnaesSecundarios: 12, // separados por vírgula
  tipoLogradouro: 13,
  logradouro: 14,
  numero: 15,
  complemento: 16,
  bairro: 17,
  cep: 18,
  uf: 19,
  municipio: 20,
  ddd1: 21,
  telefone1: 22,
  ddd2: 23,
  telefone2: 24,
  email: 27,
} as const;

export const EMP = { cnpjBase: 0, razaoSocial: 1, naturezaJuridica: 2, capitalSocial: 4, porte: 5 } as const;
export const SIMPLES = { cnpjBase: 0, opcaoSimples: 1, exclusaoSimples: 3, opcaoMei: 4, exclusaoMei: 6 } as const;

/** Grupos de arquivos publicados pela Receita (nomes como Estabelecimentos0.zip … Estabelecimentos9.zip). */
export const FILE_GROUPS = {
  estabelecimentos: /^estabelecimentos\d*\.zip$/i,
  empresas: /^empresas\d*\.zip$/i,
  simples: /^simples\.zip$/i,
  municipios: /^municipios\.zip$/i,
  cnaes: /^cnaes\.zip$/i,
  naturezas: /^naturezas\.zip$/i,
} as const;
export type FileGroup = keyof typeof FILE_GROUPS;

export const REQUIRED_HELP =
  'Estabelecimentos0.zip a Estabelecimentos9.zip, Empresas0.zip a Empresas9.zip, Simples.zip, Municipios.zip, Cnaes.zip e Naturezas.zip';

export const PORTE_LABEL: Record<string, string> = { '00': 'Não informado', '01': 'Microempresa', '03': 'Pequeno porte', '05': 'Demais' };

const clean = (v: string | undefined) => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

/** AAAAMMDD → Date (null para vazio, "0" ou "00000000"). */
export function parseDate(v: string | undefined): Date | null {
  const s = (v ?? '').trim();
  if (!/^\d{8}$/.test(s) || s === '00000000') return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "1000,50" → 1000.5 */
export function parseCapital(v: string | undefined): number | null {
  const s = (v ?? '').trim().replace(/\./g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** DDD + número da Receita → telefone normalizado (aceita o número já com DDD no campo). */
export function parsePhone(ddd: string | undefined, numero: string | undefined): { phone: string; mobile: boolean } | null {
  const d = (ddd ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const n = (numero ?? '').replace(/\D/g, '');
  if (!n || /^0+$/.test(n)) return null;
  for (const candidate of [d + n, n]) {
    if (candidate.length < 10 || candidate.length > 11) continue;
    const r = normalizePhone(candidate);
    if (r.ok) return { phone: r.phone, mobile: r.mobile };
  }
  return null;
}

export interface EstablishmentRow {
  cnpj: string;
  cnpjBase: string;
  isMatriz: boolean;
  nomeFantasia: string | null;
  cnaePrincipal: string;
  cnaesSecundarios: string[];
  uf: string;
  municipioCodigo: string;
  bairro: string | null;
  cep: string | null;
  endereco: string | null;
  phone: string | null;
  mobile: string | null;
  hasMobile: boolean;
  email: string | null;
  dataInicio: Date | null;
}

/**
 * Linha de Estabelecimentos → registro, ou null se não interessa:
 * inativo, fora das UFs pedidas ou sem nenhum telefone válido.
 */
export function parseEstablishment(r: string[], ufs: Set<string>): EstablishmentRow | null {
  if (r.length < 28) return null;
  if (Number(r[EST.situacao]) !== 2) return null;
  const uf = (r[EST.uf] ?? '').trim().toUpperCase();
  if (!ufs.has(uf)) return null;

  const phones = [parsePhone(r[EST.ddd1], r[EST.telefone1]), parsePhone(r[EST.ddd2], r[EST.telefone2])].filter(
    (p): p is { phone: string; mobile: boolean } => p !== null,
  );
  if (!phones.length) return null;
  const mobile = phones.find((p) => p.mobile)?.phone ?? null;

  const base = (r[EST.cnpjBase] ?? '').trim();
  const cnpj = `${base}${(r[EST.cnpjOrdem] ?? '').trim()}${(r[EST.cnpjDv] ?? '').trim()}`.toUpperCase();
  if (cnpj.length !== 14) return null;

  const endereco = [
    [clean(r[EST.tipoLogradouro]), clean(r[EST.logradouro])].filter(Boolean).join(' '),
    clean(r[EST.numero]),
    clean(r[EST.complemento]),
  ]
    .filter(Boolean)
    .join(', ');
  const email = clean(r[EST.email])?.toLowerCase() ?? null;

  return {
    cnpj,
    cnpjBase: base.toUpperCase(),
    isMatriz: (r[EST.matrizFilial] ?? '').trim() === '1',
    nomeFantasia: clean(r[EST.nomeFantasia]),
    cnaePrincipal: (r[EST.cnaePrincipal] ?? '').trim(),
    cnaesSecundarios: (r[EST.cnaesSecundarios] ?? '').split(',').map((c) => c.trim()).filter(Boolean),
    uf,
    municipioCodigo: (r[EST.municipio] ?? '').trim(),
    bairro: clean(r[EST.bairro]),
    cep: clean(r[EST.cep])?.replace(/\D/g, '') || null,
    endereco: endereco || null,
    phone: phones[0]!.phone,
    mobile,
    hasMobile: Boolean(mobile),
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    dataInicio: parseDate(r[EST.dataInicio]),
  };
}

const KEEP_UPPER = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'S/A', 'SA', 'S.A.', 'S.A', 'MEI', 'CIA', 'II', 'III', 'IV', 'SS', 'SLU']);
const KEEP_LOWER = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'para', 'com']);

/** "PADARIA SAO JOAO DE DEUS LTDA" → "Padaria Sao Joao de Deus LTDA" (a Receita grava tudo em maiúsculas). */
export function titleCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      if (KEEP_UPPER.has(word.toUpperCase())) return word.toUpperCase();
      const lower = word.toLocaleLowerCase('pt-BR');
      if (i > 0 && KEEP_LOWER.has(lower)) return lower;
      return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
    })
    .join(' ');
}

export const formatCnpj = (c: string) =>
  c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c;
