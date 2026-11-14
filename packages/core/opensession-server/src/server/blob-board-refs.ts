/**
 * Live fields for the refs on Blob's board (shared/blob-board.ts), resolved
 * at read time from the stores the supervisor already reads: the lead
 * roster for which projects are the owner's, the in-memory PR cache for
 * pull requests, their checks and releases, the incident store and the
 * support store (one catalog document each, by id).
 *
 * Owner's projects only: a ref outside the projects whose lead answers to
 * the owner resolves exactly like one that does not exist, `not-found`, and
 * the board shows it as plain text. Bounded: at most MAX_REFS distinct refs
 * per read (the rest read `limit`), at most RESOLVE_CONCURRENCY store reads
 * at a time, and each answer is cached per owner for CACHE_TTL_MS.
 *
 * What each kind reads:
 * - `pr:<project>#<n>`: the cached PR (open, merged or closed).
 * - `check:<project>#<n>/<name>`: the PR's check counts. The cache keeps
 *   counts, not each check, so the status is the PR's checks as a whole
 *   and `fields.scope` says so.
 * - `incident:<project>/<id>`: the incident, which must be in that project.
 * - `thread:<project>/<conversation id>`: the support conversation.
 * - `release:<project>@<version>`: there is no release store; the newest
 *   cached PR of the project whose title names the version stands in, and
 *   the ref is `not-found` when none does.
 * - `project:<project>`: the roster entry: its label and its lead.
 * - `item:<item id>`: an item in the owner's own supervisor inbox (one
 *   document read), so it is the owner's by construction. `fields.itemId`
 *   is what the client opens the decision view with.
 *
 * Text other people wrote (titles, subjects) is returned as is; the tools
 * quote it as data for the model.
 */
import type { Incident } from "../shared/incidents";
import { isOpenIncident } from "../shared/incidents";
import type { LeadRosterEntry } from "../shared/project-lead";
import type { SupportConversation } from "../shared/support";
import {
  parseRef,
  type BoardToken,
  type ParsedRef,
  type ResolvedRef,
} from "../shared/blob-board";
import type { PrInfo } from "./pr-cache";
import type { SupervisorItem } from "./supervisor-inbox";
import { age } from "./supervisor-status";
import { supervisorInboxKey } from "./supervisor-inbox";

export const MAX_REFS = 100;
export const RESOLVE_CONCURRENCY = 8;
export const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1_000;

export interface BoardRefDeps {
  now(): number;
  roster(): Promise<LeadRosterEntry[]>;
  /** The in-memory PR cache: project (repo id) → branch → PR. */
  prs(): Promise<Map<string, Map<string, PrInfo>>>;
  incident(id: string): Promise<Incident | null>;
  conversation(id: string): Promise<SupportConversation | null>;
  /** The owner's supervisor inbox items (one document). */
  items(owner: string): Promise<SupervisorItem[]>;
}

const liveDeps: BoardRefDeps = {
  now: Date.now,
  roster: async () => (await import("./leads/roster")).listLeadRoster(),
  prs: async () => (await import("./pr-cache")).getPrsByRepo(),
  incident: async (id) =>
    (await import("./incidents/incident-store")).getIncident(id),
  conversation: async (id) =>
    (await import("./support/store")).getConversation(id),
  items: async (owner) =>
    (await (await import("./supervisor-inbox")).readSupervisorBriefView(owner))
      .items,
};

let overrides: Partial<BoardRefDeps> | undefined;

/** Swap the sources in tests; undefined restores the live ones. */
export function __setBoardRefDepsForTest(
  next: Partial<BoardRefDeps> | undefined,
): void {
  overrides = next;
  cache.clear();
}

function deps(): BoardRefDeps {
  return { ...liveDeps, ...overrides };
}

const cache = new Map<string, { at: number; value: ResolvedRef }>();

const NOT_FOUND: ResolvedRef = { ok: false, reason: "not-found" };

function prStatus(pr: PrInfo): { status: string; tone: BoardToken } {
  if (pr.state === "MERGED") return { status: "merged", tone: "green" };
  if (pr.state === "CLOSED") return { status: "closed", tone: "ink2" };
  if (pr.isDraft) return { status: "draft", tone: "ink2" };
  if (pr.mergeable === "CONFLICTING")
    return { status: "conflicts", tone: "red" };
  if (pr.checks.failed > 0) return { status: "checks failing", tone: "red" };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { status: "changes requested", tone: "amber" };
  if (pr.checks.pending > 0) return { status: "checks running", tone: "amber" };
  if (pr.reviewDecision === "APPROVED")
    return { status: "approved", tone: "green" };
  return { status: "open", tone: "ink" };
}

function checksLine(pr: PrInfo): string {
  const c = pr.checks;
  if (!c.total) return "no checks yet";
  return `${c.passed}/${c.total} passed${c.failed ? `, ${c.failed} failed` : ""}${c.pending ? `, ${c.pending} running` : ""}`;
}

async function findPr(
  d: BoardRefDeps,
  project: string,
  number: number,
): Promise<PrInfo | undefined> {
  for (const pr of (await d.prs()).get(project)?.values() ?? [])
    if (pr.number === number) return pr;
  return undefined;
}

function prRef(pr: PrInfo): ResolvedRef {
  const { status, tone } = prStatus(pr);
  return {
    ok: true,
    kind: "pr",
    title: `#${pr.number} ${pr.title}`,
    status,
    statusTone: tone,
    url: pr.url,
    updatedAt: pr.updatedAt,
    fields: { number: String(pr.number), checks: checksLine(pr) },
  };
}

/** How an inbox item reads on the board. Open needs-you items wait for the
 *  owner (amber: the one tangerine element is the board's choice). */
export function itemRef(item: SupervisorItem): ResolvedRef {
  const [status, tone]: [string, BoardToken] =
    item.state === "open"
      ? item.kind === "needs-you"
        ? ["waiting for you", "amber"]
        : ["update", "ink"]
      : item.state === "answered"
        ? [`answered${item.answer ? `: ${item.answer}` : ""}`, "green"]
        : [item.state, "ink2"];
  const fields: Record<string, string> = {
    itemId: item.id,
    kind: item.kind,
  };
  if (item.project) fields.project = item.project;
  if (item.options?.length) fields.options = item.options.join(" · ");
  return {
    ok: true,
    kind: "item",
    title: item.title,
    status,
    statusTone: tone,
    updatedAt: new Date(item.updatedAt).toISOString(),
    fields,
  };
}

async function resolveOne(
  d: BoardRefDeps,
  parsed: ParsedRef,
  owned: () => Promise<ReadonlyMap<string, LeadRosterEntry>>,
  items: () => Promise<SupervisorItem[]>,
): Promise<ResolvedRef> {
  if (parsed.kind === "item") {
    const item = (await items()).find((i) => i.id === parsed.id);
    return item ? itemRef(item) : NOT_FOUND;
  }
  const entry = (await owned()).get(parsed.project);
  if (!entry) return NOT_FOUND;
  const now = d.now();
  switch (parsed.kind) {
    case "project": {
      return {
        ok: true,
        kind: "project",
        title: entry.label,
        status: entry.enabled ? `lead on, ${entry.stage}` : "lead off",
        statusTone: entry.enabled ? "green" : "ink2",
        fields: {},
      };
    }
    case "pr": {
      const pr = await findPr(d, parsed.project, parsed.number!);
      return pr ? prRef(pr) : NOT_FOUND;
    }
    case "check": {
      const pr = await findPr(d, parsed.project, parsed.number!);
      if (!pr) return NOT_FOUND;
      const c = pr.checks;
      const [status, tone]: [string, BoardToken] = !c.total
        ? ["no checks yet", "ink2"]
        : c.failed
          ? ["failing", "red"]
          : c.pending
            ? ["running", "amber"]
            : ["passing", "green"];
      return {
        ok: true,
        kind: "check",
        title: parsed.name!,
        status,
        statusTone: tone,
        url: pr.url,
        updatedAt: pr.updatedAt,
        fields: {
          number: String(pr.number),
          checks: checksLine(pr),
          scope: "all checks on the pull request",
        },
      };
    }
    case "incident": {
      const incident = await d.incident(parsed.name!);
      if (!incident || incident.project !== parsed.project) return NOT_FOUND;
      const open = isOpenIncident(incident);
      return {
        ok: true,
        kind: "incident",
        title: incident.title,
        status: incident.state,
        statusTone: !open
          ? "green"
          : incident.state === "needs-you"
            ? "red"
            : incident.state === "waiting-on-provider" ||
                incident.state === "paused"
              ? "amber"
              : "red",
        updatedAt: incident.updatedAt,
        fields: {
          severity: incident.severity,
          openFor: age(
            incident.openedAt,
            open ? now : Date.parse(incident.closedAt ?? incident.updatedAt),
          ),
        },
      };
    }
    case "thread": {
      const conversation = await d.conversation(parsed.name!);
      if (!conversation || conversation.project !== parsed.project)
        return NOT_FOUND;
      return {
        ok: true,
        kind: "thread",
        title: conversation.subject || "(no subject)",
        status: conversation.status,
        statusTone:
          conversation.status === "open"
            ? "amber"
            : conversation.status === "waiting"
              ? "ink"
              : "ink2",
        updatedAt: conversation.lastMessageAt,
        fields: { openFor: age(conversation.createdAt, now) },
      };
    }
    case "release": {
      const version = parsed.name!;
      const named = new RegExp(
        `(^|[^A-Za-z0-9.])v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`,
      );
      const pr = [...((await d.prs()).get(parsed.project)?.values() ?? [])]
        .filter((p) => named.test(p.title))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!pr) return NOT_FOUND;
      const { status, tone } = prStatus(pr);
      return {
        ok: true,
        kind: "release",
        title: `${entry.label} ${version}`,
        status: pr.state === "OPEN" ? `#${pr.number} ${status}` : status,
        statusTone: tone,
        url: pr.url,
        updatedAt: pr.updatedAt,
        fields: { number: String(pr.number), checks: checksLine(pr) },
      };
    }
  }
}

/**
 * Resolve `refs` for `owner`: a map from each ref to its live fields or why
 * it shows as plain text. Never throws: a store that fails reads
 * `unavailable` for the refs it serves, and is not cached.
 */
export async function resolveBoardRefs(
  owner: string,
  refs: readonly string[],
): Promise<Record<string, ResolvedRef>> {
  const d = deps();
  const out: Record<string, ResolvedRef> = {};
  const distinct = [...new Set(refs)];
  if (!distinct.length) return out;
  const key = supervisorInboxKey(owner);
  const now = d.now();
  const pending: Array<{ ref: string; parsed: ParsedRef }> = [];
  for (const [index, ref] of distinct.entries()) {
    if (index >= MAX_REFS) {
      out[ref] = { ok: false, reason: "limit" };
      continue;
    }
    const hit = cache.get(`${key}\u0000${ref}`);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out[ref] = hit.value;
      continue;
    }
    const parsed = parseRef(ref);
    if (!parsed) out[ref] = NOT_FOUND;
    else pending.push({ ref, parsed });
  }
  if (!pending.length) return out;

  // Read once per resolve, and only when a project ref asks. An item ref
  // never needs it: a roster that can't be read leaves the owner's own
  // inbox items resolving.
  let roster: Promise<Map<string, LeadRosterEntry>> | undefined;
  const owned = () =>
    (roster ??= d
      .roster()
      .then(
        (entries) =>
          new Map(
            entries
              .filter(
                (entry) =>
                  !!entry.owner?.trim() &&
                  supervisorInboxKey(entry.owner) === key,
              )
              .map((entry) => [entry.project, entry]),
          ),
      ));

  // The inbox is read once per resolve, and only when an item ref asks.
  let inbox: Promise<SupervisorItem[]> | undefined;
  const items = () => (inbox ??= d.items(owner));
  for (let i = 0; i < pending.length; i += RESOLVE_CONCURRENCY) {
    const batch = pending.slice(i, i + RESOLVE_CONCURRENCY);
    const values = await Promise.all(
      batch.map(({ parsed }) =>
        resolveOne(d, parsed, owned, items).catch((): ResolvedRef => ({
          ok: false,
          reason: "unavailable",
        })),
      ),
    );
    for (const [j, { ref, parsed }] of batch.entries()) {
      const value = values[j]!;
      out[ref] = value;
      if (!value.ok && value.reason === "unavailable") continue;
      // An item is answered in Blob itself: read it fresh every time, from
      // the one inbox document this resolve already read.
      if (parsed.kind === "item") continue;
      cache.set(`${key}\u0000${ref}`, { at: now, value });
      if (cache.size > CACHE_MAX)
        cache.delete(cache.keys().next().value as string);
    }
  }
  return out;
}
