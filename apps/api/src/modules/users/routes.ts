import { Role, type Prisma } from '@prisma/client';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';
import { passwordSchema } from '../auth/routes.js';

const base = {
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200).transform((e) => e.toLowerCase().trim()),
  role: z.enum(Role),
  // números que o atendente enxerga (ignorado para Admin e Gestor, que veem todos)
  numberIds: z.array(z.string()).max(10).default([]),
};
const createBody = z.object({ ...base, password: passwordSchema });
const updateBody = z.object({ ...base, password: passwordSchema.optional(), active: z.boolean().optional(), resetTwoFactor: z.boolean().optional() }).partial();

const include = { numberAccess: { select: { numberId: true } } } satisfies Prisma.UserInclude;
type Row = Prisma.UserGetPayload<{ include: typeof include }>;
const dto = (u: Row) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: u.active,
  totpEnabled: u.totpEnabled,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  numberIds: u.numberAccess.map((a) => a.numberId),
});

/** Sempre deve restar ao menos um administrador ativo. */
async function assertNotLastAdmin(userId: string) {
  const others = await prisma.user.count({ where: { role: Role.ADMIN, active: true, id: { not: userId } } });
  if (!others) throw new HttpError(409, 'Este é o único administrador ativo. Promova outro usuário antes.');
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Só nome e perfil: usado nos seletores de responsável das conversas.
  app.get('/assignable', async () => ({
    users: await prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
  }));

  const admin = { preHandler: requireRole(Role.ADMIN) };

  app.get('/', admin, async () => ({ users: (await prisma.user.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], include })).map(dto) }));

  app.post('/', admin, async (req, reply) => {
    const body = createBody.parse(req.body);
    try {
      const user = await prisma.user.create({
        data: {
          name: body.name,
          email: body.email,
          role: body.role,
          passwordHash: await argon2.hash(body.password),
          numberAccess: body.role === Role.AGENT ? { create: body.numberIds.map((numberId) => ({ numberId })) } : undefined,
        },
        include,
      });
      await audit({ userId: req.user.id, action: 'user.create', entity: 'User', entityId: user.id, meta: { email: user.email, role: user.role }, ip: req.ip });
      return reply.code(201).send({ user: dto(user) });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe um usuário com este e-mail');
      throw err;
    }
  });

  app.patch('/:id', admin, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateBody.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, 'Usuário não encontrado');

    const losingAdmin = current.role === Role.ADMIN && current.active && ((body.role && body.role !== Role.ADMIN) || body.active === false);
    if (losingAdmin) {
      if (id === req.user.id) throw new HttpError(409, 'Você não pode rebaixar nem desativar o próprio usuário');
      await assertNotLastAdmin(id);
    }

    const role = body.role ?? current.role;
    const data: Prisma.UserUpdateInput = { name: body.name, email: body.email, role: body.role, active: body.active };
    if (body.password) data.passwordHash = await argon2.hash(body.password);
    if (body.resetTwoFactor) Object.assign(data, { totpEnabled: false, totpSecretEnc: null, totpRecoveryCodes: [] });
    // Admin e Gestor veem todos os números; a lista de acessos só existe para atendentes.
    if (role !== Role.AGENT) data.numberAccess = { deleteMany: {} };
    else if (body.numberIds) data.numberAccess = { deleteMany: {}, create: body.numberIds.map((numberId) => ({ numberId })) };
    try {
      const user = await prisma.user.update({ where: { id }, data, include });
      // Senha trocada, desativação ou mudança de perfil: derruba as sessões abertas.
      if (body.password || body.active === false || (body.role && body.role !== current.role)) {
        await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await audit({
        userId: req.user.id,
        action: 'user.update',
        entity: 'User',
        entityId: id,
        meta: { role: body.role, active: body.active, passwordReset: Boolean(body.password), twoFactorReset: Boolean(body.resetTwoFactor), numberIds: body.numberIds },
        ip: req.ip,
      });
      return { user: dto(user) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe um usuário com este e-mail');
      throw err;
    }
  });
}
