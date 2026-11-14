// Cliente da API. O access token fica só em memória; o refresh token é um cookie
// httpOnly que o JavaScript não lê. Ao recarregar a página, a sessão é retomada
// por /auth/refresh.
// Vazio = mesma origem (produção, atrás do proxy). Em desenvolvimento vem de apps/web/.env.development.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export type Role = 'ADMIN' | 'MANAGER' | 'AGENT';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** corpo da resposta de erro (ex.: twoFactorRequired no login) */
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
export const getAccessToken = () => accessToken;

async function parse(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Erros de validação trazem o motivo por campo; mostra os motivos em vez de só "Dados inválidos".
    const issues = Array.isArray(body.issues) ? (body.issues as { message: string }[]).map((i) => i.message).filter(Boolean) : [];
    const message = issues.length ? `${body.error}: ${[...new Set(issues)].join('; ')}` : (body.error ?? 'Não foi possível concluir a operação');
    throw new ApiError(res.status, message, body);
  }
  return body;
}

export async function login(email: string, password: string, code?: string): Promise<User> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, code: code || undefined }),
  });
  const body = await parse(res);
  accessToken = body.accessToken;
  return body.user;
}

// Várias chamadas podem expirar juntas; só um refresh por vez (o token é de uso único).
let refreshing: Promise<User | null> | null = null;
export function refreshSession(): Promise<User | null> {
  refreshing ??= fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const body = await res.json();
      accessToken = body.accessToken;
      return body.user as User;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
  accessToken = null;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  return parse(res);
}

/** Envio multipart (anexos). O navegador define o content-type com o boundary. */
export async function apiUpload<T = unknown>(path: string, form: FormData): Promise<T> {
  const send = () =>
    fetch(`${API_URL}/api${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: form,
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  return parse(res);
}

/** Guarda o access token devolvido por rotas que renovam a sessão (ex.: troca de senha). */
export function adoptAccessToken(token: string): void {
  accessToken = token;
}
