import type { ProjectGitAccessIssue } from "../../../../shared/project-settings";
import { clockTime, shortTime } from "../../../lib/time";
import { InlineAlert } from "../../../ui/state";

/**
 * Background git fetches for this project can't sign in to GitHub, so they
 * back off instead of retrying every few minutes. Says since when, when the
 * next try is, and what git said; the next fetch that works clears it.
 */
export function GitAccessNotice({ issue }: { issue: ProjectGitAccessIssue }) {
  const since = shortTime(issue.since);
  const next = clockTime(issue.nextAttemptAt);
  const cause =
    issue.kind === "helper"
      ? "The checkout's credential helper can't run."
      : "GitHub refused the project's credential.";
  return (
    <InlineAlert
      variant="warn"
      className="mb-3"
      title="Git can't sign in to GitHub"
    >
      <p>
        {cause} Background fetches have failed
        {since && since !== "now" ? ` for ${since}` : ""} and back off
        {next ? `; next try at ${next}` : ""}. The next fetch that works clears
        this.
      </p>
      <p className="mt-1 break-words font-mono text-supporting">
        {issue.lastError}
      </p>
    </InlineAlert>
  );
}
