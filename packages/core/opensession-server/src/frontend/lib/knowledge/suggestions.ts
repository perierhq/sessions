// A suggestion's row on the Suggestions tab. Pure; no I/O, no React.

import type { KnowledgeItem } from "../../../shared/knowledge";

const OLDER = "Built from replies older than ";

/** "2 sources", then why it may be out of date: a suggestion whose check
 *  note is set rests on replies older than a change (its `check.reason`
 *  names the change, e.g. "the v1.4.0 release"). */
export function suggestionLine(
  item: Pick<KnowledgeItem, "sources" | "check">,
): string {
  const n = item.sources.length;
  const count =
    n === 0 ? "No sources" : `${n} ${n === 1 ? "source" : "sources"}`;
  const reason = item.check?.reason.trim();
  if (!reason) return count;
  return `${count} · ${reason.startsWith(OLDER) ? reason : OLDER + reason}`;
}
