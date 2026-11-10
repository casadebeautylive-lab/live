/** Offset (ms) of a time zone at a given instant: local wall time − UTC. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** "YYYY-MM-DD" of an instant in a time zone. */
export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** UTC instant of local midnight for a "YYYY-MM-DD" day in a time zone. */
export function startOfLocalDay(tz: string, ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const first = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  // correct across DST transitions
  return new Date(guess.getTime() - tzOffsetMs(tz, first));
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type RangeKey = "today" | "yesterday" | "7d" | "30d" | "custom";

/** [from, to) in UTC for a named range in the account time zone. */
export function resolveRange(tz: string, key: RangeKey, from?: string, to?: string): { from: Date; to: Date; label: string } {
  const today = localDate(tz);
  switch (key) {
    case "today":
      return { from: startOfLocalDay(tz, today), to: startOfLocalDay(tz, addDays(today, 1)), label: "Today" };
    case "yesterday":
      return { from: startOfLocalDay(tz, addDays(today, -1)), to: startOfLocalDay(tz, today), label: "Yesterday" };
    case "30d":
      return { from: startOfLocalDay(tz, addDays(today, -29)), to: startOfLocalDay(tz, addDays(today, 1)), label: "Last 30 days" };
    case "custom": {
      const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(today, -6);
      const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;
      return { from: startOfLocalDay(tz, f), to: startOfLocalDay(tz, addDays(t, 1)), label: `${f} → ${t}` };
    }
    default:
      return { from: startOfLocalDay(tz, addDays(today, -6)), to: startOfLocalDay(tz, addDays(today, 1)), label: "Last 7 days" };
  }
}

/** "Oct 14, 8:42 PM" in the account time zone — used for auto-generated show titles. */
export function formatShowDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

/** UTC instant for a wall-clock "YYYY-MM-DDTHH:mm[:ss]" in a time zone (DST-safe). */
export function localToUtc(tz: string, local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) throw new Error("Invalid date/time");
  const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  const first = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  return new Date(guess.getTime() - tzOffsetMs(tz, first));
}

/** "YYYY-MM-DDTHH:mm" wall-clock of an instant in a time zone — value for <input type="datetime-local">. */
export function utcToLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
