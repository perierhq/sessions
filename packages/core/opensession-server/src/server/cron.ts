// Minimal 5-field cron (UTC): minute hour day-of-month month day-of-week.
// Supports "*", "*/n", "a", "a-b", "a-b/n" and comma lists. dow 0 or 7 = Sunday.

interface FieldSpec {
  any: boolean;
  values: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

export function parseCron(expr: string): FieldSpec[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const specs: FieldSpec[] = [];
  for (let i = 0; i < 5; i++) {
    const spec = parseField(
      parts[i],
      FIELD_RANGES[i][0],
      FIELD_RANGES[i][1],
      i === 4,
    );
    if (!spec) return null;
    specs.push(spec);
  }
  return specs;
}

function parseField(
  field: string,
  min: number,
  max: number,
  isDow: boolean,
): FieldSpec | null {
  if (field === "*") return { any: true, values: new Set() };

  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const [, base, stepStr] = m;
    const step = stepStr ? parseInt(stepStr) : 1;
    if (step < 1) return null;

    let lo: number, hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(base);
      if (stepStr) hi = max; // "a/n" means a..max step n
    }

    for (let v = lo; v <= hi; v += step) {
      let val = v;
      if (isDow && val === 7) val = 0;
      if (val < min || val > max) {
        if (!(isDow && v === 7)) return null;
      }
      values.add(val);
    }
  }
  return { any: false, values };
}

// Automation listings compute every schedule's next run, and the scheduler
// checks every schedule each minute. Parse each distinct expression once.
const PARSED_MAX = 1_000;
const parsed = new Map<string, readonly FieldSpec[] | null>();

function parsedCron(expr: string): readonly FieldSpec[] | null {
  if (parsed.has(expr)) return parsed.get(expr)!;
  const specs = parseCron(expr);
  if (parsed.size >= PARSED_MAX) parsed.clear();
  parsed.set(expr, specs);
  return specs;
}

function dayMatches(specs: readonly FieldSpec[], date: Date): boolean {
  const [, , domSpec, monSpec, dowSpec] = specs;
  if (!fieldMatches(monSpec, date.getUTCMonth() + 1)) return false;
  // Standard cron: if both dom and dow are restricted, either may match
  const domOk = fieldMatches(domSpec, date.getUTCDate());
  const dowOk = fieldMatches(dowSpec, date.getUTCDay());
  if (!domSpec.any && !dowSpec.any) return domOk || dowOk;
  return domOk && dowOk;
}

export function cronMatches(expr: string, date: Date): boolean {
  const specs = parsedCron(expr);
  if (!specs) return false;
  return (
    fieldMatches(specs[0], date.getUTCMinutes()) &&
    fieldMatches(specs[1], date.getUTCHours()) &&
    dayMatches(specs, date)
  );
}

function fieldMatches(spec: FieldSpec, value: number): boolean {
  return spec.any || spec.values.has(value);
}

const NEXT_RUN_MAX = 1_000;
const nextRuns = new Map<string, number | null>();

/** Next matching minute strictly after `from`, scanning up to ~1 year. */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  const specs = parsedCron(expr);
  if (!specs) return null;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  // Every `from` inside one minute has the same answer.
  const key = `${cursor.getTime()}\u0000${expr}`;
  if (nextRuns.has(key)) {
    const hit = nextRuns.get(key)!;
    return hit === null ? null : new Date(hit);
  }
  const end = cursor.getTime() + 527040 * 60_000;
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  let found: number | null = null;
  while (cursor.getTime() <= end) {
    // Skip whole days and hours that cannot match instead of every minute.
    if (!dayMatches(specs, cursor)) {
      cursor.setUTCHours(24, 0, 0, 0);
      continue;
    }
    if (!fieldMatches(specs[1], cursor.getUTCHours())) {
      cursor.setUTCMinutes(60, 0, 0);
      continue;
    }
    if (fieldMatches(specs[0], cursor.getUTCMinutes())) {
      found = cursor.getTime();
      break;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  if (nextRuns.size >= NEXT_RUN_MAX) nextRuns.clear();
  nextRuns.set(key, found);
  return found === null ? null : new Date(found);
}

/** Latest matching minute at or before `at` (seconds floored), scanning back up to ~1 year. */
export function previousRun(expr: string, at: Date): Date | null {
  const specs = parsedCron(expr);
  if (!specs) return null;
  const cursor = new Date(at.getTime());
  cursor.setUTCSeconds(0, 0);
  const end = cursor.getTime() - 527040 * 60_000;
  while (cursor.getTime() >= end) {
    // Skip whole days and hours that cannot match instead of every minute.
    if (!dayMatches(specs, cursor)) {
      cursor.setUTCHours(0, 0, 0, 0);
      cursor.setTime(cursor.getTime() - 60_000);
      continue;
    }
    if (!fieldMatches(specs[1], cursor.getUTCHours())) {
      cursor.setUTCMinutes(0, 0, 0);
      cursor.setTime(cursor.getTime() - 60_000);
      continue;
    }
    if (fieldMatches(specs[0], cursor.getUTCMinutes())) return cursor;
    cursor.setTime(cursor.getTime() - 60_000);
  }
  return null;
}
