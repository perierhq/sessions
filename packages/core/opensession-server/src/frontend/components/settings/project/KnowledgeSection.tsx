import useSWR from "swr";
import { useKnowledgeLiveConnected } from "../../../hooks/useKnowledgeLive";
import { apiSWRKey } from "../../../lib/api-swr";
import type { KnowledgeRoute } from "../../../lib/app-route";
import { fetchKnowledge, fetchKnowledgeJobs } from "../../../lib/api/knowledge";
import {
  KNOWLEDGE_SECTION_COUNT,
  KNOWLEDGE_SECTION_COUNTS,
  KNOWLEDGE_SECTION_COUNT_LABEL,
  KNOWLEDGE_SECTION_COUNT_VALUE,
} from "../../../lib/knowledge-classes";
import {
  knowledgeAlert,
  knowledgeErrorMessage,
  runningJob,
  runningJobLine,
  sectionCounts,
  type KnowledgeSectionCounts,
} from "../../../lib/knowledge/models";
import { Button } from "../../../ui/button";
import { PlainButton } from "../../../ui/plain-button";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
} from "../../../ui/settings";
import { InlineAlert } from "../../../ui/state";

/** While an import runs and the live channel is down, its line on the
 *  page follows it this often. */
const JOB_POLL_MS = 5_000;

const COUNTS: Array<{
  key: keyof KnowledgeSectionCounts;
  label: string;
  route: KnowledgeRoute;
}> = [
  { key: "articles", label: "Articles", route: { tab: "articles" } },
  { key: "needsCheck", label: "Needs check", route: { tab: "needs-check" } },
  { key: "suggestions", label: "Suggestions", route: { tab: "suggestions" } },
  // Reference opens the list already filtered to it.
  {
    key: "reference",
    label: "Reference",
    route: { tab: "articles", filter: "reference" },
  },
];

/**
 * The project page's Knowledge summary: how much there is, what needs a
 * person, the import running now, and the way into the Knowledge page.
 * Shown only while email support is on (visibleSections).
 */
export function KnowledgeSection({
  project,
  onOpen,
}: {
  project: string;
  onOpen: (route: KnowledgeRoute) => void;
}) {
  const list = useSWR(apiSWRKey.knowledge(project, "all"), () =>
    fetchKnowledge(project),
  );
  const live = useKnowledgeLiveConnected();
  const jobs = useSWR(
    apiSWRKey.knowledgeJobs(project),
    () => fetchKnowledgeJobs(project),
    {
      refreshInterval: (latest) =>
        !live && latest && runningJob(latest) ? JOB_POLL_MS : 0,
    },
  );

  if (list.error && !list.data)
    return (
      <InlineAlert
        {...knowledgeAlert(
          list.error,
          "Couldn't load the knowledge",
          () => void list.mutate(),
        )}
      />
    );
  if (!list.data) return <SettingCardSkeleton rows={2} />;

  const counts = sectionCounts(list.data.counts);
  const job = jobs.data ? runningJob(jobs.data) : null;
  return (
    <SettingCard>
      <div className={KNOWLEDGE_SECTION_COUNTS}>
        {COUNTS.map(({ key, label, route }) => (
          <PlainButton
            key={key}
            className={KNOWLEDGE_SECTION_COUNT}
            aria-label={`${label}: ${counts[key]}`}
            onClick={() => onOpen(route)}
          >
            <span className={KNOWLEDGE_SECTION_COUNT_VALUE}>{counts[key]}</span>
            <span className={KNOWLEDGE_SECTION_COUNT_LABEL}>{label}</span>
          </PlainButton>
        ))}
      </div>
      <SettingRow>
        <SettingRowText>
          <SettingRowDescription className="mt-0">
            {job
              ? runningJobLine(job)
              : "What support replies can rely on: articles your team writes, and what is imported from mail, docs and your website"}
          </SettingRowDescription>
        </SettingRowText>
        <SettingRowControl className="flex gap-2 phone:max-w-none">
          <Button
            type="button"
            size="sm"
            variant="soft"
            className="phone:min-h-11"
            onClick={() => onOpen({ tab: "import" })}
          >
            Import
          </Button>
          <Button
            type="button"
            size="sm"
            className="phone:min-h-11"
            onClick={() => onOpen({ tab: "articles" })}
          >
            Open knowledge
          </Button>
        </SettingRowControl>
      </SettingRow>
    </SettingCard>
  );
}
