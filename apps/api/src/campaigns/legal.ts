import { LegalBasis } from '@prisma/client';
import { normalizeKeyword } from './tracking.js';

/**
 * Regras de LGPD para iniciar uma campanha. Devolve o motivo do bloqueio, ou null se pode iniciar.
 * Legítimo interesse (prospecção B2B, ex.: base de CNPJ) exige ensinar a sair na própria mensagem.
 */
export function legalBasisProblem(c: { consentConfirmed: boolean; legalBasis: LegalBasis | null; body: string }, optOutKeywords: string[]): string | null {
  if (!c.legalBasis) return 'Escolha a base legal do público: consentimento ou legítimo interesse.';
  if (!c.consentConfirmed) return 'Confirme a base legal do público (LGPD) antes de iniciar.';
  if (c.legalBasis === LegalBasis.LEGITIMATE_INTEREST) {
    const words = ` ${normalizeKeyword(c.body)} `;
    const mentions = optOutKeywords.map(normalizeKeyword).some((k) => k && words.includes(` ${k} `));
    if (!mentions) {
      return `Com legítimo interesse, a mensagem precisa dizer como sair (ex.: "Se não quiser receber, responda ${optOutKeywords[0] ?? 'SAIR'}").`;
    }
  }
  return null;
}
