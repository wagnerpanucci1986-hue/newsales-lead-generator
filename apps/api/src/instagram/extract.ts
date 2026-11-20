import { normalizePhone } from '../lib/phone.js';

const USERNAME = /^[a-z0-9._]{1,30}$/;

/**
 * Lê os perfis digitados pelo usuário: "@loja", "loja", "instagram.com/loja",
 * "https://www.instagram.com/loja/?igsh=…", separados por linha, vírgula ou espaço.
 * Devolve usernames únicos em minúsculas e o que não deu para entender.
 */
export function parseUsernames(input: string): { usernames: string[]; invalid: string[] } {
  const usernames = new Set<string>();
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    let u = raw;
    const url = /instagram\.com\/([^/?#\s]+)/i.exec(raw);
    if (url) u = url[1]!;
    u = u.replace(/^@/, '').replace(/\/$/, '').toLowerCase();
    if (USERNAME.test(u) && !['p', 'reel', 'reels', 'explore', 'stories'].includes(u)) usernames.add(u);
    else invalid.push(raw);
  }
  return { usernames: [...usernames], invalid };
}

// Links de WhatsApp: wa.me/5543999998888, api.whatsapp.com/send?phone=…, whatsapp.com/send/?phone=…
const WA_LINK = /(?:wa\.me\/|whatsapp\.com\/send\/?\?(?:[^\s]*&)?phone=)\+?(\d{10,15})/gi;
// Telefone escrito: (43) 99999-8888, 43 9 9999 8888, +55 43 99999.8888… Sem dígito colado
// antes ou depois, para não pegar pedaço de CNPJ ou CEP.
const PHONE_TEXT = /(?<![\d/.])(?:\+?55[\s.-]?)?\(?0?[1-9]\d\)?[\s.-]?9?[\s.]?\d{4}[\s.-]?\d{4}(?![\d/])/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Telefones (celulares primeiro) e e-mails escritos na bio ou no link do perfil. */
export function extractContacts(...texts: (string | null | undefined)[]): { phones: string[]; emails: string[] } {
  const text = texts.filter(Boolean).join('\n');
  const mobile = new Set<string>();
  const fixed = new Set<string>();
  const add = (raw: string) => {
    const r = normalizePhone(raw.startsWith('55') && raw.length >= 12 ? `+${raw}` : raw);
    if (r.ok) (r.mobile ? mobile : fixed).add(r.phone);
  };
  for (const m of text.matchAll(WA_LINK)) add(m[1]!);
  for (const m of text.matchAll(PHONE_TEXT)) add(m[0]);
  const emails = [...new Set([...text.matchAll(EMAIL)].map((m) => m[0].toLowerCase()))].filter((e) => !e.endsWith('.png') && !e.endsWith('.jpg'));
  return { phones: [...mobile, ...[...fixed].filter((p) => !mobile.has(p))], emails };
}
