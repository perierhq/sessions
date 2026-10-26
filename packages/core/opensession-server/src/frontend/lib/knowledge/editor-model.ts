// The article editor's state: what the form holds, what it saves and what
// it refuses before anything is sent. Pure; no I/O, no React. The server
// checks everything again (server/knowledge/format.ts); these are the same
// rules said early, under the field that broke them.

import {
  parseDependency,
  type KnowledgeFrontMatter,
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeStatus,
  type KnowledgeTrust,
} from "../../../shared/knowledge";

/** What the form shows as controls. Lists are edited as text: topics comma
 *  separated, sources and dependencies one per line. */
export interface EditorState {
  /** The item's path; null for a new article (the server names it). */
  path: string | null;
  /** The blob read before editing; null for a new article. */
  blob: string | null;
  title: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  topics: string;
  sources: string;
  dependsOn: string;
  /** YYYY-MM-DD. */
  validAsOf: string;
  /** YYYY-MM-DD, or "" for none. */
  reviewBy: string;
  body: string;
  /** "Confirm against the current docs": after saving, stamp the item with
   *  today and the code repository's current head. Only while active. */
  confirm: boolean;
  /** The day the form was opened (YYYY-MM-DD), for a person's check note. */
  today: string;
  /** Front matter the form doesn't edit, kept as read. */
  kept: KeptFrontMatter;
}

type KeptFrontMatter = Pick<KnowledgeFrontMatter, "trust" | "origin"> &
  Partial<
    Pick<
      KnowledgeFrontMatter,
      "validAsOfCommit" | "check" | "suggestedBy" | "approvedBy" | "answeredAt"
    >
  >;

export type EditorField =
  | "title"
  | "topics"
  | "sources"
  | "dependsOn"
  | "validAsOf"
  | "reviewBy"
  | "body";

export type EditorErrors = Partial<Record<EditorField, string>>;

/** The route path that opens the editor on a new article (no item path
 *  is a bare word: they all sit in a folder). */
export const NEW_ARTICLE = "new";

/** What a 409 on Save says; the form offers Reload beside it. */
export const CONFLICT_COPY =
  "Someone changed this article. Reload and try again.";

/** What Attach offers: screenshots and PDFs (routes/knowledge.ts). */
export const ATTACH_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf";

/** The editor's subtitle: trust is set by where an item lives, not here. */
export function trustLine(trust: KnowledgeTrust): string {
  return trust === "trusted"
    ? "Trusted: can back an automatic reply while it is fresh"
    : "Reference: informs replies, never backs one by itself";
}

/** The reason written when a person sets an item to needs-check. */
export const PERSON_CHECK_REASON = "Marked by a person";

/** Where `sources` entries may come from (server/knowledge/format.ts). */
const SOURCE_PREFIXES = [
  "mail:",
  "conversation:",
  "thread:",
  "repo:",
  "url:",
  "issue:",
  "release:",
  "file:",
] as const;

const MAX_TITLE = 200;
const MAX_TOPICS = 12;
const MAX_TOPIC = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The form for `read`, or for a new article when it is null. */
export function editorState(
  read: { item: KnowledgeItem; body: string } | null,
  today: string,
): EditorState {
  if (!read)
    return {
      path: null,
      blob: null,
      title: "",
      kind: "answer",
      status: "active",
      topics: "",
      sources: "",
      dependsOn: "",
      validAsOf: today,
      reviewBy: "",
      body: "",
      confirm: false,
      today,
      kept: { trust: "trusted", origin: "article" },
    };
  const { item, body } = read;
  const kept: KeptFrontMatter = { trust: item.trust, origin: item.origin };
  if (item.validAsOfCommit) kept.validAsOfCommit = item.validAsOfCommit;
  if (item.check) kept.check = item.check;
  if (item.suggestedBy) kept.suggestedBy = item.suggestedBy;
  if (item.approvedBy) kept.approvedBy = item.approvedBy;
  if (item.answeredAt) kept.answeredAt = item.answeredAt;
  return {
    path: item.path,
    blob: item.blob,
    title: item.title,
    kind: item.kind,
    status: item.status,
    topics: item.topics.join(", "),
    sources: item.sources.join("\n"),
    dependsOn: item.dependsOn.join("\n"),
    validAsOf: item.validAsOf,
    reviewBy: item.reviewBy ?? "",
    body,
    confirm: false,
    today,
    kept,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function topicList(text: string): string[] {
  return unique(
    text
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function lineList(text: string): string[] {
  return unique(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/** What Save sends: the front matter and the Markdown body. */
export interface EditorSave {
  fm: KnowledgeFrontMatter;
  body: string;
}

/** The front matter and body to send. */
export function toSave(state: EditorState): EditorSave {
  const { kept } = state;
  const fm: KnowledgeFrontMatter = {
    title: state.title.trim(),
    kind: state.kind,
    trust: kept.trust,
    status: state.status,
    origin: kept.origin,
    topics: topicList(state.topics),
    sources: lineList(state.sources),
    dependsOn: lineList(state.dependsOn),
    validAsOf: state.validAsOf,
  };
  if (kept.validAsOfCommit) fm.validAsOfCommit = kept.validAsOfCommit;
  if (state.reviewBy) fm.reviewBy = state.reviewBy;
  // A check note goes with needs-check and nowhere else.
  if (state.status === "needs-check")
    fm.check = kept.check ?? {
      reason: PERSON_CHECK_REASON,
      since: state.today,
    };
  if (kept.suggestedBy) fm.suggestedBy = kept.suggestedBy;
  if (kept.approvedBy) fm.approvedBy = kept.approvedBy;
  if (kept.answeredAt) fm.answeredAt = kept.answeredAt;
  return { fm, body: state.body };
}

/** What stops the form from saving, by field. Empty when it may save. */
export function validateEditor(
  state: EditorState,
  today: string,
): EditorErrors {
  const errors: EditorErrors = {};
  const title = state.title.trim();
  if (!title) errors.title = "Add a title";
  else if (title.length > MAX_TITLE)
    errors.title = `Keep the title under ${MAX_TITLE} characters`;

  const topics = topicList(state.topics);
  if (topics.length > MAX_TOPICS)
    errors.topics = `At most ${MAX_TOPICS} topics`;
  else if (topics.some((t) => t.length > MAX_TOPIC))
    errors.topics = `Keep each topic under ${MAX_TOPIC} characters`;

  const badSource = lineList(state.sources).find(
    (s) => !SOURCE_PREFIXES.some((p) => s.startsWith(p) && s.length > p.length),
  );
  if (badSource) errors.sources = `Not a source: ${badSource}`;

  const badDependency = lineList(state.dependsOn).find(
    (d) => !parseDependency(d),
  );
  if (badDependency) errors.dependsOn = `Not a dependency: ${badDependency}`;

  if (!DAY.test(state.validAsOf))
    errors.validAsOf = "Pick the day it was last known right";
  else if (state.validAsOf > today)
    errors.validAsOf = "Valid as of can't be in the future";

  if (state.reviewBy) {
    if (!DAY.test(state.reviewBy)) errors.reviewBy = "Pick a day";
    else if (DAY.test(state.validAsOf) && state.reviewBy <= state.validAsOf)
      errors.reviewBy = "Review by must be after Valid as of";
  }

  if (!state.body.trim()) errors.body = "Write the article";
  return errors;
}

/** Whether `a` and `b` would save the same thing. */
export function sameEdit(a: EditorState, b: EditorState): boolean {
  return (
    JSON.stringify(toSave(a)) === JSON.stringify(toSave(b)) &&
    a.confirm === b.confirm
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** `../` up to the repository root from `articlePath`'s folder. */
function upToRoot(articlePath: string): string {
  return "../".repeat(articlePath.split("/").length - 1);
}

/** The Markdown that shows `attachmentPath` in `articlePath`: an image
 *  inline, anything else a link. */
export function attachmentLink(
  articlePath: string,
  attachmentPath: string,
): string {
  const name = attachmentPath.split("/").pop() ?? attachmentPath;
  const href =
    upToRoot(articlePath) +
    attachmentPath.split("/").map(encodeURIComponent).join("/");
  return IMAGE.test(name) ? `![${name}](${href})` : `[${name}](${href})`;
}

/** `body` with `link` on its own line at the end. */
export function withLink(body: string, link: string): string {
  const trimmed = body.replace(/\n*$/, "");
  return trimmed ? `${trimmed}\n\n${link}\n` : `${link}\n`;
}

const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)\)/g;

/** The attachments `body` links to, in order, once each. */
export function bodyAttachments(
  articlePath: string,
  body: string,
): Array<{ name: string; path: string }> {
  const prefix = `${upToRoot(articlePath)}attachments/`;
  const seen = new Set<string>();
  const out: Array<{ name: string; path: string }> = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const href = match[1]!;
    if (!href.startsWith(prefix)) continue;
    let path: string;
    try {
      path = decodeURIComponent(href.slice(upToRoot(articlePath).length));
    } catch {
      continue;
    }
    if (path.split("/").some((part) => part === ".." || part === "")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ name: path.split("/").pop()!, path });
  }
  return out;
}
