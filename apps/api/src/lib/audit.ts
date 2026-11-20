import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

interface AuditInput {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Prisma.InputJsonValue;
  ip?: string;
}

/** Registra no log de auditoria. Nunca derruba a operação principal. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { ...input, userId: input.userId ?? null } });
  } catch (err) {
    logger.error({ err, action: input.action }, 'falha ao gravar auditoria');
  }
}
