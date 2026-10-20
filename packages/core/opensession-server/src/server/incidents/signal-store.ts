// Signal configuration on the `incident-signals` application catalog
// namespace. Every write is audited without header values or hook secrets.
import { randomUUIDv7 } from "bun";
import type { Signal } from "../../shared/incidents";
import {
  catalogDocuments,
  catalogNamespaceWriteCount,
} from "../catalog-documents";
import { configuredRepos } from "../config";
import { incidentAudit } from "./audit-sink";
import { forgetObservations } from "./observation-store";
import {
  type SignalValidationContext,
  generateHookSecret,
  normalizeSignal,
  restoreRedactedImpact,
  restoreRedactedSource,
  validateSignalInput,
} from "./signal-validation";

const NAMESPACE = "incident-signals";

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
function signalDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(NAMESPACE));
}

let projectCheck: ((id: string) => boolean) | undefined;

/** Replace the project check (undefined restores the configured repos). */
export function __setProjectCheckForTest(
  check: ((id: string) => boolean) | undefined,
): void {
  projectCheck = check;
}

type RunOnCheck = (signal: Signal) => Promise<string | null>;
let runOnCheck: RunOnCheck | undefined;

/** Install the check a signal with `runOn` must pass to be saved (a
 *  message refuses it). Undefined removes it. */
export function setSignalRunOnCheck(check: RunOnCheck | undefined): void {
  runOnCheck = check;
}

async function runOnProblem(signal: Signal): Promise<string | null> {
  return signal.runOn && runOnCheck ? runOnCheck(signal) : null;
}

function projectExists(id: string): boolean {
  return projectCheck ? projectCheck(id) : id in configuredRepos();
}

/** Ids the catalog accepts as keys; anything else was never stored. */
function isSignalId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    id !== "." &&
    id !== ".." &&
    !/[\\/\u0000-\u001f]/.test(id)
  );
}

function isSignalRecord(value: unknown): value is Signal {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Signal).id === "string" &&
    typeof (value as Signal).name === "string" &&
    !!(value as Signal).source &&
    typeof (value as Signal).source === "object"
  );
}

function validationContext(selfId?: string): SignalValidationContext {
  return {
    projectExists,
    signalExists: async (id) => (await getSignal(id)) !== null,
    ...(selfId === undefined ? {} : { selfId }),
  };
}

function needsHookSecret(signal: Signal): boolean {
  return signal.source.kind === "webhook" || signal.source.kind === "heartbeat";
}

/** Drop keys whose value is undefined so stored and returned copies match. */
function compact(signal: Signal): Signal {
  const out = { ...signal } as Record<string, unknown>;
  for (const key of Object.keys(out))
    if (out[key] === undefined) delete out[key];
  return out as unknown as Signal;
}

/**
 * Restore values sent back redacted (secret headers, query parameters, the
 * body, and the same in an http impact) against `stored`, only while the
 * address keeps its origin.
 */
function withRestoredSecrets(
  next: Signal,
  stored: Signal | undefined,
): { signal: Signal; impactFromSource?: string[] } | { error: string } {
  let out = next;
  if (out.source) {
    const restored = restoreRedactedSource(stored?.source, out.source);
    if ("error" in restored) return restored;
    out = { ...out, source: restored.source };
  }
  if (out.impact) {
    const restored = restoreRedactedImpact(
      stored?.impact,
      out.impact,
      stored?.source,
    );
    if ("error" in restored) return restored;
    out = { ...out, impact: restored.impact };
    if (restored.fromSource)
      return { signal: out, impactFromSource: restored.fromSource };
  }
  return { signal: out };
}

export async function listSignals(): Promise<Signal[]> {
  const out: Signal[] = [];
  for (const { value } of await signalDocuments().list())
    if (isSignalRecord(value)) out.push(value);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getSignal(id: string): Promise<Signal | null> {
  if (!isSignalId(id)) return null;
  const value = await signalDocuments().get(id);
  return isSignalRecord(value) ? value : null;
}

export async function createSignal(
  input: Record<string, unknown>,
  by: string,
): Promise<Signal | { error: string }> {
  const validated = await validateSignalInput(input, validationContext());
  if ("error" in validated) return validated;
  const now = new Date().toISOString();
  const base = {
    id: `sig-${randomUUIDv7()}`,
    name: "",
    project: "",
    enabled: true,
    severity: "major",
    createdBy: by || "Anonymous",
    createdAt: now,
    updatedAt: now,
  } as Signal;
  const merged = withRestoredSecrets(
    { ...base, ...validated.fields } as Signal,
    undefined,
  );
  if ("error" in merged) return merged;
  const normalized = normalizeSignal(merged.signal);
  if ("error" in normalized) return normalized;
  const refused = await runOnProblem(normalized);
  if (refused) return { error: refused };
  const signal = compact(normalized);
  if (needsHookSecret(signal)) signal.hookSecret = generateHookSecret();
  await signalDocuments().set(signal.id, signal);
  incidentAudit({
    kind: "incident_signal_created",
    signalId: signal.id,
    project: signal.project,
    by: base.createdBy,
  });
  return signal;
}

/**
 * Apply validated fields onto the freshest stored record (CAS). Resolves null
 * for a signal that does not exist, `{ error }` when the merged record breaks
 * a cross-field rule (nothing is written then).
 */
export async function updateSignal(
  id: string,
  input: Record<string, unknown>,
  by: string,
): Promise<Signal | { error: string } | null> {
  if (!isSignalId(id)) return null;
  const validated = await validateSignalInput(input, validationContext(id));
  if ("error" in validated) return validated;
  const freshSecret = generateHookSecret();
  // The runOn check is async, so it runs before the compare-and-set on the
  // record as it would be; the write then insists on the same Runner and
  // project.
  let checked: { runOn?: string; project: string } | undefined;
  if (runOnCheck) {
    const stored = await getSignal(id);
    if (stored === null) return null;
    const restored = withRestoredSecrets(
      { ...stored, ...validated.fields, id: stored.id } as Signal,
      stored,
    );
    const preview =
      "error" in restored ? restored : normalizeSignal(restored.signal);
    if (!("error" in preview)) {
      const refused = await runOnProblem(preview);
      if (refused) return { error: refused };
      checked = { runOn: preview.runOn, project: preview.project };
    }
  }
  let failure: { error: string } | undefined;
  let impactChanged = false;
  let impactFromSource: string[] | undefined;
  const updated = await signalDocuments().update<Signal>(id, (value) => {
    failure = undefined;
    impactFromSource = undefined;
    if (value === null) return null;
    if (!isSignalRecord(value))
      throw new Error(`Signal ${id} record is malformed`);
    const merged = withRestoredSecrets(
      {
        ...value,
        ...validated.fields,
        id: value.id,
        createdBy: value.createdBy,
        createdAt: value.createdAt,
        updatedAt: new Date().toISOString(),
      } as Signal,
      value,
    );
    const normalized =
      "error" in merged ? merged : normalizeSignal(merged.signal);
    if ("error" in normalized) {
      failure = normalized;
      return value;
    }
    if (
      runOnCheck &&
      normalized.runOn &&
      (checked?.runOn !== normalized.runOn ||
        checked.project !== normalized.project)
    ) {
      failure = {
        error: "The signal changed while it was being saved. Try again.",
      };
      return value;
    }
    if (!("error" in merged)) impactFromSource = merged.impactFromSource;
    const next = compact(normalized);
    impactChanged =
      JSON.stringify(next.impact) !== JSON.stringify(value.impact);
    // A hook secret is never rotated, not even by switching the source to
    // another kind and back; only hook kinds publish it (hookPathFor).
    if (value.hookSecret) next.hookSecret = value.hookSecret;
    else if (needsHookSecret(next)) next.hookSecret = freshSecret;
    return next;
  });
  if (failure) return failure;
  if (updated === null) return null;
  // An impact sent back as it was (redacted, then restored) is not a change.
  const fields = [...validated.touched].filter(
    (field) => field !== "impact" || impactChanged,
  );
  incidentAudit({
    kind: "incident_signal_updated",
    signalId: id,
    by: by || "Anonymous",
    fields: fields.sort(),
    // Which impact secrets came from the signal's own source (names only).
    ...(impactFromSource
      ? { impactSecrets: { from: "source", fields: impactFromSource } }
      : {}),
  });
  return updated;
}

export async function deleteSignal(id: string, by: string): Promise<boolean> {
  if (!isSignalId(id)) return false;
  const existed = await signalDocuments().delete(id);
  // Day files stay until retention, so its incidents keep their strips.
  forgetObservations(id);
  if (existed)
    incidentAudit({
      kind: "incident_signal_deleted",
      signalId: id,
      by: by || "Anonymous",
    });
  return existed;
}

/** Commits this process has made to signals; caches compare it to refresh. */
export function signalWriteCount(): number {
  return catalogNamespaceWriteCount(NAMESPACE);
}
