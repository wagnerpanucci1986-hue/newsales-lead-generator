import type { User } from '@prisma/client';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import { authenticate, HttpError } from './guard.js';
import { ACCESS_TTL_S, REFRESH_COOKIE, REFRESH_TTL_S, signAccessToken } from './tokens.js';

const loginSchema = z.object({ email: z.email().transform((e) => e.toLowerCase().trim()), password: z.string().min(1).max(200) });

// Hash usado quando o e-mail não existe, para o tempo de resposta não revelar quais e-mails são válidos.
const DUMMY_HASH = await argon2.hash('senha-inexistente');

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: u.totpEnabled });

async function issueSession(user: User, req: FastifyRequest, reply: FastifyReply) {
  const refresh = randomToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      userAgent: req.headers['user-agent']?.slice(0, 300),
      ip: req.ip,
      expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
    },
  });
  reply.setCookie(REFRESH_COOKIE, refresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/api/auth',
    maxAge: REFRESH_TTL_S,
  });
  return { accessToken: signAccessToken({ sub: user.id, role: user.role }), expiresIn: ACCESS_TTL_S, user: publicUser(user) };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const valid = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !valid || !user.active) {
      await audit({ userId: user?.id, action: 'auth.login_failed', meta: { email }, ip: req.ip });
      throw new HttpError(401, 'E-mail ou senha inválidos');
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({ userId: user.id, action: 'auth.login', ip: req.ip });
    return issueSession(user, req, reply);
  });

  // Troca o refresh token (cookie) por um novo par. Cada refresh token só vale uma vez.
  app.post('/refresh', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new HttpError(401, 'Sessão expirada');
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!stored || stored.expiresAt < new Date() || !stored.user.active) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw new HttpError(401, 'Sessão expirada');
    }
    if (stored.revokedAt) {
      // Token já usado sendo apresentado de novo: possível roubo. Encerra todas as sessões do usuário.
      await prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit({ userId: stored.userId, action: 'auth.refresh_reuse', ip: req.ip });
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw new HttpError(401, 'Sessão expirada');
    }
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return issueSession(stored.user, req, reply);
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => ({ user: publicUser(req.user) }));
}
