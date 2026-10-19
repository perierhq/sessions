import { registerMemoryGauge } from "./memory-gauges";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { isNativeSessionId, stateDir } from "./paths";

export interface PiModelUsage {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface PiUsageDay {
  byModel: PiModelUsage[];
  bySession: Record<string, { requests: number; output: number }>;
  sessionAttribution: "measured" | "unmeasured";
  coverage: { pi: "measured" | "unmeasured" };
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  requests: number;
  unpricedRequests: number;
  unmeasured: boolean;
}

interface MutableUsage {
  byModel: Map<string, PiModelUsage>;
  bySession: Map<string, { requests: number; output: number }>;
}

const PI_DIR = () => stateDir("pi");
const CACHE_DIR = () => stateDir("analytics-cache");
const CACHE_VERSION = 1;
export const PI_USAGE_CUTOVER_MS = Date.parse("2026-08-19T13:35:30Z");
const CUTOVER_DAY = "2026-08-19";
const VOLATILE_TTL_MS = 60_000;
const volatile = new Map<string, { at: number; day: PiUsageDay }>();
registerMemoryGauge("pi-usage.volatile", () => volatile.size);
let inflight: Promise<void> | null = null;

function emptyMutable(): MutableUsage {
  return { byModel: new Map(), bySession: new Map() };
}

function emptyDay(unmeasured = false): PiUsageDay {
  return {
    byModel: [],
    bySession: {},
    sessionAttribution: unmeasured ? "unmeasured" : "measured",
    coverage: { pi: unmeasured ? "unmeasured" : "measured" },
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
    unmeasured,
  };
}

function finishDay(value: MutableUsage): PiUsageDay {
  const day = emptyDay();
  day.byModel = [...value.byModel.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd || b.cacheRead + b.input - (a.cacheRead + a.input),
  );
  day.bySession = Object.fromEntries(value.bySession);
  for (const usage of day.byModel) {
    day.requests += usage.requests;
    day.input += usage.input;
    day.output += usage.output;
    day.cacheRead += usage.cacheRead;
    day.cacheWrite += usage.cacheWrite;
    day.costUsd += usage.costUsd;
  }
  day.totalTokens = day.input + day.output + day.cacheRead + day.cacheWrite;
  return day;
}

function mergeDay(target: MutableUsage, source: PiUsageDay): void {
  for (const usage of source.byModel || []) {
    const current = target.byModel.get(usage.model) || {
      model: usage.model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    current.requests += usage.requests || 0;
    current.input += usage.input || 0;
    current.output += usage.output || 0;
    current.cacheRead += usage.cacheRead || 0;
    current.cacheWrite += usage.cacheWrite || 0;
    current.costUsd += usage.costUsd || 0;
    target.byModel.set(usage.model, current);
  }
  for (const [session, usage] of Object.entries(source.bySession || {})) {
    const current = target.bySession.get(session) || { requests: 0, output: 0 };
    current.requests += usage.requests || 0;
    current.output += usage.output || 0;
    target.bySession.set(session, current);
  }
}

function cachePath(date: string): string {
  return `${CACHE_DIR()}/pi-day-v${CACHE_VERSION}-${date}.json`;
}

function readCache(date: string): PiUsageDay | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(date), "utf8"));
    return parsed?.v === CACHE_VERSION && parsed?.day ? parsed.day : null;
  } catch {
    return null;
  }
}

function writeCache(date: string, day: PiUsageDay): void {
  try {
    mkdirSync(CACHE_DIR(), { recursive: true });
    writeFileSync(cachePath(date), JSON.stringify({ v: CACHE_VERSION, day }));
  } catch (error) {
    console.error("[analytics] Pi usage cache write failed:", error);
  }
}

function readLegacyAuditDay(date: string): PiUsageDay | null {
  const path = `${stateDir("audit")}/audit-${date}.jsonl`;
  if (!existsSync(path)) return null;
  const bucket = emptyMutable();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"kind":"result"')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const time = Date.parse(String(event.time || ""));
    if (
      date === CUTOVER_DAY &&
      (!Number.isFinite(time) || time >= PI_USAGE_CUTOVER_MS)
    )
      continue;
    const model = shortModel(event.model);
    const usage = bucket.byModel.get(model) || {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    usage.requests += Number(event.steps) || 1;
    usage.input += Number(event.input_tokens) || 0;
    usage.output += Number(event.output_tokens) || 0;
    usage.cacheRead += Number(event.cache_read_input_tokens) || 0;
    usage.cacheWrite += Number(event.cache_creation_input_tokens) || 0;
    usage.costUsd += Number(event.total_cost_usd) || 0;
    bucket.byModel.set(model, usage);
    const session = String(event.session_id || event.bks_session_id || "");
    if (isNativeSessionId(session)) {
      const sessionUsage = bucket.bySession.get(session) || {
        requests: 0,
        output: 0,
      };
      sessionUsage.requests += Number(event.steps) || 1;
      sessionUsage.output += Number(event.output_tokens) || 0;
      bucket.bySession.set(session, sessionUsage);
    }
  }
  return bucket.byModel.size ? finishDay(bucket) : null;
}

/** Preserve the final OpenCode measurement on the mixed cutover day and all
 * earlier days. The retired scanner wrote this versioned shape once per day;
 * the cutover day's still-volatile measurement falls back to its audit rows. */
function readLegacyEngineDay(date: string): PiUsageDay | null {
  try {
    const parsed = JSON.parse(
      readFileSync(`${CACHE_DIR()}/engine-day-${date}.json`, "utf8"),
    );
    const day = parsed?.day;
    if (!day || !Array.isArray(day.byModel))
      throw new Error("invalid legacy usage cache");
    return {
      ...emptyDay(!!day.unmeasured),
      ...day,
      byModel: day.byModel.map((usage: Record<string, unknown>) => ({
        model: String(usage.model || "unknown"),
        requests: Number(usage.requests) || 0,
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheRead: Number(usage.cacheRead) || 0,
        cacheWrite: Number(usage.cacheWrite) || 0,
        costUsd: Number(usage.costUsd) || 0,
      })),
      bySession: day.bySession || {},
      coverage: { pi: day.unmeasured ? "unmeasured" : "measured" },
    };
  } catch {
    return readLegacyAuditDay(date);
  }
}

function messageTimeMs(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number {
  const raw = message.timestamp ?? entry.timestamp;
  if (typeof raw === "number") return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string") return Date.parse(raw);
  return Number.NaN;
}

function shortModel(model: unknown): string {
  const stripped = String(model || "unknown").replace(
    /^(?:pi|claude|codex|opencode)\/[^/]+\//,
    "",
  );
  return stripped.split("/").pop() || "unknown";
}

function sessionIdForFile(path: string): string | null {
  const candidate = basename(dirname(path));
  return isNativeSessionId(candidate) ? candidate : null;
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const child = `${root}/${dir.name}`;
    try {
      for (const file of readdirSync(child))
        if (file.endsWith(".jsonl")) files.push(`${child}/${file}`);
    } catch {}
  }
  return files;
}

export async function scanPiUsage(
  fromDate: string,
  root = `${PI_DIR()}/sessions`,
): Promise<{
  days: Map<string, PiUsageDay>;
  earliest: string | null;
  complete: boolean;
}> {
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
  const buckets = new Map<string, MutableUsage>();
  const seen = new Set<string>();
  let earliest = "";
  let complete = true;
  let scanned = 0;
  for (const path of jsonlFiles(root)) {
    try {
      if (statSync(path).mtimeMs < fromMs) continue;
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line || !line.includes('"type":"message"')) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message || message.role !== "assistant") continue;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const time = messageTimeMs(entry, message);
        if (!Number.isFinite(time)) continue;
        const date = new Date(time).toISOString().slice(0, 10);
        if (!earliest || date < earliest) earliest = date;
        if (
          time < fromMs ||
          (date === CUTOVER_DAY && time < PI_USAGE_CUTOVER_MS)
        )
          continue;
        const id = String(entry.id || "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const bucket = buckets.get(date) || emptyMutable();
        buckets.set(date, bucket);
        const model = shortModel(message.model);
        const modelUsage = bucket.byModel.get(model) || {
          model,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
        };
        modelUsage.requests++;
        modelUsage.input += Number(usage.input) || 0;
        modelUsage.output += Number(usage.output) || 0;
        modelUsage.cacheRead += Number(usage.cacheRead) || 0;
        modelUsage.cacheWrite += Number(usage.cacheWrite) || 0;
        modelUsage.costUsd +=
          Number((usage.cost as Record<string, unknown> | undefined)?.total) ||
          0;
        bucket.byModel.set(model, modelUsage);
        const session = sessionIdForFile(path);
        if (session) {
          const sessionUsage = bucket.bySession.get(session) || {
            requests: 0,
            output: 0,
          };
          sessionUsage.requests++;
          sessionUsage.output += Number(usage.output) || 0;
          bucket.bySession.set(session, sessionUsage);
        }
      }
    } catch (error) {
      complete = false;
      console.error(`[analytics] Pi usage file unreadable: ${path}`, error);
    }
    if (++scanned % 25 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    days: new Map(
      [...buckets].map(([date, value]) => [date, finishDay(value)]),
    ),
    earliest: earliest || null,
    complete,
  };
}

export async function piUsageForDates(
  dates: string[],
): Promise<Map<string, PiUsageDay>> {
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, PiUsageDay>();
  const missing: string[] = [];
  const volatileDay = (date: string): PiUsageDay | null => {
    const cached = volatile.get(date);
    return cached && Date.now() - cached.at < VOLATILE_TTL_MS
      ? cached.day
      : null;
  };
  for (const date of dates) {
    const cached = date < today ? readCache(date) : volatileDay(date);
    if (cached) out.set(date, cached);
    else missing.push(date);
  }
  if (!missing.length) return out;
  while (inflight) await inflight;
  let release!: () => void;
  inflight = new Promise<void>((resolve) => (release = resolve));
  try {
    const stillMissing = missing.filter(
      (date) =>
        !out.has(date) && !(date < today ? readCache(date) : volatileDay(date)),
    );
    if (stillMissing.length) {
      const scanFrom = stillMissing.reduce((a, b) => (a < b ? a : b));
      const scanned =
        scanFrom <= CUTOVER_DAY
          ? await scanPiUsage(CUTOVER_DAY)
          : await scanPiUsage(scanFrom);
      for (const date of stillMissing) {
        const merged = emptyMutable();
        let measured = false;
        if (date <= CUTOVER_DAY) {
          const legacy = readLegacyEngineDay(date);
          if (legacy) {
            mergeDay(merged, legacy);
            measured = !legacy.unmeasured;
          }
        }
        if (date >= CUTOVER_DAY && existsSync(`${PI_DIR()}/sessions`)) {
          const pi = scanned.days.get(date);
          if (pi) mergeDay(merged, pi);
          measured = true;
        }
        let day = measured ? finishDay(merged) : emptyDay(true);
        if (!scanned.complete && date >= CUTOVER_DAY) {
          day.unmeasured = true;
          day.coverage.pi = "unmeasured";
          day.sessionAttribution = "unmeasured";
        }
        if (date < today) writeCache(date, day);
        else volatile.set(date, { at: Date.now(), day });
        out.set(date, day);
      }
    }
  } finally {
    release();
    inflight = null;
  }
  for (const date of dates) {
    if (!out.has(date))
      out.set(
        date,
        (date < today ? readCache(date) : volatileDay(date)) || emptyDay(true),
      );
  }
  return out;
}
