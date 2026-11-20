import { env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

// Cliente mínimo da Graph API da Meta para o Business Discovery do Instagram:
// a partir da conta profissional da empresa, lê dados públicos de OUTRAS contas
// comerciais ou de criador, uma por vez. Não lista seguidores nem traz telefone.

const SETTING_KEY = 'instagram.credentials';
const graphUrl = (path: string) => `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}`;

export interface InstagramConnection {
  igUserId: string;
  igUsername: string;
  pageName: string | null;
  connectedAt: string;
}
interface StoredCredentials extends InstagramConnection {
  token: string; // cifrado (AES-256-GCM)
}

/** Erro da Graph API traduzido para a tela. `kind` decide se a pesquisa continua. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'rate_limit' | 'auth' | 'other',
  ) {
    super(message);
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

function translate(body: GraphErrorBody, status: number): GraphError {
  const e = body.error ?? {};
  const code = e.code ?? 0;
  if (code === 190 || code === 102) {
    return new GraphError('O token da Meta expirou ou foi revogado. Gere um novo e conecte de novo em Configurações.', 'auth');
  }
  if ([4, 17, 32, 613, 80002].includes(code)) {
    return new GraphError('A Meta limitou as consultas desta conta por enquanto. Tente de novo em cerca de uma hora.', 'rate_limit');
  }
  if (code === 10 || code === 200) {
    return new GraphError(`Falta permissão no token (${e.message ?? 'permissão negada'}). Veja o passo a passo em docs/08-captacao-instagram.md.`, 'auth');
  }
  if (code === 110 || code === 100 || e.error_subcode === 2207013 || status === 404) {
    return new GraphError('Perfil não encontrado, privado ou pessoal. A Meta só mostra contas comerciais ou de criador.', 'not_found');
  }
  return new GraphError(`Erro da Meta: ${e.message ?? `HTTP ${status}`}`, 'other');
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const url = new URL(graphUrl(path));
  url.searchParams.set('access_token', token);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new GraphError(`Não foi possível falar com a Meta (${err instanceof Error ? err.message : String(err)}).`, 'other');
  }
  const body = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!res.ok || body.error) throw translate(body, res.status);
  return body;
}

interface PageWithIg {
  name?: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * Descobre a conta do Instagram ligada ao token. Aceita token de usuário ou de
 * usuário do sistema (lista as Páginas) e token de Página (a própria Página).
 * Com mais de uma conta, `preferUsername` escolhe.
 */
export async function discoverAccount(token: string, preferUsername?: string): Promise<InstagramConnection> {
  const fields = 'name,instagram_business_account{id,username}';
  const found: PageWithIg[] = [];
  try {
    const r = await graphGet<{ data?: PageWithIg[] }>(`me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, token);
    found.push(...(r.data ?? []));
  } catch (err) {
    if (err instanceof GraphError && err.kind === 'auth' && /expirou/.test(err.message)) throw err;
  }
  if (!found.some((p) => p.instagram_business_account)) {
    const me = await graphGet<PageWithIg>(`me?fields=${encodeURIComponent(fields)}`, token).catch(() => null);
    if (me) found.push(me);
  }
  const withIg = found.filter((p) => p.instagram_business_account);
  if (!withIg.length) {
    throw new GraphError('O token não dá acesso a nenhuma conta profissional do Instagram. Confira se o Instagram está ligado à Página do Facebook e se o token tem as permissões pedidas.', 'auth');
  }
  const want = preferUsername?.replace(/^@/, '').toLowerCase();
  const page = (want && withIg.find((p) => p.instagram_business_account!.username?.toLowerCase() === want)) || withIg[0]!;
  const ig = page.instagram_business_account!;
  return { igUserId: ig.id, igUsername: ig.username ?? ig.id, pageName: page.name ?? null, connectedAt: new Date().toISOString() };
}

export async function saveConnection(token: string, conn: InstagramConnection): Promise<void> {
  const value: StoredCredentials = { ...conn, token: encrypt(token) };
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: { ...value } }, update: { value: { ...value } } });
}

export async function removeConnection(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SETTING_KEY } });
}

/** Conexão sem o token (para a tela). */
export async function getConnection(): Promise<InstagramConnection | null> {
  const c = await loadCredentials();
  if (!c) return null;
  const { token: _token, ...conn } = c;
  return conn;
}

async function loadCredentials(): Promise<(StoredCredentials & { plainToken: string }) | null> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const v = row?.value as StoredCredentials | undefined;
  if (!v?.token || !v.igUserId) return null;
  try {
    return { ...v, plainToken: decrypt(v.token) };
  } catch {
    return null; // ENCRYPTION_KEY trocada: precisa conectar de novo
  }
}

export interface DiscoveredProfile {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  media?: { data?: { timestamp?: string }[] };
}

const DISCOVERY_FIELDS = 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(1){timestamp}';

/** Busca um perfil comercial pelo @. Lança GraphError. */
export async function businessDiscovery(username: string): Promise<DiscoveredProfile> {
  const creds = await loadCredentials();
  if (!creds) throw new GraphError('O Instagram ainda não está conectado. Conecte em Configurações → Instagram.', 'auth');
  const fields = `business_discovery.username(${username}){${DISCOVERY_FIELDS}}`;
  const r = await graphGet<{ business_discovery?: DiscoveredProfile }>(`${creds.igUserId}?fields=${encodeURIComponent(fields)}`, creds.plainToken);
  if (!r.business_discovery) throw new GraphError('Perfil não encontrado.', 'not_found');
  return r.business_discovery;
}
