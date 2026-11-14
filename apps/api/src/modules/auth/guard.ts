import { Role, type User } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyAccessToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Carrega o usuário a partir de um access token; null se inválido ou inativo. */
export async function userFromToken(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const payload = verifyAccessToken(token);
  if (!payload) return null;
  // Consulta o banco a cada requisição: desativar um usuário vale na hora.
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  return user?.active ? user : null;
}

/** preHandler: exige access token válido no cabeçalho Authorization. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const user = await userFromToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!user) throw new HttpError(401, 'Não autenticado');
  req.user = user;
}

/** preHandler: exige um dos perfis (use depois de `authenticate`). */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'Sem permissão para esta ação');
  };
}

/**
 * Números que o usuário enxerga: null = todos (Admin/Gestor);
 * para Atendente, só os atribuídos em UserNumberAccess.
 */
export async function accessibleNumberIds(user: Pick<User, 'id' | 'role'>): Promise<string[] | null> {
  if (user.role !== Role.AGENT) return null;
  const rows = await prisma.userNumberAccess.findMany({ where: { userId: user.id }, select: { numberId: true } });
  return rows.map((r) => r.numberId);
}
