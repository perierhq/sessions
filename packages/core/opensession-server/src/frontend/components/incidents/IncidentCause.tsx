import type { IncidentCauseView } from "../../lib/incidents/cause";
import {
  INCIDENT_CAUSE_PROVENANCE,
  INCIDENT_CAUSE_TEXT,
} from "../../lib/incident-classes";
import { WS_SUMMARY_PAGE_SECTION } from "../../lib/workspace-summary-classes";

const STATUS_WORDS: Record<IncidentCauseView["status"], string> = {
  verified: "verified by the verifier",
  doubted: "the verifier is not certain",
  unverified: "not verified yet",
};

/**
 * The cause in one sentence, then where it came from and whether the
 * verifier stood behind it. While agents work and nothing is known it keeps
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
      <h2 className={WS_SUMMARY_PAGE_SECTION}>Cause</h2>
      <div className="flex min-w-0 flex-col gap-1 px-2">
        {cause ? (
          <>
            <p className={INCIDENT_CAUSE_TEXT}>{cause.text}</p>
            <p className={INCIDENT_CAUSE_PROVENANCE}>
              {cause.source && (
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
                </>
              )}
              {STATUS_WORDS[cause.status]}
            </p>
          </>
        ) : (
          <p className="m-0 text-body text-faint">Not known yet</p>
        )}
      </div>
    </section>
  );
}
