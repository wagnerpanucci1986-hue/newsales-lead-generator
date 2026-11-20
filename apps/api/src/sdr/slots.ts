// Horários livres para reunião: regras da agenda (dias, faixa, duração, antecedência)
// menos os períodos ocupados de cada consultor no Google Agenda.

export interface MeetingRules {
  timezone: string;
  days: number[]; // 0=dom … 6=sáb
  start: string; // "HH:MM"
  end: string;
  minutes: number;
  minNoticeHours: number;
  stepMinutes?: number;
}

export interface Busy {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  consultantEmail: string;
  consultantName: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Diferença (ms) entre o relógio do fuso e UTC no instante `at`. */
function offsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instante UTC de uma data e hora locais no fuso (ex.: 2026-11-24 10:00 em São Paulo). */
export function zonedTime(timezone: string, y: number, m: number, d: number, hhmm: string): Date {
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(timezone, new Date(guess));
  t = guess - offsetMs(timezone, new Date(t)); // ajuste perto da troca de horário
  return new Date(t);
}

/** Ano, mês, dia e dia da semana locais de um instante. */
export function localDate(timezone: string, at: Date): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday: WEEKDAYS.indexOf(get('weekday')) };
}

const overlaps = (a: Busy, b: Busy) => a.start < b.end && b.start < a.end;

/**
 * Próximos horários livres, em ordem, alternando consultores no mesmo horário
 * (o primeiro livre da lista leva). Até `max` horários, em no máximo `horizonDays` dias.
 */
export function freeSlots(
  rules: MeetingRules,
  consultants: { name: string; email: string; busy: Busy[] }[],
  now: Date,
  opts: { from?: Date; max?: number; horizonDays?: number } = {},
): Slot[] {
  const step = (rules.stepMinutes ?? 30) * 60_000;
  const earliest = new Date(Math.max(now.getTime() + rules.minNoticeHours * 3_600_000, opts.from?.getTime() ?? 0));
  const out: Slot[] = [];
  const max = opts.max ?? 6;
  let rotation = 0;
  for (let day = 0; day < (opts.horizonDays ?? 10) && out.length < max; day++) {
    const ref = new Date(earliest.getTime() + day * 86_400_000);
    const { y, m, d, weekday } = localDate(rules.timezone, ref);
    if (!rules.days.includes(weekday)) continue;
    const dayStart = zonedTime(rules.timezone, y, m, d, rules.start);
    const dayEnd = zonedTime(rules.timezone, y, m, d, rules.end);
    for (let t = dayStart.getTime(); t + rules.minutes * 60_000 <= dayEnd.getTime() && out.length < max; t += step) {
      if (t < earliest.getTime()) continue;
      const slot = { start: new Date(t), end: new Date(t + rules.minutes * 60_000) };
      // Mesmo horário duas vezes não ajuda o lead a escolher.
      if (out.some((s) => s.start.getTime() === t)) continue;
      const free = consultants.filter((c) => !c.busy.some((b) => overlaps(b, slot)));
      if (!free.length) continue;
      const c = free[rotation++ % free.length]!;
      out.push({ ...slot, consultantEmail: c.email, consultantName: c.name });
    }
  }
  return out;
}

/** Espalha a oferta: no máximo `perDay` horários por dia, para o lead ter dias diferentes. */
export function spreadSlots(slots: Slot[], timezone: string, perDay = 2): Slot[] {
  const count = new Map<string, number>();
  return slots.filter((s) => {
    const { y, m, d } = localDate(timezone, s.start);
    const key = `${y}-${m}-${d}`;
    const n = count.get(key) ?? 0;
    if (n >= perDay) return false;
    count.set(key, n + 1);
    return true;
  });
}

/** "terça, 24/11, às 10h30" no fuso informado. */
export function describeSlot(timezone: string, at: Date): string {
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, weekday: 'long' }).format(at).replace('-feira', '');
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit' }).format(at);
  const [h, mi] = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':');
  return `${weekday}, ${date}, às ${Number(h)}h${mi === '00' ? '' : mi}`;
}

/** Hora local (0–23) de um instante. */
export function localHour(timezone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}
