import { DAY_KEYS, type BusinessHours, type DayKey } from '@rag/shared';

const PT_DAY: Record<DayKey, string> = { sun: 'dom', mon: 'seg', tue: 'ter', wed: 'qua', thu: 'qui', fri: 'sex', sat: 'sáb' };

/** Dia da semana e minutos desde 00:00 no fuso do setor. */
function localParts(date: Date, tz: string): { day: DayKey; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = DAY_KEYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))]!;
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Sem horário configurado = sempre aberto. */
export function isOpen(hours: BusinessHours | null, at: Date): boolean {
  if (!hours) return true;
  const { day, minutes } = localParts(at, hours.tz);
  return (hours.days[day] ?? []).some(([from, to]) => minutes >= toMin(from) && minutes < toMin(to));
}

/** Ex.: "seg a sex, 08:00–18:00; sáb, 08:00–12:00". */
export function describeHours(hours: BusinessHours | null): string {
  if (!hours) return 'todos os dias';
  const groups: { days: DayKey[]; key: string }[] = [];
  for (const d of [1, 2, 3, 4, 5, 6, 0].map((i) => DAY_KEYS[i]!)) {
    const ranges = hours.days[d] ?? [];
    if (!ranges.length) continue;
    const key = ranges.map(([a, b]) => `${a}–${b}`).join(' e ');
    const last = groups.at(-1);
    if (last && last.key === key && DAY_KEYS.indexOf(last.days.at(-1)!) % 7 === (DAY_KEYS.indexOf(d) + 6) % 7) last.days.push(d);
    else groups.push({ days: [d], key });
  }
  if (!groups.length) return 'sem expediente configurado';
  return groups
    .map((g) => `${g.days.length > 1 ? `${PT_DAY[g.days[0]!]} a ${PT_DAY[g.days.at(-1)!]}` : PT_DAY[g.days[0]!]}, ${g.key}`)
    .join('; ');
}
