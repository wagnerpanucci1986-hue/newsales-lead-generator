import { z } from 'zod';
import { isUniqueViolation, prisma } from '../lib/prisma.js';
import { HttpError } from './auth/guard.js';

/** Destino dos leads de captação: etiquetas existentes ou novas e uma lista (existente ou nova). */
export const destinationSchema = {
  tagIds: z.array(z.string()).max(20).default([]),
  newTags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  listId: z.string().nullish(),
  newListName: z.string().trim().min(1).max(80).nullish(),
};

export async function resolveDestination(b: { tagIds: string[]; newTags: string[]; listId?: string | null; newListName?: string | null }) {
  const tagIds = [...b.tagIds];
  for (const name of b.newTags) {
    const tag = await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
    tagIds.push(tag.id);
  }
  let listId = b.listId ?? null;
  if (b.newListName) {
    try {
      listId = (await prisma.contactList.create({ data: { name: b.newListName } })).id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma lista com este nome');
      throw err;
    }
  }
  return { tagIds: [...new Set(tagIds)], listId };
}
