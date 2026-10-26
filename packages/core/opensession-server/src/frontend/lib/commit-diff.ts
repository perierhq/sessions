// A commit's unified diff (`git show --stat --patch`) as the settings pages
// show it: memory repositories (MemoryRepoPage) and knowledge history
// (knowledge/KnowledgeHistory), both through components/settings/CommitDiff.

/** Lines of a unified diff, tagged for colouring. */
export function diffLineTone(
  line: string,
): "add" | "remove" | "meta" | "plain" {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@") || line.startsWith("diff --git")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "plain";
}

/**
 * The part of a commit's diff about one file: its `diff --git` section,
 * without the stat block or the other files. The whole diff when the file
 * has no section of its own (a cut-off diff, or a path git quoted).
 */
export function diffForPath(diff: string, path: string): string {
  const header = `diff --git a/${path} b/${path}`;
  const lines = diff.split("\n");
  const start = lines.indexOf(header);
  if (start < 0) return diff;
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("diff --git "),
  );
  if (end < 0) end = lines.length;
  // A trailing blank line is git's last newline, not part of the file.
  while (end > start + 1 && lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n");
}
