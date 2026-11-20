// Normalização e validação de telefones. Formato interno: E.164 sem "+", só dígitos.
const VALID_DDD = new Set(
  '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '),
);

export type PhoneResult = { ok: true; phone: string; mobile: boolean } | { ok: false; reason: string };

/**
 * Aceita "(11) 98888-7777", "011 98888 7777", "+55 11 98888-7777", "5511988887777"…
 * Sem código de país, assume Brasil. Com "+" e outro país, só confere o tamanho.
 */
export function normalizePhone(input: unknown): PhoneResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'telefone vazio' };
  const international = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'telefone sem dígitos' };

  if (international && !digits.startsWith('55')) {
    return digits.length >= 8 && digits.length <= 15 ? { ok: true, phone: digits, mobile: true } : { ok: false, reason: 'tamanho inválido para número internacional' };
  }

  digits = digits.replace(/^0+/, ''); // prefixo de discagem (0, 0xx)
  if (digits.length === 12 || digits.length === 13) {
    if (!digits.startsWith('55')) return { ok: false, reason: 'código de país diferente de 55' };
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return { ok: false, reason: 'quantidade de dígitos inválida (esperado DDD + número)' };

  const ddd = digits.slice(0, 2);
  const number = digits.slice(2);
  if (!VALID_DDD.has(ddd)) return { ok: false, reason: `DDD ${ddd} não existe` };
  if (number.length === 9) {
    if (!number.startsWith('9')) return { ok: false, reason: 'celular deve começar com 9' };
    return { ok: true, phone: `55${ddd}${number}`, mobile: true };
  }
  // 8 dígitos: fixo (2–5) ou celular antigo sem o 9 (6–9), que completamos.
  if (/^[2-5]/.test(number)) return { ok: true, phone: `55${ddd}${number}`, mobile: false };
  return { ok: true, phone: `55${ddd}9${number}`, mobile: true };
}
