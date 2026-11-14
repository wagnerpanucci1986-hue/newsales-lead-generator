import type { Campaign, WaNumber } from '@prisma/client';
import { env } from '../config/env.js';
import type { SettingValue } from '../lib/settings.js';
import { localDay } from '../lib/time.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Dia da semana (0=dom) e hora "HH:MM" no fuso informado. */
function localClock(timezone: string, now: Date): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: WEEKDAYS.indexOf(get('weekday')), hhmm: `${get('hour').replace('24', '00')}:${get('minute')}` };
}

/** A campanha pode enviar agora? (dias da semana e faixa de horário, no fuso da campanha) */
export function inSendWindow(c: Pick<Campaign, 'timezone' | 'sendDays' | 'windowStart' | 'windowEnd'>, now = new Date()): boolean {
  let clock;
  try {
    clock = localClock(c.timezone, now);
  } catch {
    clock = localClock(env.APP_TIMEZONE, now); // fuso inválido gravado na campanha
  }
  if (!c.sendDays.includes(clock.weekday)) return false;
  if (c.windowStart === c.windowEnd) return true; // 24 horas
  return c.windowStart < c.windowEnd
    ? clock.hhmm >= c.windowStart && clock.hhmm < c.windowEnd
    : clock.hhmm >= c.windowStart || clock.hhmm < c.windowEnd; // janela que cruza a meia-noite
}

/**
 * Teto de disparos do número hoje. Com aquecimento, começa em `warmupStart`
 * e cresce `warmupGrowth` por dia desde o primeiro disparo, até o limite diário.
 */
export function dailyCap(number: Pick<WaNumber, 'dailyLimit' | 'warmupEnabled' | 'warmupStartedAt'>, antiBan: SettingValue<'antiBan'>, now = new Date()): number {
  if (!number.warmupEnabled) return number.dailyLimit;
  const start = number.warmupStartedAt ?? now;
  const days = Math.max(0, Math.round((localDay(now).getTime() - localDay(start).getTime()) / 86_400_000));
  return Math.min(number.dailyLimit, Math.round(antiBan.warmupStart * antiBan.warmupGrowth ** days));
}

/** Milissegundos até a meia-noite local (quando o limite diário zera). */
export function msUntilNextLocalDay(now = new Date()): number {
  return localDay(now).getTime() + 86_400_000 - (now.getTime() + offsetMs(now));
}

// Diferença entre o relógio local (APP_TIMEZONE) e UTC neste instante.
function offsetMs(now: Date): number {
  const local = new Date(now.toLocaleString('en-US', { timeZone: env.APP_TIMEZONE }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local.getTime() - utc.getTime();
}

export const randomBetween = (min: number, max: number, random: () => number = Math.random) => min + random() * Math.max(0, max - min);
