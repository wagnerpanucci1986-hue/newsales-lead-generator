import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

let override: CreateMessage | null = null;
let client: Anthropic | null = null;

/** Só para testes: substitui a chamada à API da Anthropic. */
export function setModelForTests(fn: CreateMessage | null): void {
  override = fn;
}

export const hasApiKey = () => Boolean(override || env.ANTHROPIC_API_KEY);

/** Chamada à API de mensagens (beta, para o fallback do servidor em caso de recusa). */
export const createMessage: CreateMessage = (params) => {
  if (override) return override(params);
  if (!env.ANTHROPIC_API_KEY) throw new Error('Chave da API da Anthropic não configurada (ANTHROPIC_API_KEY no .env).');
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  return client.beta.messages.create(params);
};

/** Erros temporários (limite, sobrecarga, rede): vale tentar de novo mais tarde. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && (err.status === 529 || err.status >= 500);
}
