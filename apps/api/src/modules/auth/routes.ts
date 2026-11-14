import type { User } from '@prisma/client';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import { generateRecoveryCodes, generateSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import { authenticate, HttpError } from './guard.js';
import { ACCESS_TTL_S, REFRESH_COOKIE, REFRESH_TTL_S, signAccessToken } from './tokens.js';

export const passwordSchema = z.string().min(10, 'a senha precisa ter ao menos 10 caracteres').max(200);
const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1).max(200),
  // código do autenticador (6 dígitos) ou um código de recuperação
  code: z.string().trim().max(20).optional(),
});

// Hash usado quando o e-mail não existe, para o tempo de resposta não revelar quais e-mails são válidos.
const DUMMY_HASH = await argon2.hash('senha-inexistente');

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: u.totpEnabled });
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

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
  // Seguro sempre que a requisição chegou por HTTPS (atrás do proxy, via X-Forwarded-Proto) ou se forçado no .env.
  const secure = env.COOKIE_SECURE || req.protocol === 'https';
  reply.setCookie(REFRESH_COOKIE, refresh, { httpOnly: true, sameSite: 'lax', secure, path: '/api/auth', maxAge: REFRESH_TTL_S });
  return { accessToken: signAccessToken({ sub: user.id, role: user.role }), expiresIn: ACCESS_TTL_S, user: publicUser(user) };
}

/** Confere o segundo fator: código do autenticador ou um código de recuperação (consumido no uso). */
async function checkSecondFactor(user: User, code: string): Promise<boolean> {
  if (!user.totpSecretEnc) return false;
  if (verifyTotp(decrypt(user.totpSecretEnc), code)) return true;
  const hash = sha256(normalizeRecovery(code));
  if (!user.totpRecoveryCodes.includes(hash)) return false;
  await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryCodes: user.totpRecoveryCodes.filter((h) => h !== hash) } });
  await audit({ userId: user.id, action: 'auth.recovery_code_used' });
  return true;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const { email, password, code } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const valid = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !valid || !user.active) {
      await audit({ userId: user?.id, action: 'auth.login_failed', meta: { email }, ip: req.ip });
      throw new HttpError(401, 'E-mail ou senha inválidos');
    }
    if (user.totpEnabled) {
      // Senha correta, falta o segundo fator: o painel mostra o campo do código.
      if (!code) return reply.code(401).send({ error: 'Informe o código do aplicativo autenticador', twoFactorRequired: true });
      if (!(await checkSecondFactor(user, code))) {
        await audit({ userId: user.id, action: 'auth.2fa_failed', ip: req.ip });
        return reply.code(401).send({ error: 'Código inválido', twoFactorRequired: true });
      }
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
    if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => ({ user: publicUser(req.user) }));

  // Troca de senha pelo próprio usuário. Encerra as outras sessões.
  app.post('/password', { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = z.object({ current: z.string().min(1).max(200), next: passwordSchema }).parse(req.body);
    if (!(await argon2.verify(req.user.passwordHash, body.current).catch(() => false))) throw new HttpError(400, 'Senha atual incorreta');
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await argon2.hash(body.next) } });
    await prisma.refreshToken.updateMany({ where: { userId: req.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ userId: req.user.id, action: 'auth.password_changed', ip: req.ip });
    return issueSession(req.user, req, reply); // mantém esta sessão ativa
  });

  // 2FA, passo 1: gera o segredo e devolve o endereço para o QR Code. Só passa a valer após /2fa/enable.
  app.post('/2fa/setup', { preHandler: authenticate }, async (req) => {
    if (req.user.totpEnabled) throw new HttpError(409, 'A verificação em duas etapas já está ativa');
    const secret = generateSecret();
    await prisma.user.update({ where: { id: req.user.id }, data: { totpSecretEnc: encrypt(secret) } });
    return { secret, otpauthUrl: otpauthUrl(secret, req.user.email) };
  });

  // 2FA, passo 2: confirma com um código do aplicativo e entrega os códigos de recuperação (mostrados uma única vez).
  app.post('/2fa/enable', { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(10) }).parse(req.body);
    if (req.user.totpEnabled) throw new HttpError(409, 'A verificação em duas etapas já está ativa');
    if (!req.user.totpSecretEnc || !verifyTotp(decrypt(req.user.totpSecretEnc), code)) throw new HttpError(400, 'Código inválido. Confira o horário do celular e tente de novo.');
    const recoveryCodes = generateRecoveryCodes();
    await prisma.user.update({ where: { id: req.user.id }, data: { totpEnabled: true, totpRecoveryCodes: recoveryCodes.map((c) => sha256(normalizeRecovery(c))) } });
    await audit({ userId: req.user.id, action: 'auth.2fa_enabled', ip: req.ip });
    return { recoveryCodes };
  });

  app.post('/2fa/disable', { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    const body = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) }).parse(req.body);
    if (!req.user.totpEnabled) throw new HttpError(409, 'A verificação em duas etapas não está ativa');
    if (!(await argon2.verify(req.user.passwordHash, body.password).catch(() => false))) throw new HttpError(400, 'Senha incorreta');
    if (!(await checkSecondFactor(req.user, body.code))) throw new HttpError(400, 'Código inválido');
    await prisma.user.update({ where: { id: req.user.id }, data: { totpEnabled: false, totpSecretEnc: null, totpRecoveryCodes: [] } });
    await audit({ userId: req.user.id, action: 'auth.2fa_disabled', ip: req.ip });
    return { ok: true };
  });
}
