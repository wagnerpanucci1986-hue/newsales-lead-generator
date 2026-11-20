// Mensagens de campanha: spintax {Olá|Oi|E aí} e variáveis {{nome}}.

export interface TemplateContact {
  name?: string | null;
  pushName?: string | null;
  company?: string | null;
  email?: string | null;
  phone: string;
  customFields?: unknown;
}

const VAR = /\{\{\s*([\p{L}\p{N}_ -]+?)\s*\}\}/gu;
const norm = (key: string) => key.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[\s-]+/g, '_');

/** Variáveis disponíveis para um contato (chaves sem acento, minúsculas). */
export function variablesOf(contact: TemplateContact): Record<string, string> {
  const name = (contact.name ?? contact.pushName ?? '').trim();
  const vars: Record<string, string> = {
    nome: name,
    primeiro_nome: name.split(/\s+/)[0] ?? '',
    empresa: contact.company ?? '',
    email: contact.email ?? '',
    telefone: contact.phone,
  };
  if (contact.customFields && typeof contact.customFields === 'object') {
    for (const [k, v] of Object.entries(contact.customFields as Record<string, unknown>)) {
      if (v !== null && v !== undefined) vars[norm(k)] ??= String(v);
    }
  }
  return vars;
}

/** Resolve o spintax de dentro para fora, sorteando uma opção por grupo. Não toca em {{variáveis}}. */
export function spin(text: string, random: () => number = Math.random): string {
  const HOLD_OPEN = '\u0001';
  const HOLD_CLOSE = '\u0002';
  // Protege as variáveis para que {{nome}} não seja lido como grupo de spintax.
  let out = text.replace(/\{\{/g, HOLD_OPEN).replace(/\}\}/g, HOLD_CLOSE);
  const group = /\{([^{}]*)\}/;
  for (let i = 0; i < 200; i++) {
    const m = group.exec(out);
    if (!m) break;
    const options = m[1]!.split('|');
    const pick = options[Math.min(options.length - 1, Math.floor(random() * options.length))]!;
    out = out.slice(0, m.index) + pick + out.slice(m.index + m[0].length);
  }
  return out.replaceAll(HOLD_OPEN, '{{').replaceAll(HOLD_CLOSE, '}}');
}

/** Texto final para um contato: spintax primeiro, depois variáveis (valor ausente vira vazio). */
export function renderTemplate(body: string, contact: TemplateContact, random: () => number = Math.random): string {
  const vars = variablesOf(contact);
  return spin(body, random)
    .replace(VAR, (_m, key: string) => vars[norm(key)] ?? '')
    .replace(/[ \t]+([,.!?;:])/g, '$1') // "Olá , tudo bem" quando o nome está vazio
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Variáveis usadas no texto, normalizadas (para avisar sobre as que não existem). */
export function usedVariables(body: string): string[] {
  return [...new Set([...body.matchAll(VAR)].map((m) => norm(m[1]!)))];
}

export const BUILTIN_VARIABLES = ['nome', 'primeiro_nome', 'empresa', 'email', 'telefone'];
export const normalizeVariableKey = norm;
