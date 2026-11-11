// Blob's row in Settings, Members: what it reads and how it reads out. The
// supervisor's prefs for the signed-in owner (GET /api/supervisor/prefs),
// every project's lead (GET /api/supervisor/leads) and the open needs-you
// count (GET /api/supervisor/items). Read only; nothing here writes. Pure
// apart from the fetch, so the panel and its tests share one reading.

import { z } from "zod";
import { LEAD_STAGES, type LeadRosterEntry } from "../../shared/project-lead";
import { BASE_PATH } from "./base";
import { LEAD_STAGE_OPTIONS } from "./project-settings/lead-model";

export const BLOB_ROLE =
  "Your supervisor. Runs the project leads and tells you what needs you.";

/** The items route lists at most this many; a full page reads as "or more". */
export const NEEDS_YOU_LIMIT = 100;

const prefsSchema = z.object({
  quietStart: z.string(),
  quietEnd: z.string(),
  digestAt: z.string(),
  timezone: z.string().optional(),
  effectiveTimezone: z.string().optional(),
  watch: z.object({
    enabled: z.boolean(),
    activeStart: z.string(),
    activeEnd: z.string(),
  }),
});
export type BlobPrefs = z.infer<typeof prefsSchema>;

const leadSchema = z.object({
  project: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  stage: z.enum(LEAD_STAGES),
  owner: z.string().optional(),
});

/** Each part is null when it could not be read: an old server without the
 *  route, or a failed request. The rest still shows. */
export interface BlobSummary {
  prefs: BlobPrefs | null;
  leads: LeadRosterEntry[] | null;
  needsYou: number | null;
}

/** Only GETs by URL: the browser's fetch fits, and so does a test stub. */
export type GetFetch = (input: string) => Promise<Response>;

/** The parsed body, or null when the request failed or the body doesn't
 *  fit (an old server, a route that isn't there). */
async function getParsed<T>(
  path: string,
  schema: z.ZodType<T>,
  fetchImpl: GetFetch,
): Promise<T | null> {
  try {
    const response = await fetchImpl(`${BASE_PATH}${path}`);
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadBlobSummary(
  user: string,
  fetchImpl: GetFetch = (input) => fetch(input),
): Promise<BlobSummary> {
  const who = `user=${encodeURIComponent(user)}`;
  const [prefs, leads, items] = await Promise.all([
    getParsed(
      `/api/supervisor/prefs?${who}`,
      z.object({ prefs: prefsSchema }),
      fetchImpl,
    ),
    getParsed(
      "/api/supervisor/leads",
      z.object({ leads: z.array(leadSchema) }),
      fetchImpl,
    ),
    getParsed(
      `/api/supervisor/items?${who}&state=open&kind=needs-you&limit=${NEEDS_YOU_LIMIT}`,
      z.object({ items: z.array(z.object({ id: z.string() })) }),
      fetchImpl,
    ),
  ]);
  return {
    prefs: prefs?.prefs ?? null,
    leads: leads?.leads ?? null,
    needsYou: items ? items.items.length : null,
  };
}

/** "HH:MM to HH:MM"; null when the two are equal (the span is empty or
 *  the whole day, depending on the setting). */
function span(start: string, end: string): string | null {
  return start === end ? null : `${start} to ${end}`;
}

export interface BlobFact {
  label: string;
  value: string;
}

export function blobFacts(
  prefs: BlobPrefs,
  needsYou: number | null,
): BlobFact[] {
  const { watch } = prefs;
  const active = span(watch.activeStart, watch.activeEnd);
  return [
    {
      label: "Watch",
      value: !watch.enabled ? "Off" : active ? `On, ${active}` : "On all day",
    },
    {
      label: "Quiet hours",
      value: span(prefs.quietStart, prefs.quietEnd) ?? "None",
    },
    { label: "Daily digest", value: prefs.digestAt },
    {
      label: "Time zone",
      value: prefs.effectiveTimezone || prefs.timezone || "Not set",
    },
    ...(needsYou === null
      ? []
      : [{ label: "Needs you", value: needsYouCopy(needsYou) }]),
  ];
}

export function needsYouCopy(count: number): string {
  if (count <= 0) return "Nothing open";
  if (count >= NEEDS_YOU_LIMIT) return `${NEEDS_YOU_LIMIT} or more open`;
  return `${count} open`;
}

/** A lead's state in one word: its stage, or Off. */
export function leadStateLabel(
  lead: Pick<LeadRosterEntry, "enabled" | "stage">,
): string {
  if (!lead.enabled) return "Off";
  return (
    LEAD_STAGE_OPTIONS.find((option) => option.value === lead.stage)?.label ??
    lead.stage
  );
}
