import { MediaStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyMediaSignature } from '../../lib/media-url.js';
import { prisma } from '../../lib/prisma.js';
import { storage } from '../../lib/storage/index.js';
import { HttpError } from '../auth/guard.js';

const query = z.object({ exp: z.coerce.number(), sig: z.string().min(1), download: z.string().optional() });

// Tipos que o navegador pode exibir direto. O resto é sempre baixado como anexo,
// para que um HTML ou SVG enviado por um contato nunca rode na origem do painel.
const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/|video\/|application\/pdf$)/;

export async function mediaRoutes(app: FastifyInstance) {
  // Autorizado pela assinatura na URL (emitida só para quem pode ver a conversa).
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = query.parse(req.query);
    if (!verifyMediaSignature(id, q.exp, q.sig)) throw new HttpError(403, 'Link de mídia inválido ou expirado');

    const media = await prisma.media.findUnique({ where: { id } });
    if (!media?.storageKey || media.status !== MediaStatus.STORED) throw new HttpError(404, 'Mídia não disponível');

    const object = await storage.get(media.storageKey).catch(() => null);
    if (!object) throw new HttpError(404, 'Arquivo não encontrado no armazenamento');

    const mime = media.mimeType.split(';')[0]!.trim().toLowerCase();
    const inline = INLINE.test(mime) && !q.download;
    const name = encodeURIComponent(media.fileName ?? `arquivo-${media.id}`);
    reply
      .header('content-type', inline ? media.mimeType : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=3600');
    if (object.size !== undefined) reply.header('content-length', object.size);
    return reply.send(object.stream);
  });
}
