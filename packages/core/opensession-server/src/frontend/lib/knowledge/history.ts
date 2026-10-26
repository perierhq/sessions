import type { KnowledgeCommit } from "../api/knowledge";

// What a knowledge item's history says about each commit
// (components/settings/knowledge/KnowledgeHistory).

/** Who proposed the change: the commit's `Suggested-by:` trailer (Pat on
 *  imports, re-validation and the approvals of its suggestions). */
export function suggestedBy(commit: KnowledgeCommit): string | null {
  const match = /^suggested-by:[ \t]*(.+)$/im.exec(commit.body);
  return match?.[1]?.trim() || null;
}

/** The line under a commit's subject: both people for an approval, else
 *  the author. */
export function commitByline(commit: KnowledgeCommit): string {
  const proposer = suggestedBy(commit);
  if (proposer && proposer !== commit.author)
    return `Suggested by ${proposer}, approved by ${commit.author}`;
  return commit.author;
}

const files = (n: number, other = "") =>
  `${n} ${other}${n === 1 ? "file" : "files"}`;

/** The title and sentence of the confirm before a revert. */
export interface RevertCopy {
  title: string;
  description: string;
}

/** The confirm before a revert. A revert undoes the whole commit, so it
 *  says when that reaches past the item whose history this is (`path`;
 *  undefined for the whole repository's). */
export function revertCopy(
  commit: KnowledgeCommit,
  path: string | undefined,
): RevertCopy {
  const undoes = `Adds a new change that undoes “${commit.subject}”`;
  let rest = "";
  if (path === undefined) {
    if (commit.files.length > 1) rest = ` in ${files(commit.files.length)}`;
  } else {
    const others = commit.files.filter((file) => file.path !== path).length;
    if (others) rest = `, including ${files(others, "other ")}`;
  }
  return { title: "Revert this change?", description: `${undoes}${rest}.` };
}
