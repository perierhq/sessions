import { diffForPath, diffLineTone } from "../../lib/commit-diff";
import { cn } from "../../ui/cn";

/**
 * One commit's unified diff in the code well: added lines green, removed
 * red, headers dim. A memory repository's changes (MemoryRepoPage) and a
 * knowledge item's history (knowledge/KnowledgeHistory) both show it; with
 * `path`, only that file's part of the commit.
 */
export function CommitDiff({ diff, path }: { diff: string; path?: string }) {
  const shown = path ? diffForPath(diff, path) : diff;
  return (
    <pre className="m-0 max-h-96 overflow-auto rounded-xl bg-code-well p-3 font-mono text-meta leading-relaxed text-code-well-ink">
      {shown.split("\n").map((line, index) => {
        const tone = diffLineTone(line);
        return (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap break-words",
              tone === "add" && "text-green",
              tone === "remove" && "text-red",
              tone === "meta" && "text-dim",
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
