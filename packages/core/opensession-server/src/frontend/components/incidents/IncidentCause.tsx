import type { IncidentCauseView } from "../../lib/incidents/cause";
import { renderMarkdown } from "../../lib/markdown";
import {
  INCIDENT_CAUSE_PROVENANCE,
  INCIDENT_CAUSE_TEXT,
  INCIDENT_SECTION_LABEL,
} from "../../lib/incident-classes";

const STATUS_WORDS: Record<IncidentCauseView["status"], string> = {
  verified: "verified by the verifier",
  doubted: "the verifier is not certain",
  unverified: "not verified yet",
};

/** A status that starts the line reads as a sentence. */
function leading(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The cause as the investigator wrote it, in Markdown: one plain sentence,
 * then any detail lines in a quieter voice. Under it, where it came from and
 * whether the verifier stood behind it. While agents work and nothing is known it keeps
 * its slot with "Not known yet", so the details below never jump down.
 */
export function IncidentCause({
  cause,
  waiting,
}: {
  cause: IncidentCauseView | null;
  waiting: boolean;
}) {
  if (!cause && !waiting) return null;
  return (
    <section className="-mx-2 flex min-w-0 flex-col">
      <h2 className={INCIDENT_SECTION_LABEL}>Cause</h2>
      <div className="flex min-w-0 flex-col gap-1 px-2">
        {cause ? (
          <>
            <div
              className={INCIDENT_CAUSE_TEXT}
              // renderMarkdown escapes raw HTML and keeps only safe links.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(cause.text) }}
            />
            <p className={INCIDENT_CAUSE_PROVENANCE}>
              {cause.source ? (
                <>
                  <a
                    href={cause.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link hover:underline"
                  >
                    {cause.source.label}
                  </a>
                  {" · "}
                  {STATUS_WORDS[cause.status]}
                </>
              ) : (
                leading(STATUS_WORDS[cause.status])
              )}
            </p>
          </>
        ) : (
          <p className="m-0 text-body text-faint">Not known yet</p>
        )}
      </div>
    </section>
  );
}
