/**
 * What the mirror imports (repository docs, releases, website) share
 * about mirrors already there: an import overwrites only what Pat wrote
 * last (a person's retire or edit wins), and a mirror whose source can no
 * longer be copied is flipped to needs-check rather than left trusted.
 */
import { knowledgeRepo } from "../client";
import {
  frontMatterOf,
  PAT_AUTHOR,
  PAT_TRAILER,
} from "../freshness/revalidate";
import type { KnowledgeChange } from "../service";

/** Whether Pat wrote `path` last: an import may overwrite only its own
 *  writes; a person's retire or edit wins. True for a path with no
 *  history. */
export async function lastWrittenByPat(
  project: string,
  path: string,
): Promise<boolean> {
  const [last] = await knowledgeRepo.call("history", project, path, 1);
  if (!last) return true;
  return (
    last.author === PAT_AUTHOR.name &&
    last.body.split("\n").some((line) => line.trim() === PAT_TRAILER)
  );
}

/** A mirror whose source can't be copied any more, flipped to needs-check
 *  with `reason` and its text kept; null when it is retired, already
 *  waiting for a person, or a person wrote it last. */
export async function needsCheckChange(
  project: string,
  path: string,
  reason: string,
  today: string,
): Promise<{ change: KnowledgeChange; blob: string } | null> {
  const current = await knowledgeRepo.call("read", project, path, today);
  if (!current || current.item.status !== "active") return null;
  if (!(await lastWrittenByPat(project, path))) return null;
  return {
    change: {
      op: "put",
      path,
      fm: {
        ...frontMatterOf(current.item),
        status: "needs-check",
        check: { reason, since: today },
      },
      body: current.body,
    },
    blob: current.item.blob,
  };
}
