import { env } from '../config/env.js';

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: env.APP_TIMEZONE });

/** Dia civil no fuso da aplicação, como Date à meia-noite UTC (coluna @db.Date). */
export function localDay(date = new Date()): Date {
  return new Date(`${dayFmt.format(date)}T00:00:00.000Z`);
}
