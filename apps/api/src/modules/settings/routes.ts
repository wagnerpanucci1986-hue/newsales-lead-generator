import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { getSetting, setSetting, settingSchemas, type SettingKey } from '../../lib/settings.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const keys = Object.keys(settingSchemas) as SettingKey[];
const params = z.object({ key: z.enum(keys as [SettingKey, ...SettingKey[]]) });

/** Configurações globais: descadastro (opt-out) e parâmetros de anti-banimento. */
export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async () => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await getSetting(k)]))));

  app.put('/:key', async (req) => {
    const { key } = params.parse(req.params);
    if (req.user.role !== Role.ADMIN && (key === 'antiBan' || key === 'sdr')) throw new HttpError(403, key === 'sdr' ? 'Só administradores alteram a IA do SDR' : 'Só administradores alteram os parâmetros de anti-banimento');
    const value = await setSetting(key, req.body);
    await audit({ userId: req.user.id, action: 'settings.update', entity: 'Setting', entityId: key, meta: value as object, ip: req.ip });
    return { [key]: value };
  });
}
