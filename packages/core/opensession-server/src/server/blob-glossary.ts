/**
 * Blob's glossary: the words the owner says that a speech model can't know.
 * Project names and labels, repository names, teammates' first names, the
 * persona's name and Blob, and a few work terms. The app hands them to
 * Apple's transcriber as contextual strings and uses them to correct near
 * misses in the final text (BlobGlossary.swift), so "Butter Band" reads as
 * the project it was.
 *
 * `GET /api/blob/glossary` (routes/blob-glossary.ts) serves it. Everything
 * comes from in-memory config (projects.ts, people.ts' roster, the persona),
 * built at most once per CACHE_MS.
 */

import { configuredIdentity, personaName } from "./config";
import { listProjects } from "./projects";
import { BLOB_ACTOR } from "./session-actors";

/** Apple takes at most 100 contextual strings. */
export const MAX_GLOSSARY_TERMS = 100;
/** Longest term kept; a longer label is a sentence, not a name. */
export const MAX_TERM_CHARS = 40;
export const GLOSSARY_CACHE_MS = 5 * 60_000;

/** Work terms the owner says to Blob that are not names. */
export const COMMON_TERMS = [
  "PR",
  "PRs",
  "merge",
  "incident",
  "lead",
  "Duo",
] as const;

export interface GlossarySources {
  persona: string;
  projects: Array<{ id: string; label: string; ghRepo?: string }>;
  /** Full names from the roster; only the first name is kept. */
  people: string[];
}

/** A term worth sending: printable, 2 to MAX_TERM_CHARS characters, with a
 *  letter in it. Undefined otherwise. */
export function glossaryTerm(raw: string): string | undefined {
  const term = raw.replace(/\s+/g, " ").trim();
  if (term.length < 2 || term.length > MAX_TERM_CHARS) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(term) || !/\p{L}/u.test(term)) return undefined;
  return term;
}

/**
 * The glossary, most wanted first, without case-insensitive duplicates (the
 * first spelling wins, so a project's label beats its id), cut at
 * MAX_GLOSSARY_TERMS.
 */
export function buildBlobGlossary(sources: GlossarySources): string[] {
  const candidates = [
    sources.persona,
    BLOB_ACTOR,
    ...COMMON_TERMS,
    ...sources.projects.flatMap((project) => [
      project.label,
      project.id,
      project.ghRepo?.split("/").pop() ?? "",
    ]),
    ...sources.people.map((name) => name.trim().split(/\s+/)[0] ?? ""),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of candidates) {
    const term = glossaryTerm(raw);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_GLOSSARY_TERMS) break;
  }
  return terms;
}

function liveSources(): GlossarySources {
  return {
    persona: personaName(),
    projects: listProjects().map((project) => ({
      id: project.id,
      label: project.label,
      ghRepo: project.repo?.ghRepo,
    })),
    people: configuredIdentity()
      .team.filter((member) => member.directory !== false)
      .map((member) => member.name),
  };
}

let cached: { at: number; terms: string[] } | undefined;

/** The glossary for this instance, rebuilt at most once per CACHE_MS. */
export function blobGlossary(
  now = Date.now(),
  sources: () => GlossarySources = liveSources,
): string[] {
  if (cached && now - cached.at < GLOSSARY_CACHE_MS) return cached.terms;
  cached = { at: now, terms: buildBlobGlossary(sources()) };
  return cached.terms;
}

export function resetBlobGlossaryCache(): void {
  cached = undefined;
}
