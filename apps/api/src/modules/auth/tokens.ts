import type { Role } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
export const REFRESH_COOKIE = 'rt';

export interface AccessPayload {
  sub: string;
  role: Role;
}

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TTL_S, algorithm: 'HS256' });
}

/** Devolve o payload ou null se o token for inválido/expirado. */
export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || !decoded.sub) return null;
    return { sub: decoded.sub, role: decoded.role as Role };
  } catch {
    return null;
  }
}
