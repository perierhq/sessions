/**
 * A knowledge item on disk: YAML front matter between `---` lines, then a
 * Markdown body. parseArticle reads and checks it; renderArticle writes it
 * with a fixed key order so diffs and history stay readable.
 *
 * parseArticle returns `fm` only when the front matter has no problems, so
 * anything that reads `fm` (the index, the send-time checks) never acts on
 * a half-valid item.
 */

import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_ORIGINS,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_TRUST,
  parseDependency,
  type KnowledgeCheckNote,
  type KnowledgeFrontMatter,
} from "../../shared/knowledge";
import { folderFor, isItemPath, originForPath } from "./layout";

export interface ArticleProblem {
  /** 1-based, for people. */
  line?: number;
  message: string;
}

export interface ParsedArticle {
  fm: KnowledgeFrontMatter | null;
  body: string;
  problems: ArticleProblem[];
}

export const MAX_TITLE_CHARS = 200;
export const MAX_TOPICS = 12;
export const MAX_TOPIC_CHARS = 60;
const MAX_NAME_CHARS = 200;

/** The order keys are written in. */
const KEY_ORDER = [
  "title",
  "kind",
  "trust",
  "status",
  "origin",
  "topics",
  "sources",
  "dependsOn",
  "validAsOf",
  "validAsOfCommit",
  "reviewBy",
  "check",
  "suggestedBy",
  "approvedBy",
  "answeredAt",
] as const satisfies ReadonlyArray<keyof KnowledgeFrontMatter>;

const REQUIRED = new Set<string>([
  "title",
  "kind",
  "trust",
  "status",
  "origin",
  "validAsOf",
]);

const CHECK_ORDER = [
  "reason",
  "since",
  "source",
  "conflictWith",
] as const satisfies ReadonlyArray<keyof KnowledgeCheckNote>;

// Also accepted: `conversation:<id>` (capture) and `thread:<Message-ID>`
// (mail items: the SHA-256 of the thread's root), which only Pat writes.
const SOURCE_KINDS = ["mail", "repo", "url", "issue", "release", "file"];
const UNKNOWN_SOURCE_HINT = `Use ${SOURCE_KINDS.map((k) => `${k}:`).join(", ")} followed by the reference.`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SOURCE_COMMIT = /^[0-9a-f]{7,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const THREAD_ID = /^[0-9a-f]{64}$/;
const URL_CONTENT_HASH = /#sha256=[0-9a-f]{64}$/;
const FENCE = /^---[ \t]*$/;
/** Line breaks and control characters; text fields are one line. */
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
/** A plain top-level key. Keys are matched, never interpolated into a
 *  pattern. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:(?:[ \t]|$)/;
/** Folders whose items stay `trust: reference` until a person approves them
 *  (which moves them to articles/). */
const REFERENCE_UNTIL_APPROVED = new Set<string>([
  "suggestion",
  "issue",
  "file",
]);

export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
  );
}

const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** A full ISO timestamp with seconds and a zone (`Z` or `±HH:MM`) naming a
 *  real day, so it means the same instant everywhere it is read. */
export function isTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  return !!match && isDay(match[1]) && Number.isFinite(Date.parse(value));
}

/** A `sources` entry (or `check.source`): repo and url entries must be
 *  followable like a dependency, with an optional `@<commit>` (repo) or
 *  `#sha256=<hex>` (url) pin. */
export function isSourceRef(
  source: string,
  opts: { allowPr?: boolean } = {},
): boolean {
  if (typeof source !== "string" || CONTROL.test(source)) return false;
  const colon = source.indexOf(":");
  if (colon <= 0) return false;
  const kind = source.slice(0, colon);
  const value = source.slice(colon + 1);
  if (!value || value !== value.trim()) return false;
  switch (kind) {
    case "repo": {
      let path = value;
      const at = value.lastIndexOf("@");
      if (at >= 0 && !value.slice(at + 1).includes("/")) {
        if (!SOURCE_COMMIT.test(value.slice(at + 1))) return false;
        path = value.slice(0, at);
      }
      return parseDependency(`repo:${path}`) !== null;
    }
    case "url":
      return (
        parseDependency(`url:${value.replace(URL_CONTENT_HASH, "")}`) !== null
      );
    case "issue":
    case "release":
      return parseDependency(source) !== null;
    case "pr":
      return !!opts.allowPr && parseDependency(source) !== null;
    case "mail":
    case "file":
      return true;
    case "conversation":
      // The support conversation a captured reply was sent in (an id).
      return CONVERSATION_ID.test(value);
    case "thread":
      // A mail item's thread: the SHA-256 of its root Message-ID.
      return THREAD_ID.test(value);
    default:
      return false;
  }
}

/** What the YAML parser must never see: merge keys, anchors, aliases, tags,
 *  quoted or complex keys and repeated top-level keys. Checked on the raw
 *  lines before parsing, so an alias bomb is refused unparsed. Returns the
 *  line of each top-level key (1-based, counting the opening ---). */
function scanFrontMatter(yamlLines: string[]): {
  keyLines: Map<string, number>;
  problems: ArticleProblem[];
} {
  const keyLines = new Map<string, number>();
  const problems: ArticleProblem[] = [];
  yamlLines.forEach((line, index) => {
    const lineNo = index + 2;
    const add = (message: string) => problems.push({ line: lineNo, message });
    if (/^[ \t]*(?:#|$)/.test(line)) return;
    const content = line.replace(/^[ \t]*(?:-[ \t]+)*/, "");
    if (content.startsWith("<<")) return add(MERGE_KEY);
    if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:(?:[ \t]|$)/.test(content))
      return add(QUOTED_KEY);
    if (!/^[ \t]/.test(line) && !/^-(?:[ \t]|$)/.test(line)) {
      if (/^["']/.test(line)) return add(QUOTED_KEY);
      const match = KEY_LINE.exec(line);
      if (!match) return add("Front matter lines must be `key: value`.");
      const key = match[1];
      if (keyLines.has(key)) return add(`\`${key}\` appears more than once.`);
      keyLines.set(key, lineNo);
    }
    const indicator = nodeIndicator(line);
    if (indicator) add(INDICATORS[indicator]);
  });
  return { keyLines, problems };
}

const MERGE_KEY = "Merge keys (<<) aren't allowed in front matter.";
const QUOTED_KEY = "Keys can't be quoted; write `key: value`.";
const INDICATORS: Record<string, string> = {
  "<<": MERGE_KEY,
  "&": "Anchors (&) aren't allowed in front matter.",
  "*": "Aliases (*) aren't allowed in front matter.",
  "!": "Tags (!) aren't allowed in front matter.",
  "?": "Write keys as plain `key: value` lines.",
};

/** The first YAML node indicator (`&`, `*`, `!`, `?`, `<<`) at the start of a
 *  node on this line, outside quotes and comments; null when there is none.
 *  Text such as `Q&A` or `a*b` is inside a scalar and doesn't count. */
function nodeIndicator(line: string): string | null {
  let quote: string | null = null;
  let depth = 0;
  let nodeStart = true;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    const spaceAfter = next === undefined || next === " " || next === "\t";
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && next === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (c === " " || c === "\t") {
      if (next === "#") return null;
      continue;
    }
    if (nodeStart) {
      if (c === "#") return null;
      if (c === "&" || c === "*" || c === "!") return c;
      if (c === "<" && next === "<") return "<<";
      if (c === "?" && spaceAfter) return c;
      if (c === "-" && spaceAfter) continue;
      if (c === "[" || c === "{") {
        depth++;
        continue;
      }
      nodeStart = false;
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
    }
    if (depth > 0 && (c === "]" || c === "}")) depth--;
    else if (depth > 0 && c === ",") nodeStart = true;
    else if (
      c === ":" &&
      (spaceAfter ||
        (depth > 0 && (next === "," || next === "]" || next === "}")))
    )
      nodeStart = true;
  }
  return null;
}

function cleanBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

export function parseArticle(path: string, text: string): ParsedArticle {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!FENCE.test(lines[0] ?? ""))
    return {
      fm: null,
      body: cleanBody(lines.join("\n")),
      problems: [
        {
          line: 1,
          message: "Knowledge items start with front matter between --- lines.",
        },
      ],
    };
  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (close < 0)
    return {
      fm: null,
      body: "",
      problems: [
        { line: 1, message: "The front matter has no closing --- line." },
      ],
    };
  const yamlLines = lines.slice(1, close);
  const body = cleanBody(lines.slice(close + 1).join("\n"));
  const scan = scanFrontMatter(yamlLines);
  if (scan.problems.length) return { fm: null, body, problems: scan.problems };
  let data: unknown;
  try {
    data = Bun.YAML.parse(yamlLines.join("\n"));
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
      .replace(/^YAML Parse error:\s*/i, "")
      .trim();
    return {
      fm: null,
      body,
      problems: [
        {
          line: 1,
          message: `The front matter isn't valid YAML${detail ? ` (${detail})` : ""}. Check quotes, brackets and colons.`,
        },
      ],
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return {
      fm: null,
      body,
      problems: [
        { line: 1, message: "The front matter must be `key: value` lines." },
      ],
    };
  const lineOf = (key: string): number => scan.keyLines.get(key) ?? 1;
  const { fm, problems } = readFrontMatter(
    path,
    data as Record<string, unknown>,
    lineOf,
  );
  return { fm: problems.length ? null : fm, body, problems };
}

function readFrontMatter(
  path: string,
  data: Record<string, unknown>,
  lineOf: (key: string) => number,
): { fm: KnowledgeFrontMatter; problems: ArticleProblem[] } {
  const problems: ArticleProblem[] = [];
  const add = (key: string, message: string) =>
    problems.push({ line: lineOf(key), message });
  const present = (key: string) =>
    data[key] !== undefined && data[key] !== null;

  for (const key of Object.keys(data)) {
    if (!(KEY_ORDER as readonly string[]).includes(key))
      add(key, `Unknown key "${key}".`);
  }

  const text = (key: string, max: number): string | undefined => {
    if (!present(key)) {
      if (REQUIRED.has(key)) add(key, `Missing \`${key}\`.`);
      return undefined;
    }
    const value = data[key];
    if (typeof value !== "string") {
      add(key, `\`${key}\` must be text.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      if (REQUIRED.has(key)) add(key, `Missing \`${key}\`.`);
      return undefined;
    }
    if (CONTROL.test(value)) {
      add(key, controlMessage(key));
      return undefined;
    }
    if (trimmed.length > max)
      add(
        key,
        `\`${key}\` is ${trimmed.length} characters; the limit is ${max}.`,
      );
    return trimmed;
  };

  const oneOf = <T extends string>(
    key: string,
    allowed: readonly T[],
  ): T | undefined => {
    const allowedText = allowed.join(", ");
    if (!present(key) || data[key] === "") {
      add(key, `Missing \`${key}\`. Use one of: ${allowedText}.`);
      return undefined;
    }
    const value = data[key];
    if (typeof value !== "string") {
      add(key, `\`${key}\` must be text.`);
      return undefined;
    }
    if (!(allowed as readonly string[]).includes(value)) {
      add(key, `Unknown ${key} "${value}". Use one of: ${allowedText}.`);
      return undefined;
    }
    return value as T;
  };

  const list = (key: string): string[] => {
    if (!present(key)) return [];
    const value = data[key];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      add(key, `\`${key}\` must be a list of text, like [a, b].`);
      return [];
    }
    if (value.some((v: string) => CONTROL.test(v))) {
      add(key, controlMessage(key));
      return [];
    }
    return value.map((v: string) => v.trim());
  };

  const day = (key: string): string | undefined => {
    if (!present(key) || data[key] === "") {
      if (REQUIRED.has(key)) add(key, `Missing \`${key}\`. Use YYYY-MM-DD.`);
      return undefined;
    }
    const value = data[key];
    if (typeof value !== "string") {
      add(key, `\`${key}\` must be text.`);
      return undefined;
    }
    if (!isDay(value)) {
      add(key, `\`${key}: ${value}\` is not a date. Use YYYY-MM-DD.`);
      return undefined;
    }
    return value;
  };

  const title = text("title", MAX_TITLE_CHARS);
  const kind = oneOf("kind", KNOWLEDGE_KINDS);
  const trust = oneOf("trust", KNOWLEDGE_TRUST);
  const status = oneOf("status", KNOWLEDGE_STATUSES);
  const origin = oneOf("origin", KNOWLEDGE_ORIGINS);
  const folderOrigin = originForPath(path);
  if (origin && folderOrigin && origin !== folderOrigin)
    add(
      "origin",
      `\`origin: ${origin}\` doesn't match the folder; items under ${folderFor(folderOrigin)}/ use \`origin: ${folderOrigin}\`.`,
    );
  const where = folderOrigin ?? origin;
  if (trust === "trusted" && where && REFERENCE_UNTIL_APPROVED.has(where))
    add(
      "trust",
      `Items under ${folderFor(where)}/ are reference until approved.`,
    );

  const topics = list("topics");
  if (topics.length > MAX_TOPICS)
    add(
      "topics",
      `\`topics\` has ${topics.length} entries; the limit is ${MAX_TOPICS}.`,
    );
  for (const topic of topics) {
    if (!topic) add("topics", "Topics can't be empty.");
    else if (topic.length > MAX_TOPIC_CHARS)
      add(
        "topics",
        `Topic "${topic.slice(0, 20)}…" is ${topic.length} characters; the limit is ${MAX_TOPIC_CHARS}.`,
      );
  }

  const sources = list("sources");
  for (const source of sources) {
    if (!isSourceRef(source))
      add("sources", `Unknown source "${source}". ${UNKNOWN_SOURCE_HINT}`);
  }

  const dependsOn = list("dependsOn");
  for (const dependency of dependsOn) {
    if (!parseDependency(dependency))
      add(
        "dependsOn",
        `Unknown dependency "${dependency}". Use repo:<path>, url:<http(s) URL>, issue:<n>, pr:<n> or release:<tag>.`,
      );
  }

  const validAsOf = day("validAsOf");
  let validAsOfCommit: string | undefined;
  if (present("validAsOfCommit") && data.validAsOfCommit !== "") {
    const value = data.validAsOfCommit;
    if (typeof value !== "string")
      add("validAsOfCommit", "`validAsOfCommit` must be text.");
    else if (!FULL_SHA.test(value))
      add(
        "validAsOfCommit",
        `\`validAsOfCommit: ${value}\` is not a full commit sha (40 or 64 lowercase hex characters).`,
      );
    else validAsOfCommit = value;
  }
  const reviewBy = day("reviewBy");

  const check = readCheck(data, status, add);

  const suggestedBy = text("suggestedBy", MAX_NAME_CHARS);
  const approvedBy = text("approvedBy", MAX_NAME_CHARS);
  let answeredAt: string | undefined;
  if (present("answeredAt") && data.answeredAt !== "") {
    const value = data.answeredAt;
    if (typeof value !== "string")
      add("answeredAt", "`answeredAt` must be text.");
    else if (!isTimestamp(value))
      add(
        "answeredAt",
        `\`answeredAt: ${value}\` is not a timestamp. Use YYYY-MM-DDTHH:MM:SSZ.`,
      );
    else if (where && where !== "mail")
      add("answeredAt", "`answeredAt` is only for mail items.");
    else answeredAt = value;
  } else if (where === "mail")
    add(
      "answeredAt",
      "Mail items need `answeredAt`. Use YYYY-MM-DDTHH:MM:SSZ.",
    );

  const fm: KnowledgeFrontMatter = {
    title: title ?? "",
    kind: kind ?? "answer",
    trust: trust ?? "reference",
    status: status ?? "needs-check",
    origin: origin ?? "article",
    topics,
    sources,
    dependsOn,
    validAsOf: validAsOf ?? "",
  };
  if (validAsOfCommit) fm.validAsOfCommit = validAsOfCommit;
  if (reviewBy) fm.reviewBy = reviewBy;
  if (check) fm.check = check;
  if (suggestedBy) fm.suggestedBy = suggestedBy;
  if (approvedBy) fm.approvedBy = approvedBy;
  if (answeredAt) fm.answeredAt = answeredAt;
  return { fm, problems };
}

function readCheck(
  data: Record<string, unknown>,
  status: string | undefined,
  add: (key: string, message: string) => void,
): KnowledgeCheckNote | undefined {
  const raw = data.check;
  const hasCheck = raw !== undefined && raw !== null;
  if (status !== "needs-check") {
    if (hasCheck && status)
      add("check", "`check` is only allowed with `status: needs-check`.");
    return undefined;
  }
  if (!hasCheck || typeof raw !== "object" || Array.isArray(raw)) {
    add(
      hasCheck ? "check" : "status",
      "`status: needs-check` needs `check.reason`: say what changed.",
    );
    return undefined;
  }
  const note = raw as Record<string, unknown>;
  let ok = true;
  for (const key of Object.keys(note)) {
    if (!(CHECK_ORDER as readonly string[]).includes(key)) {
      add("check", `Unknown key "check.${key}".`);
      ok = false;
    }
  }
  /** The trimmed text; "" when absent, null when already reported. */
  const field = (key: string): string | null => {
    const value = note[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") {
      add("check", `\`check.${key}\` must be text.`);
      ok = false;
      return null;
    }
    if (CONTROL.test(value)) {
      add("check", controlMessage(`check.${key}`));
      ok = false;
      return null;
    }
    return value.trim();
  };
  const reason = field("reason");
  if (reason === "") {
    add(
      "check",
      "`status: needs-check` needs `check.reason`: say what changed.",
    );
    ok = false;
  }
  const since = field("since");
  if (since === "") {
    add("check", "Missing `check.since`. Use YYYY-MM-DD.");
    ok = false;
  } else if (since !== null && !isDay(since)) {
    add("check", `\`check.since: ${since}\` is not a date. Use YYYY-MM-DD.`);
    ok = false;
  }
  const source = field("source");
  if (source && !isSourceRef(source, { allowPr: true })) {
    add("check", `Unknown source "${source}". ${UNKNOWN_SOURCE_HINT}`);
    ok = false;
  }
  const conflictWith = field("conflictWith");
  if (conflictWith && !isItemPath(conflictWith)) {
    add(
      "check",
      "`check.conflictWith` must be an item path, like articles/<slug>.md.",
    );
    ok = false;
  }
  if (!ok || !reason || !since) return undefined;
  const result: KnowledgeCheckNote = { reason, since };
  if (source) result.source = source;
  if (conflictWith) result.conflictWith = conflictWith;
  return result;
}

function controlMessage(key: string): string {
  return `\`${key}\` can't hold line breaks or control characters.`;
}

const PLAIN = /^[A-Za-z0-9_./(][^:#[\]{},"\\\u0000-\u001f\u007f]*$/;

/** A YAML scalar: plain when that reads back as the same string, otherwise
 *  JSON-quoted (JSON strings are valid YAML double-quoted strings). */
function scalar(value: string): string {
  if (PLAIN.test(value) && value === value.trim()) {
    try {
      const parsed = Bun.YAML.parse(`k: ${value}`) as { k?: unknown } | null;
      if (parsed?.k === value) return value;
    } catch {
      // Falls through to quoting.
    }
  }
  return JSON.stringify(value);
}

function flowList(values: string[]): string {
  return `[${values.map(scalar).join(", ")}]`;
}

const OPTIONAL = new Set<string>(KEY_ORDER.filter((key) => !REQUIRED.has(key)));

export function renderArticle(fm: KnowledgeFrontMatter, body: string): string {
  const text = cleanBody(body.replace(/\r\n?/g, "\n"));
  const block = renderFrontMatter(fm);
  return text ? `${block}\n${text}\n` : block;
}

/** The front matter block renderArticle writes, both `---` lines included,
 *  ending in a newline. Every writer renders, so a stored item's block is
 *  byte-equal to this (validateKnowledgeFile checks). */
export function renderFrontMatter(fm: KnowledgeFrontMatter): string {
  const lines = ["---"];
  for (const key of KEY_ORDER) {
    const value = fm[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length && OPTIONAL.has(key)) continue;
      lines.push(`${key}: ${flowList(value)}`);
    } else if (typeof value === "object") {
      const note = value as KnowledgeCheckNote;
      const parts = CHECK_ORDER.filter((k) => note[k]).map(
        (k) => `${k}: ${scalar(note[k] as string)}`,
      );
      if (parts.length) lines.push(`${key}: {${parts.join(", ")}}`);
    } else {
      if (value === "" && OPTIONAL.has(key)) continue;
      lines.push(`${key}: ${scalar(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}
