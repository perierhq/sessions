import {
  gitAccessTitle,
  type ProjectGitAccessIssue,
} from "../../../../shared/project-settings";
import { clockTime, shortTime } from "../../../lib/time";
import { InlineAlert } from "../../../ui/state";

/**
 * Background git fetches for this project can't sign in to GitHub (a refused
 * credential, a helper that can't run, or no token because the GitHub App
 * isn't installed for the repository), so they back off instead of retrying
 * every few minutes. Says since when, when the
 * next try is, and what git said; the next fetch that works clears it.
 */
export function GitAccessNotice({ issue }: { issue: ProjectGitAccessIssue }) {
  const since = shortTime(issue.since);
  const next = clockTime(issue.nextAttemptAt);
  const cause =
    issue.kind === "helper"
      ? "The checkout's credential helper can't run."
      : issue.kind === "not-installed"
        ? `The server has no GitHub token for this repository. Install the GitHub App on ${issue.ghRepo?.split("/")[0] || "its owner"} with access to it.`
        : "GitHub refused the project's credential.";
  return (
    <InlineAlert variant="warn" className="mb-3" title={gitAccessTitle(issue)}>
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
