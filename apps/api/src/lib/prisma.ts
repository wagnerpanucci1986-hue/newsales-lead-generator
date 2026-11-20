import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** true se o erro é violação de chave única (corrida entre dois inserts). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
