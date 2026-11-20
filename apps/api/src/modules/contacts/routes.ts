import { Role, WaCheckStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { normalizePhone } from '../../lib/phone.js';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { contactsQueue } from '../../lib/queues.js';
import { BUILTIN_VARIABLES, normalizeVariableKey } from '../../lib/template.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.string().optional(),
  listId: z.string().optional(),
  waStatus: z.enum(WaCheckStatus).optional(),
  optedOut: z.enum(['1', '0']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const customFields = z.record(z.string().trim().min(1).max(40), z.string().max(500)).refine((o) => Object.keys(o).length <= 30, 'máximo de 30 campos personalizados');
const contactBody = z.object({
  phone: z.string(),
  name: z.string().trim().max(120).nullish(),
  company: z.string().trim().max(120).nullish(),
  email: z.email().max(200).nullish().or(z.literal('')),
  customFields: customFields.default({}),
  tagIds: z.array(z.string()).max(20).optional(),
  consentSource: z.string().trim().max(200).nullish(),
});
const bulkBody = z.object({
  ids: z.array(z.string()).min(1).max(5000),
  action: z.enum(['addTag', 'removeTag', 'addToList', 'removeFromList', 'delete']),
  tagId: z.string().optional(),
  listId: z.string().optional(),
});
const verifyBody = z.object({ numberId: z.string(), listId: z.string().optional() });

const include = { tags: { include: { tag: true } }, lists: { include: { list: { select: { id: true, name: true } } } } } satisfies Prisma.ContactInclude;
type Row = Prisma.ContactGetPayload<{ include: typeof include }>;
const dto = ({ tags, lists, ...c }: Row) => ({ ...c, tags: tags.map((t) => t.tag), lists: lists.map((l) => l.list) });

export function contactWhere(q: z.infer<typeof listQuery>): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [];
  if (q.q) {
    const contains = { contains: q.q, mode: 'insensitive' as const };
    const digits = q.q.replace(/\D/g, '');
    and.push({ OR: [{ name: contains }, { pushName: contains }, { company: contains }, { email: contains }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] });
  }
  if (q.tagId) and.push({ tags: { some: { tagId: q.tagId } } });
  if (q.listId) and.push({ lists: { some: { listId: q.listId } } });
  if (q.waStatus) and.push({ waStatus: q.waStatus });
  if (q.optedOut) and.push({ optedOutAt: q.optedOut === '1' ? { not: null } : null });
  return { AND: and };
}

/** Contatos: só Admin e Gestor (o atendente vê o contato pela conversa). */
export async function contactRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const where = contactWhere(q);
    const [total, rows] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, page: q.page, limit: q.limit, contacts: rows.map(dto) };
  });

  // Variáveis disponíveis para mensagens: as fixas e os campos personalizados existentes.
  app.get('/fields', async () => {
    const rows = await prisma.$queryRaw<{ key: string }[]>`
      SELECT DISTINCT jsonb_object_keys("customFields") AS key FROM "Contact" WHERE "customFields" <> '{}'::jsonb LIMIT 200`;
    const custom = [...new Set(rows.map((r) => normalizeVariableKey(r.key)))].filter((k) => !BUILTIN_VARIABLES.includes(k)).sort();
    return { builtin: BUILTIN_VARIABLES, custom };
  });

  app.post('/', async (req, reply) => {
    const body = contactBody.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone.ok) throw new HttpError(400, `Telefone inválido: ${phone.reason}`);
    try {
      const contact = await prisma.contact.create({
        data: {
          phone: phone.phone,
          name: body.name || null,
          company: body.company || null,
          email: body.email || null,
          customFields: body.customFields,
          consentSource: body.consentSource || null,
          consentAt: body.consentSource ? new Date() : null,
          tags: body.tagIds?.length ? { create: body.tagIds.map((tagId) => ({ tagId })) } : undefined,
        },
        include,
      });
      await audit({ userId: req.user.id, action: 'contact.create', entity: 'Contact', entityId: contact.id, ip: req.ip });
      return reply.code(201).send({ contact: dto(contact) });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe um contato com este telefone');
      throw err;
    }
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = contactBody.partial().parse(req.body);
    const data: Prisma.ContactUpdateInput = {};
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone);
      if (!phone.ok) throw new HttpError(400, `Telefone inválido: ${phone.reason}`);
      const current = await prisma.contact.findUnique({ where: { id }, select: { phone: true } });
      // Telefone novo: a verificação anterior no WhatsApp deixa de valer.
      if (current && current.phone !== phone.phone) Object.assign(data, { phone: phone.phone, waStatus: WaCheckStatus.UNKNOWN, waJid: null, waCheckedAt: null });
    }
    if (body.name !== undefined) data.name = body.name || null;
    if (body.company !== undefined) data.company = body.company || null;
    if (body.email !== undefined) data.email = body.email || null;
    if (body.customFields !== undefined) data.customFields = body.customFields;
    if (body.consentSource !== undefined) data.consentSource = body.consentSource || null;
    if (body.tagIds) data.tags = { deleteMany: {}, create: body.tagIds.map((tagId) => ({ tagId })) };
    try {
      const contact = await prisma.contact.update({ where: { id }, data, include });
      return { contact: dto(contact) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe um contato com este telefone');
      if ((err as { code?: string }).code === 'P2025') throw new HttpError(404, 'Contato não encontrado');
      throw err;
    }
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.contact.deleteMany({ where: { id } });
    await audit({ userId: req.user.id, action: 'contact.delete', entity: 'Contact', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/bulk', async (req) => {
    const b = bulkBody.parse(req.body);
    let affected = 0;
    switch (b.action) {
      case 'addTag':
      case 'removeTag': {
        if (!b.tagId) throw new HttpError(400, 'Informe a etiqueta');
        if (b.action === 'addTag') affected = (await prisma.contactTag.createMany({ data: b.ids.map((contactId) => ({ contactId, tagId: b.tagId! })), skipDuplicates: true })).count;
        else affected = (await prisma.contactTag.deleteMany({ where: { tagId: b.tagId, contactId: { in: b.ids } } })).count;
        break;
      }
      case 'addToList':
      case 'removeFromList': {
        if (!b.listId) throw new HttpError(400, 'Informe a lista');
        if (b.action === 'addToList') affected = (await prisma.contactListMember.createMany({ data: b.ids.map((contactId) => ({ contactId, listId: b.listId! })), skipDuplicates: true })).count;
        else affected = (await prisma.contactListMember.deleteMany({ where: { listId: b.listId, contactId: { in: b.ids } } })).count;
        break;
      }
      case 'delete':
        affected = (await prisma.contact.deleteMany({ where: { id: { in: b.ids } } })).count;
        break;
    }
    await audit({ userId: req.user.id, action: `contact.bulk_${b.action}`, meta: { count: b.ids.length, tagId: b.tagId, listId: b.listId }, ip: req.ip });
    return { affected };
  });

  // Checa no WhatsApp os contatos ainda não verificados. Feito em lotes pequenos e espaçados pelo worker.
  app.post('/verify', async (req, reply) => {
    const b = verifyBody.parse(req.body);
    const number = await prisma.waNumber.findFirst({ where: { id: b.numberId, deletedAt: null } });
    if (!number) throw new HttpError(404, 'Número não encontrado');
    if (number.status !== 'CONNECTED') throw new HttpError(409, 'O número escolhido precisa estar conectado');
    const pending = await prisma.contact.count({ where: { waStatus: WaCheckStatus.UNKNOWN, ...(b.listId ? { lists: { some: { listId: b.listId } } } : {}) } });
    if (pending) await contactsQueue.add('verify', { kind: 'verify', numberId: b.numberId, listId: b.listId });
    await audit({ userId: req.user.id, action: 'contact.verify', meta: { ...b, pending }, ip: req.ip });
    return reply.code(202).send({ pending });
  });
}
