#!/usr/bin/env bun
/**
 * Lists upstream (tellahq/opensession) commits that this fork has neither
 * ported nor recorded as skipped. See docs/upstream-sync.md.
 *
 *   bun scripts/upstream-pending.ts            # pending commits, oldest first
 *   bun scripts/upstream-pending.ts --all      # every upstream commit with its state
 *   bun scripts/upstream-pending.ts --no-fetch # use the refs already fetched
 *
 * A commit counts as ported when a commit on origin/main carries the trailer
 * `Upstream: tellahq/opensession@<sha>` (full or abbreviated sha), and as
 * skipped when its sha is in the "Skipped" table of docs/upstream-sync.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const UPSTREAM_TRAILER =
  /Upstream: tellahq\/opensession@([0-9a-f]{7,40})/g;
const FORK_POINT = /Forked from: `tellahq\/opensession` at `([0-9a-f]{40})`/;
const SKIP_ROW = /^\|\s*`?([0-9a-f]{7,40})`?\s*\|/;

export type UpstreamCommit = { sha: string; subject: string };
export type CommitState = "pending" | "ported" | "skipped";

/** Short or full shas named by `Upstream:` trailers in a git log body dump. */
export function portedShas(log: string): string[] {
  return [...log.matchAll(UPSTREAM_TRAILER)].map((m) => m[1]!);
}

/** Shas listed in the doc's "Skipped" table (first column). */
export function skippedShas(doc: string): string[] {
  const start = doc.indexOf("## Skipped");
  if (start < 0) return [];
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .map((line) => SKIP_ROW.exec(line)?.[1])
    .filter((sha): sha is string => !!sha);
}

export function stateOf(
  sha: string,
  ported: string[],
  skipped: string[],
): CommitState {
  const named = (list: string[]) =>
    list.some((s) => sha.startsWith(s) || s.startsWith(sha));
  if (named(ported)) return "ported";
  if (named(skipped)) return "skipped";
  return "pending";
}

function git(args: string[], cwd: string): string {
  const out = Bun.spawnSync(["git", ...args], { cwd });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${out.stderr.toString().trim()}`);
  }
  return out.stdout.toString();
}

function main() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const args = new Set(process.argv.slice(2));
  if (!args.has("--no-fetch")) git(["fetch", "-q", "upstream", "origin"], root);

  const fork = FORK_POINT.exec(readFileSync(join(root, "NOTICE.md"), "utf8"));
  if (!fork) throw new Error("NOTICE.md does not name the fork point");
  const upstream: UpstreamCommit[] = git(
    [
      "log",
      "--reverse",
      "--no-merges",
      "--format=%H%x09%s",
      `${fork[1]}..upstream/main`,
    ],
    root,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
  const ported = portedShas(
    git(
      [
        "log",
        "origin/main",
        "--format=%B",
        "--grep=Upstream: tellahq/opensession@",
      ],
      root,
    ),
  );
  const skipped = skippedShas(
    readFileSync(join(root, "docs/upstream-sync.md"), "utf8"),
  );

  let pending = 0;
  for (const c of upstream) {
    const state = stateOf(c.sha, ported, skipped);
    if (state === "pending") pending++;
    if (state === "pending" || args.has("--all")) {
      const tag = args.has("--all") ? `${state.padEnd(8)} ` : "";
      console.log(`${tag}${c.sha.slice(0, 9)} ${c.subject}`);
    }
  }
  console.error(
    `${upstream.length} upstream commits since the fork point, ${pending} pending`,
  );
}

if (import.meta.main) main();
