import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from 'baileys';

export { isJidGroup, isLidUser, isPnUser };

/** Remove sufixo de aparelho (":12") e normaliza o servidor. */
export function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jidNormalizedUser(jid) || null;
}

/** Só chats individuais e grupos são espelhados (status, canais e listas de transmissão ficam de fora). */
export function isMirroredJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  return Boolean(isPnUser(jid) || isLidUser(jid) || isJidGroup(jid));
}

/** Telefone (só dígitos) de um JID de telefone; null para LID e grupo. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid || !isPnUser(jid)) return null;
  const user = jidDecode(jid)?.user;
  return user && /^\d{8,15}$/.test(user) ? user : null;
}

/**
 * Celulares do Brasil existem no WhatsApp com ou sem o 9º dígito, conforme a
 * idade da conta. Devolve as duas grafias para casar contato importado com JID.
 */
export function brPhoneVariants(phone: string): string[] {
  const variants = new Set([phone]);
  if (phone.startsWith('55')) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    if (rest.length === 9 && rest.startsWith('9')) variants.add(`55${ddd}${rest.slice(1)}`);
    if (rest.length === 8 && /^[6-9]/.test(rest)) variants.add(`55${ddd}9${rest}`);
  }
  return [...variants];
}
