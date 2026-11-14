import { Prisma } from '@prisma/client';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

const CREDS = 'creds';

const serialize = (value: unknown) => encrypt(JSON.stringify(value, BufferJSON.replacer));
const deserialize = (valueEnc: string) => JSON.parse(decrypt(valueEnc), BufferJSON.reviver);

/**
 * Estado de autenticação do Baileys guardado no Postgres (tabela WaAuthKey),
 * cifrado com AES-256-GCM. Substitui o useMultiFileAuthState: a sessão sobrevive
 * a reinício e a troca de container sem depender de arquivos em disco.
 */
export async function usePostgresAuthState(numberId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const row = await prisma.waAuthKey.findUnique({
    where: { numberId_category_keyId: { numberId, category: CREDS, keyId: CREDS } },
  });
  const creds: AuthenticationCreds = row ? deserialize(row.valueEnc) : initAuthCreds();

  // Gravações de creds em série: o Baileys dispara creds.update em rajada.
  let saving: Promise<void> = Promise.resolve();
  const saveCreds = () => {
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        const valueEnc = serialize(creds);
        await prisma.waAuthKey.upsert({
          where: { numberId_category_keyId: { numberId, category: CREDS, keyId: CREDS } },
          create: { numberId, category: CREDS, keyId: CREDS, valueEnc },
          update: { valueEnc },
        });
      });
    return saving;
  };

  return {
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          if (!ids.length) return out;
          const rows = await prisma.waAuthKey.findMany({
            where: { numberId, category: type, keyId: { in: ids } },
          });
          for (const r of rows) {
            let value = deserialize(r.valueEnc);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[r.keyId] = value;
          }
          return out;
        },

        async set(data: SignalDataSet) {
          const upserts: Prisma.Sql[] = [];
          const deletes: { category: string; keyId: string }[] = [];
          for (const [category, entries] of Object.entries(data)) {
            for (const [keyId, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) deletes.push({ category, keyId });
              else upserts.push(Prisma.sql`(${numberId}, ${category}, ${keyId}, ${serialize(value)}, now())`);
            }
          }
          // Um único INSERT … ON CONFLICT por lote: o Baileys grava centenas de pre-keys de uma vez.
          await prisma.$transaction(async (tx) => {
            for (let i = 0; i < upserts.length; i += 500) {
              await tx.$executeRaw`
                INSERT INTO "WaAuthKey" ("numberId", "category", "keyId", "valueEnc", "updatedAt")
                VALUES ${Prisma.join(upserts.slice(i, i + 500))}
                ON CONFLICT ("numberId", "category", "keyId")
                DO UPDATE SET "valueEnc" = EXCLUDED."valueEnc", "updatedAt" = now()`;
            }
            for (const d of deletes) {
              await tx.waAuthKey.deleteMany({ where: { numberId, category: d.category, keyId: d.keyId } });
            }
          });
        },
      },
    },
    saveCreds,
  };
}

/** Apaga todas as credenciais do número (logout, sessão inválida, exclusão). */
export async function clearAuthState(numberId: string): Promise<void> {
  await prisma.waAuthKey.deleteMany({ where: { numberId } });
}
