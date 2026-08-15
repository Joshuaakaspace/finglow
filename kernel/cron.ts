export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) throw new CronParseError(`empty ${label} field`);

    const [rangePart, stepPart] = piece.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) throw new CronParseError(`bad ${label} step: ${piece}`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new CronParseError(`bad ${label} value: ${piece}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }

  if (values.size === 0) throw new CronParseError(`no values for ${label}`);
  return values;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronParseError(`expected 5 fields, got ${parts.length}: "${expression}"`);

  const [min, hour, dom, month, dow] = parts;
  const daysOfWeek = parseField(dow === "7" ? "0" : dow, 0, 7, "day-of-week");
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);

  return {
    minutes: parseField(min, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    daysOfMonth: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(month, 1, 12, "month"),
    daysOfWeek,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function dateMatches(fields: CronFields, local: Date): boolean {
  if (!fields.months.has(local.getUTCMonth() + 1)) return false;

  const domHit = fields.daysOfMonth.has(local.getUTCDate());
  const dowHit = fields.daysOfWeek.has(local.getUTCDay());

  // Standard cron: when both day fields are restricted the match is a union.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * Next firing at or after `fromMs`, exclusive. `timezoneOffsetMinutes` is the
 * offset applied to UTC to get the schedule's wall clock (e.g. -300 for EST).
 */
export function nextCronFire(expression: string, fromMs: number, timezoneOffsetMinutes = 0): number | null {
  const fields = parseCron(expression);
  const offsetMs = timezoneOffsetMinutes * MINUTE_MS;

  let cursor = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = fromMs + 366 * 4 * DAY_MS;

  while (cursor <= limit) {
    const local = new Date(cursor + offsetMs);

    if (!dateMatches(fields, local)) {
      // Jump to 00:00 local on the next day rather than stepping every minute.
      const startOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
      cursor = startOfDay + DAY_MS - offsetMs;
      continue;
    }

    if (!fields.hours.has(local.getUTCHours())) {
      const startOfHour = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        local.getUTCHours(),
      );
      cursor = startOfHour + 3_600_000 - offsetMs;
      continue;
    }

    if (fields.minutes.has(local.getUTCMinutes())) return cursor;
    cursor += MINUTE_MS;
  }

  return null;
}
