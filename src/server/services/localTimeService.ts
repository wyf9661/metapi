const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type StoredUtcDateTimeInput = string | number | Date | null | undefined;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatLocalDate(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

export function formatLocalDateTime(value: Date): string {
  return `${formatLocalDate(value)} ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
}

export function getResolvedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
}

export function formatUtcSqlDateTime(value: Date): string {
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`;
}

function parseEpochDateTime(raw: number): Date | null {
  if (!Number.isFinite(raw)) return null;
  if (raw > 1_000_000_000_000) {
    const parsed = new Date(Math.round(raw));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (raw > 1_000_000_000) {
    const parsed = new Date(Math.round(raw * 1000));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function parseStoredUtcDateTime(raw: StoredUtcDateTimeInput): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : new Date(raw.getTime());
  }
  if (typeof raw === 'number') {
    return parseEpochDateTime(raw);
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    const parsedNumeric = parseEpochDateTime(numeric);
    if (parsedNumeric) return parsedNumeric;
  }

  let parsed: Date;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    parsed = new Date(`${text.replace(' ', 'T')}Z`);
  } else {
    parsed = new Date(text);
  }

  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function toLocalDayKeyFromStoredUtc(raw: StoredUtcDateTimeInput): string | null {
  const parsed = parseStoredUtcDateTime(raw);
  if (!parsed) return null;
  return formatLocalDate(parsed);
}

export function getLocalHourAnchor(now = new Date()): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    0,
    0,
    0,
  );
}

export function toLocalHourBucketStartUtc(raw: StoredUtcDateTimeInput): string | null {
  const parsed = parseStoredUtcDateTime(raw);
  if (!parsed) return null;
  return formatUtcSqlDateTime(getLocalHourAnchor(parsed));
}

export function toLocalHourStartUtcFromStoredUtc(raw: StoredUtcDateTimeInput): string | null {
  return toLocalHourBucketStartUtc(raw);
}

export function toLocalDayStartUtcFromStoredUtc(raw: StoredUtcDateTimeInput): string | null {
  const parsed = parseStoredUtcDateTime(raw);
  if (!parsed) return null;
  return formatUtcSqlDateTime(
    new Date(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

export function getLocalDayKeyRangeUtc(dayKey: string): {
  startUtc: string;
  endUtc: string;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dayKey || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (![year, monthIndex, day].every(Number.isInteger)) return null;

  const startLocal = new Date(year, monthIndex, day, 0, 0, 0, 0);
  if (Number.isNaN(startLocal.getTime())) return null;
  const endLocal = new Date(startLocal.getTime() + DAY_MS);
  return {
    startUtc: formatUtcSqlDateTime(startLocal),
    endUtc: formatUtcSqlDateTime(endLocal),
  };
}

export function getLocalDayRangeUtc(now = new Date()): {
  localDay: string;
  startUtc: string;
  endUtc: string;
} {
  const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const nextLocalStart = new Date(localStart.getTime() + DAY_MS);
  return {
    localDay: formatLocalDate(now),
    startUtc: formatUtcSqlDateTime(localStart),
    endUtc: formatUtcSqlDateTime(nextLocalStart),
  };
}

export function getLocalRangeStartUtc(days: number, now = new Date()): string {
  const normalizedDays = Math.max(1, Math.floor(days || 1));
  const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const start = new Date(localStart.getTime() - (normalizedDays - 1) * DAY_MS);
  return formatUtcSqlDateTime(start);
}

export function getLocalRangeStartDayKey(days: number, now = new Date()): string {
  const normalizedDays = Math.max(1, Math.floor(days || 1));
  const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const start = new Date(localStart.getTime() - (normalizedDays - 1) * DAY_MS);
  return formatLocalDate(start);
}

export function getLocalHourRangeStartUtc(hours: number, now = new Date()): string {
  const normalizedHours = Math.max(1, Math.floor(hours || 1));
  const localAnchor = getLocalHourAnchor(now);
  const start = new Date(localAnchor.getTime() - (normalizedHours - 1) * HOUR_MS);
  return formatUtcSqlDateTime(start);
}

export function getUtcHourRangeFromStoredStart(hourStartUtc: string): {
  startUtc: string;
  endUtc: string;
} | null {
  const parsed = parseStoredUtcDateTime(hourStartUtc);
  if (!parsed) return null;
  return {
    startUtc: formatUtcSqlDateTime(parsed),
    endUtc: formatUtcSqlDateTime(new Date(parsed.getTime() + HOUR_MS)),
  };
}
