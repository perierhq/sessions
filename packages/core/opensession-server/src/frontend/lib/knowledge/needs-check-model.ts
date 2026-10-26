// The Needs check tab's view model: items grouped by what changed under
// them, the two panes of one item's comparison, and the words around the
// queue's actions. Pure; no I/O, no React.

import type { KnowledgeItem } from "../../../shared/knowledge";
import type {
  KnowledgeNeedsCheckChange,
  KnowledgeRevalidateResult,
} from "../api/knowledge";
import { diffLineTone } from "../memory-repo";

/** Items that need a check for the same reason: one changed source, one
 *  disagreeing article, or a review date that passed. */
export interface NeedsCheckGroup {
  key: string;
  /** The reason, as the items' check note says it. */
  reason: string;
  /** `<reason> · <n> articles`. */
  line: string;
  items: KnowledgeItem[];
}

const REVIEW_PASSED = "Review date passed";

/** What groups an item: its check's source, else its reason. An item with
 *  no check note is there because its review date passed. */
function groupOf(item: KnowledgeItem): { key: string; reason: string } {
  const check = item.check;
  if (!check) return { key: "review", reason: REVIEW_PASSED };
  if (check.source)
    return { key: `source:${check.source}`, reason: check.reason };
  return { key: `reason:${check.reason}`, reason: check.reason };
}

/** `4 articles`, or `2 items` when anything isn't an article. */
export function countLine(items: Array<{ path: string }>): string {
  const n = items.length;
  const noun = items.every((i) => i.path.startsWith("articles/"))
    ? "article"
    : "item";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Items grouped by why they need a check, in the order the first of each
 *  group came. */
export function groupByReason(items: KnowledgeItem[]): NeedsCheckGroup[] {
  const groups = new Map<string, Omit<NeedsCheckGroup, "line">>();
  for (const item of items) {
    const { key, reason } = groupOf(item);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { key, reason, items: [item] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    line: `${group.reason} · ${countLine(group.items)}`,
  }));
}

export type PatchTone = ReturnType<typeof diffLineTone>;

export interface PaneSide {
  label: string;
  /** Plain text to show; absent when `patchLines` carries the change. */
  text?: string;
  /** A unified diff's hunks, each line toned (diffLineTone). */
  patchLines?: Array<{ text: string; tone: PatchTone }>;
  /** A page's address, or the other article's path. */
  link?: string;
  /** The change couldn't be read; `text` says so. */
  missing?: true;
}

export interface ChangePane {
  title: string;
  left: { label: "Article"; text: string };
  right: PaneSide;
}

const NOTHING_CHANGED =
  "Nothing it depends on changed. Read it again and confirm it's still right";

/** The hunks of a unified diff: the file headers above the first `@@`
 *  only repeat what the pane's title says. */
function patchLines(patch: string): PaneSide["patchLines"] {
  const lines = patch.replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  return lines
    .slice(start < 0 ? 0 : start)
    .map((text) => ({ text, tone: diffLineTone(text) }));
}

function readOrMissing(
  label: string,
  text: string | undefined,
  missing: string,
  link?: string,
): PaneSide {
  const side: PaneSide =
    text === undefined ? { label, text: missing, missing: true } : { label, text };
  if (link) side.link = link;
  return side;
}

/** One item's comparison: its own text on the left, what changed on the
 *  right (the patch, the page now, the release notes, or the article it
 *  disagrees with). `body` is the item's Markdown body. */
export function changePane(
  change: KnowledgeNeedsCheckChange,
  body: string,
): ChangePane {
  const left = { label: "Article" as const, text: body };
  const pane = (right: PaneSide): ChangePane => ({
    title: change.title,
    left,
    right,
  });
  switch (change.kind) {
    case "repo":
      if (change.patch)
        return pane({
          label: "What changed",
          patchLines: patchLines(change.patch),
        });
      return pane(
        readOrMissing(
          "What changed",
          change.after,
          "The change couldn't be read right now",
        ),
      );
    case "url":
      return pane(
        readOrMissing(
          "The page now",
          change.after,
          "The page couldn't be read right now",
          change.link,
        ),
      );
    case "release":
      return pane(
        readOrMissing(
          "Release notes",
          change.after,
          "The release notes couldn't be read right now",
        ),
      );
    case "conflict":
      return pane(
        readOrMissing(
          "The other article",
          change.after,
          "The other article couldn't be read right now",
          change.link,
        ),
      );
    case "issue":
      return pane({ label: "What changed", text: change.title });
    case "review":
      return pane({ label: "What changed", text: NOTHING_CHANGED });
  }
}

/** The confirm a group's "Still true for all" asks first; `onConfirm`
 *  confirms every item in the group as one commit. */
export function confirmGroupRequest<T>(
  project: string,
  group: NeedsCheckGroup,
  confirm: (project: string, paths: string[]) => Promise<T>,
): {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<T>;
} {
  const n = group.items.length;
  return {
    title: `Mark ${countLine(group.items)} still true?`,
    description:
      "Each is marked as checked today, against the code as it is now",
    confirmLabel: `Still true for all (${n})`,
    onConfirm: () =>
      confirm(
        project,
        group.items.map((i) => i.path),
      ),
  };
}

/** What "Check now" says when the run is done. */
export function checkNowLine(result: KnowledgeRevalidateResult): {
  text: string;
  failed: boolean;
} {
  const text = `Checked ${result.checked}, ${result.flipped.length} need a check`;
  return result.errors.length
    ? { text: `${text}. Some sources couldn't be read`, failed: true }
    : { text, failed: false };
}
