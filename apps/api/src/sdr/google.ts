import { env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import type { Busy } from './slots.js';

// Google Agenda pela API REST (OAuth 2.0 com refresh token). Uma conta Google autorizada
// lê a disponibilidade dos consultores (free/busy) e cria os eventos com link do Meet.

const KEY = 'google.credentials';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];
const CAL = 'https://www.googleapis.com/calendar/v3';

interface Stored {
  clientId: string;
  clientSecret: string; // cifrado
  refreshToken?: string; // cifrado
  email?: string;
  connectedAt?: string;
}

export interface GoogleStatus {
  clientId: string | null;
  email: string | null;
  connectedAt: string | null;
  redirectUri: string;
}

export class GoogleError extends Error {}

export const redirectUri = () => `${env.WEB_URL.replace(/\/$/, '')}/api/google/callback`;

async function load(): Promise<Stored | null> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return (row?.value as Stored | undefined) ?? null;
}
async function save(v: Stored): Promise<void> {
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: { ...v } }, update: { value: { ...v } } });
  cachedToken = null;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const s = await load();
  return { clientId: s?.clientId ?? null, email: s?.refreshToken ? (s.email ?? null) : null, connectedAt: s?.refreshToken ? (s.connectedAt ?? null) : null, redirectUri: redirectUri() };
}

export async function saveClient(clientId: string, clientSecret: string): Promise<void> {
  await save({ clientId, clientSecret: encrypt(clientSecret) });
}

export async function disconnectGoogle(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY } });
  cachedToken = null;
}

export async function authUrl(state: string): Promise<string> {
  const s = await load();
  if (!s) throw new GoogleError('Cadastre primeiro o ID e a chave secreta do cliente OAuth.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // garante o refresh token mesmo em nova autorização
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string } & Record<string, unknown>;
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new GoogleError('A autorização do Google expirou ou foi revogada. Conecte de novo em SDR (IA) → Google Agenda.');
    throw new GoogleError(`Google recusou: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  return json as never;
}

/** Troca o código da tela de consentimento pelo refresh token e guarda a conta autorizada. */
export async function finishAuth(code: string): Promise<string> {
  const s = await load();
  if (!s) throw new GoogleError('Cliente OAuth não cadastrado.');
  const t = await tokenRequest({ code, client_id: s.clientId, client_secret: decrypt(s.clientSecret), redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new GoogleError('O Google não devolveu o refresh token. Remova o acesso do app na sua conta Google e conecte de novo.');
  // E-mail da conta: vem no id_token (JWT); só lemos o payload, a origem é a própria resposta do Google.
  let email: string | undefined;
  if (t.id_token) {
    try {
      email = JSON.parse(Buffer.from(t.id_token.split('.')[1]!, 'base64url').toString()).email;
    } catch {
      email = undefined;
    }
  }
  await save({ ...s, refreshToken: encrypt(t.refresh_token), email, connectedAt: new Date().toISOString() });
  cachedToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  return email ?? '';
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const s = await load();
  if (!s?.refreshToken) throw new GoogleError('O Google Agenda não está conectado.');
  const t = await tokenRequest({ refresh_token: decrypt(s.refreshToken), client_id: s.clientId, client_secret: decrypt(s.clientSecret), grant_type: 'refresh_token' });
  cachedToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  return t.access_token;
}

export async function googleConnected(): Promise<boolean> {
  return Boolean((await load())?.refreshToken);
}

async function calendarFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${CAL}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new GoogleError(`Google Agenda: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

/** Períodos ocupados de cada agenda. Agenda sem acesso volta como erro e é tratada como ocupada. */
export async function freeBusy(emails: string[], from: Date, to: Date): Promise<Map<string, Busy[] | 'erro'>> {
  const r = await calendarFetch<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>('/freeBusy', {
    method: 'POST',
    body: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: emails.map((id) => ({ id })) },
  });
  const out = new Map<string, Busy[] | 'erro'>();
  for (const email of emails) {
    const c = r.calendars?.[email];
    if (!c || c.errors?.length) out.set(email, 'erro');
    else out.set(email, (c.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })));
  }
  return out;
}

export interface CreatedEvent {
  id: string;
  link: string | null;
  htmlLink: string | null;
}

/** Cria a reunião na agenda principal da conta conectada, com Meet, e convida consultor e lead. */
export async function createMeeting(input: { start: Date; end: Date; summary: string; description: string; attendees: string[]; requestId: string }): Promise<CreatedEvent> {
  const ev = await calendarFetch<{ id: string; hangoutLink?: string; htmlLink?: string }>('/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
    method: 'POST',
    body: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
    },
  });
  return { id: ev.id, link: ev.hangoutLink ?? null, htmlLink: ev.htmlLink ?? null };
}
