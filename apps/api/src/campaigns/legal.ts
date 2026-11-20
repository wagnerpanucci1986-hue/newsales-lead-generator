import { LegalBasis } from '@prisma/client';
import { normalizeKeyword } from './tracking.js';

/**
 * Regras de LGPD para iniciar uma campanha. Devolve o motivo do bloqueio, ou null se pode iniciar.
 * Legítimo interesse (prospecção B2B, ex.: base de CNPJ) exige ensinar a sair na própria mensagem.
 */
export function legalBasisProblem(c: { consentConfirmed: boolean; legalBasis: LegalBasis | null; body: string; variants?: string[] }, optOutKeywords: string[]): string | null {
  if (!c.legalBasis) return 'Escolha a base legal do público: consentimento ou legítimo interesse.';
  if (!c.consentConfirmed) return 'Confirme a base legal do público (LGPD) antes de iniciar.';
  if (c.legalBasis === LegalBasis.LEGITIMATE_INTEREST) {
    // Com variações aprovadas, cada uma é enviada no lugar do texto principal: todas precisam da frase.
    const texts = c.variants?.length ? c.variants : [c.body];
    const mentions = (t: string) => optOutKeywords.map(normalizeKeyword).some((k) => k && ` ${normalizeKeyword(t)} `.includes(` ${k} `));
    const missing = texts.findIndex((t) => !mentions(t));
    if (missing >= 0) {
      const which = c.variants?.length ? `A variação ${missing + 1}` : 'A mensagem';
      return `Com legítimo interesse, ${which.charAt(0).toLowerCase() + which.slice(1)} precisa dizer como sair (ex.: "Se não quiser receber, responda ${optOutKeywords[0] ?? 'SAIR'}").`;
    }
  }
  return null;
}
