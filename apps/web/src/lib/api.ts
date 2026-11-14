// Cliente da API. O access token fica só em memória; o refresh token é um cookie
// httpOnly que o JavaScript não lê. Ao recarregar a página, a sessão é retomada
// por /auth/refresh.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
export const getAccessToken = () => accessToken;

async function parse(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'Não foi possível concluir a operação');
  return body;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
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
