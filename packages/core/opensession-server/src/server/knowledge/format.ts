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
import { folderFor, originForPath } from "./layout";

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

const SOURCE_KINDS = ["mail", "repo", "url", "issue", "release", "file"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FENCE = /^---[ \t]*$/;

export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
  );
}

function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  );
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
  const lineOf = (key: string): number => {
    const index = yamlLines.findIndex((line) =>
      new RegExp(`^${key}\\s*:`).test(line),
    );
    return index < 0 ? 1 : index + 2;
  };
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
    const value = String(data[key]);
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
    return value.map((v: string) => v.trim());
  };

  const day = (key: string): string | undefined => {
    if (!present(key) || data[key] === "") {
      if (REQUIRED.has(key)) add(key, `Missing \`${key}\`. Use YYYY-MM-DD.`);
      return undefined;
    }
    const value = String(data[key]);
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
    const colon = source.indexOf(":");
    if (colon <= 0 || colon === source.length - 1) {
      add(
        "sources",
        `Unknown source "${source}". Use ${SOURCE_KINDS.map((k) => `${k}:`).join(", ")} followed by the reference.`,
      );
    } else if (!SOURCE_KINDS.includes(source.slice(0, colon))) {
      add(
        "sources",
        `Unknown source "${source}". Use ${SOURCE_KINDS.map((k) => `${k}:`).join(", ")} followed by the reference.`,
      );
    }
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
    const value = String(data.validAsOfCommit);
    if (!FULL_SHA.test(value))
      add(
        "validAsOfCommit",
        `\`validAsOfCommit: ${value}\` is not a full commit sha (40 lowercase hex characters).`,
      );
    else validAsOfCommit = value;
  }
  const reviewBy = day("reviewBy");

  const check = readCheck(data, status, add);

  const suggestedBy = text("suggestedBy", MAX_NAME_CHARS);
  const approvedBy = text("approvedBy", MAX_NAME_CHARS);
  let answeredAt: string | undefined;
  if (present("answeredAt") && data.answeredAt !== "") {
    const value = String(data.answeredAt);
    if (!isTimestamp(value))
      add(
        "answeredAt",
        `\`answeredAt: ${value}\` is not a timestamp. Use YYYY-MM-DDTHH:MM:SSZ.`,
      );
    else if (origin && origin !== "mail")
      add("answeredAt", "`answeredAt` is only for mail items.");
    else answeredAt = value;
  }

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
  const field = (key: string) =>
    typeof note[key] === "string" ? (note[key] as string).trim() : "";
  const reason = field("reason");
  if (!reason) {
    add(
      "check",
      "`status: needs-check` needs `check.reason`: say what changed.",
    );
    ok = false;
  }
  const since = note.since === undefined ? "" : String(note.since);
  if (!since) {
    add("check", "Missing `check.since`. Use YYYY-MM-DD.");
    ok = false;
  } else if (!isDay(since)) {
    add("check", `\`check.since: ${since}\` is not a date. Use YYYY-MM-DD.`);
    ok = false;
  }
  if (!ok) return undefined;
  const result: KnowledgeCheckNote = { reason, since };
  const source = field("source");
  const conflictWith = field("conflictWith");
  if (source) result.source = source;
  if (conflictWith) result.conflictWith = conflictWith;
  return result;
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
  const text = cleanBody(body.replace(/\r\n?/g, "\n"));
  return text ? `${lines.join("\n")}\n\n${text}\n` : `${lines.join("\n")}\n`;
}
