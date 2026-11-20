export interface CnpjFilters {
  uf: string;
  municipios: string[];
  bairro: string;
  cep: string;
  ddds: string[];
  cnaes: string[];
  includeSecondary: boolean;
  naturezas: string[];
  portes: string[];
  capitalMin: string;
  capitalMax: string;
  mei: 'any' | 'only' | 'exclude';
  matriz: 'any' | 'matriz' | 'filial';
  phone: 'mobile' | 'any' | 'fixed';
  withEmail: boolean;
  q: string;
  name: string;
  hideSharedPhones: boolean;
  hideKnown: boolean;
}

export const DEFAULT_FILTERS: CnpjFilters = {
  uf: 'PR',
  municipios: [],
  bairro: '',
  cep: '',
  ddds: [],
  cnaes: [],
  includeSecondary: false,
  naturezas: [],
  portes: [],
  capitalMin: '',
  capitalMax: '',
  mei: 'exclude',
  matriz: 'matriz',
  phone: 'mobile',
  withEmail: false,
  q: '',
  name: '',
  hideSharedPhones: true,
  hideKnown: true,
};

/** Formulário → corpo aceito pela API (campos vazios saem). */
export function toApiFilters(f: CnpjFilters) {
  const num = (s: string) => (s.trim() ? Number(s.replace(/\./g, '').replace(',', '.')) : undefined);
  return {
    ...f,
    bairro: f.bairro.trim() || undefined,
    cep: f.cep.replace(/\D/g, '') || undefined,
    q: f.q.trim() || undefined,
    name: f.name.trim() || undefined,
    capitalMin: num(f.capitalMin),
    capitalMax: num(f.capitalMax),
  };
}

export interface CnpjRow {
  cnpj: string;
  isMatriz: boolean;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  porte: string | null;
  isMei: boolean | null;
  capitalSocial: number | null;
  cnaePrincipal: string;
  cnaeDescricao: string | null;
  uf: string;
  municipio: string | null;
  bairro: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  phoneShared: number;
}

export interface CnpjImportRun {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  ufs: string[];
  source: string | null;
  competencia: string | null;
  progress: string | null;
  stats: Record<string, number | string[]> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CnpjStatus {
  ufs: { uf: string; total: number; mobile: number }[];
  imports: CnpjImportRun[];
  allUfs: string[];
}

export const PORTES: [string, string][] = [
  ['01', 'Microempresa'],
  ['03', 'Pequeno porte'],
  ['05', 'Demais'],
  ['00', 'Não informado'],
];

export const formatCnpj = (c: string) => (c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c);
export const formatCnae = (c: string) => (c.length === 7 ? `${c.slice(0, 4)}-${c.slice(4, 5)}/${c.slice(5)}` : c);
export const money = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
