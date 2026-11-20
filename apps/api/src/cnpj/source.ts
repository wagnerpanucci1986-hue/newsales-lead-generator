import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { FILE_GROUPS, REQUIRED_HELP, type FileGroup } from './layout.js';

/** De onde vêm os ZIPs da Receita. `fetch` devolve um caminho local; `release` limpa o que foi baixado. */
export interface CnpjSource {
  label: string;
  competencia: string | null;
  files: string[];
  fetch(name: string, onProgress?: (bytes: number) => void): Promise<string>;
  release(localPath: string): Promise<void>;
}

export const filesOf = (source: CnpjSource, group: FileGroup) =>
  source.files.filter((f) => FILE_GROUPS[group].test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const tmpDir = () => env.CNPJ_TMP_DIR ?? path.join(os.tmpdir(), 'cnpj');

async function download(url: string, headers: Record<string, string>, onProgress?: (bytes: number) => void): Promise<string> {
  await mkdir(tmpDir(), { recursive: true });
  const target = path.join(tmpDir(), `${Date.now()}-${path.basename(new URL(url).pathname)}`);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}) em ${url}`);
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    onProgress?.(bytes);
  });
  try {
    await pipeline(body, createWriteStream(target));
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  }
  return target;
}

/** Pasta com os ZIPs baixados à mão pelo navegador. */
export async function localSource(dir = env.CNPJ_LOCAL_DIR): Promise<CnpjSource | null> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const zips = files.filter((f) => f.toLowerCase().endsWith('.zip'));
  if (!zips.some((f) => FILE_GROUPS.estabelecimentos.test(f))) return null;
  return {
    label: `pasta local (${dir})`,
    competencia: null,
    files: zips,
    fetch: async (name) => path.join(dir, name),
    release: async () => undefined,
  };
}

/** Pastas AAAA-MM numa listagem HTML, da mais recente para a mais antiga. */
export function parseMonthFolders(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href="(?:[^"]*\/)?(\d{4}-\d{2})\/?"/g)) found.add(m[1]!);
  return [...found].sort().reverse();
}

/** Arquivos .zip numa listagem HTML. */
export function parseZipLinks(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href="(?:[^"]*\/)?([^"/?#]+\.zip)"/gi)) found.add(decodeURIComponent(m[1]!));
  return [...found];
}

/** Listagem clássica de diretório da Receita (…/dados_abertos_cnpj/AAAA-MM/Arquivo.zip). */
export async function listingSource(baseUrl = env.CNPJ_LISTING_URL): Promise<CnpjSource> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const res = await fetch(base, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`listagem respondeu ${res.status}`);
  const [latest] = parseMonthFolders(await res.text());
  if (!latest) throw new Error('nenhuma pasta AAAA-MM na listagem');
  const folder = `${base}${latest}/`;
  const files = parseZipLinks(await (await fetch(folder, { signal: AbortSignal.timeout(30_000) })).text());
  if (!files.some((f) => FILE_GROUPS.estabelecimentos.test(f))) throw new Error(`pasta ${latest} sem arquivos de Estabelecimentos`);
  return {
    label: `Receita Federal (${folder})`,
    competencia: latest,
    files,
    fetch: (name, onProgress) => download(`${folder}${encodeURIComponent(name)}`, {}, onProgress),
    release: (p) => rm(p, { force: true }),
  };
}

/** Itens (href) de uma resposta PROPFIND do WebDAV. */
export function parsePropfind(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi)].map((m) => decodeURIComponent(m[1]!));
}

/** Compartilhamento público do Nextcloud da Receita, lido por WebDAV (usuário = token do link). */
export async function nextcloudSource(baseUrl = env.CNPJ_NEXTCLOUD_URL, token = env.CNPJ_NEXTCLOUD_TOKEN): Promise<CnpjSource> {
  const dav = `${baseUrl.replace(/\/$/, '')}/public.php/webdav/`;
  const auth = { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` };
  const propfind = async (url: string) => {
    const res = await fetch(url, { method: 'PROPFIND', headers: { ...auth, Depth: '1' }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 207) throw new Error(`WebDAV respondeu ${res.status}`);
    return parsePropfind(await res.text());
  };
  const months = (await propfind(dav))
    .map((h) => h.replace(/\/$/, '').split('/').pop()!)
    .filter((n) => /^\d{4}-\d{2}$/.test(n))
    .sort()
    .reverse();
  const latest = months[0];
  if (!latest) throw new Error('compartilhamento sem pastas AAAA-MM');
  const files = (await propfind(`${dav}${latest}/`)).map((h) => h.split('/').pop()!).filter((n) => n.toLowerCase().endsWith('.zip'));
  if (!files.some((f) => FILE_GROUPS.estabelecimentos.test(f))) throw new Error(`pasta ${latest} sem arquivos de Estabelecimentos`);
  return {
    label: `Receita Federal (compartilhamento ${latest})`,
    competencia: latest,
    files,
    fetch: (name, onProgress) => download(`${dav}${latest}/${encodeURIComponent(name)}`, auth, onProgress),
    release: (p) => rm(p, { force: true }),
  };
}

/** Escolhe a origem: pasta local primeiro (garantida), depois as duas da Receita. */
export async function resolveSource(): Promise<CnpjSource> {
  const local = await localSource();
  if (local) return local;
  const errors: string[] = [];
  for (const [name, attempt] of [
    ['listagem da Receita', () => listingSource()],
    ['compartilhamento da Receita', () => nextcloudSource()],
  ] as const) {
    try {
      return await attempt();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      logger.warn({ err: msg }, `origem dos dados do CNPJ indisponível (${name})`);
    }
  }
  throw new Error(
    `Não consegui baixar os arquivos da Receita automaticamente (${errors.join('; ')}). ` +
      `Baixe pelo navegador ${REQUIRED_HELP} e coloque na pasta "dados-cnpj" do sistema; depois clique em Atualizar de novo.`,
  );
}

export const fileSize = async (p: string) => (await stat(p)).size;
