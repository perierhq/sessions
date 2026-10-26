import useSWR from "swr";
import type { KnowledgeFilter } from "../../../../shared/knowledge";
import { apiSWRKey } from "../../../lib/api-swr";
import type { KnowledgeRoute, KnowledgeTab } from "../../../lib/app-route";
import {
  fetchKnowledge,
  fetchKnowledgeHistory,
  fetchKnowledgeJobs,
} from "../../../lib/api/knowledge";
import { relativeTime } from "../../../lib/api/request";
import { errorMessage } from "../../../lib/error-message";
import {
  KNOWLEDGE_PAGE_BACK,
  KNOWLEDGE_ROW,
  KNOWLEDGE_ROW_HEAD,
  KNOWLEDGE_ROW_LINE,
  KNOWLEDGE_ROW_TITLE,
  KNOWLEDGE_TAB,
  KNOWLEDGE_TAB_COUNT,
  KNOWLEDGE_TABS_SCROLL,
} from "../../../lib/knowledge-classes";
import {
  emptyCopy,
  freshnessLine,
  itemBadges,
  jobLine,
  runningJob,
} from "../../../lib/knowledge/models";
import { PROJECT_PAGE_FRAME } from "../../../lib/project-settings-classes";
import { repoLabel } from "../../../lib/repo-label";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsHeader,
  SettingsPanel,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { IconChevronLeft } from "../../icons";

/** The tabs in the bar, in order. History opens from an item's page. */
const TABS: Array<{ tab: KnowledgeTab; label: string }> = [
  { tab: "articles", label: "Articles" },
  { tab: "suggestions", label: "Suggestions" },
  { tab: "needs-check", label: "Needs check" },
  { tab: "import", label: "Import" },
];

/** The list each list tab shows. */
const TAB_FILTERS: Partial<Record<KnowledgeTab, KnowledgeFilter>> = {
  articles: "all",
  suggestions: "suggestions",
  "needs-check": "needs-check",
};

const JOB_POLL_MS = 5_000;

/** The day, read in UTC, for the freshness lines. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A project's Knowledge: a back link to the project's page, the project's
 * name, and a tab bar (Articles, Suggestions, Needs check, Import) over the
 * tab's content. The same page at both widths; on a phone the tab bar
 * scrolls sideways.
 */
export function KnowledgePage({
  project,
  route,
  onNavigate,
  onBack,
}: {
  project: string;
  route: KnowledgeRoute;
  onNavigate: (route: KnowledgeRoute) => void;
  /** Back to the project's page, at its Knowledge section. */
  onBack: () => void;
}) {
  // The list's counts; the same request the project page's section makes.
  const all = useSWR(apiSWRKey.knowledge(project, "all"), () =>
    fetchKnowledge(project),
  );
  const counts = all.data?.counts;
  const tabCount = (tab: KnowledgeTab) =>
    tab === "suggestions"
      ? counts?.suggestions
      : tab === "needs-check"
        ? counts?.["needs-check"]
        : undefined;
  const filter = TAB_FILTERS[route.tab];

  return (
    <div className={PROJECT_PAGE_FRAME}>
      <SettingsPanel className="self-start">
        <div className={KNOWLEDGE_PAGE_BACK}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="phone:min-h-11"
            icon={<IconChevronLeft size={18} />}
            aria-label={`Back to ${repoLabel(project)}`}
            onClick={onBack}
          >
            Back
          </Button>
        </div>
        <SettingsHeader
          title={repoLabel(project)}
          description="Knowledge: what support replies can rely on"
        />
        <div className={KNOWLEDGE_TABS_SCROLL}>
          <Segmented
            label="Knowledge"
            value={TABS.some((t) => t.tab === route.tab) ? route.tab : null}
            onValueChange={(value) => {
              const tab = TABS.find((t) => t.tab === value)?.tab;
              if (tab) onNavigate({ tab });
            }}
            className="w-max"
          >
            {TABS.map(({ tab, label }) => {
              const n = tabCount(tab);
              return (
                <SegmentedOption
                  key={tab}
                  value={tab}
                  className={KNOWLEDGE_TAB}
                >
                  {label}
                  {n ? <span className={KNOWLEDGE_TAB_COUNT}>{n}</span> : null}
                </SegmentedOption>
              );
            })}
          </Segmented>
        </div>
        {filter ? (
          <ItemList key={filter} project={project} filter={filter} />
        ) : route.tab === "import" ? (
          <ImportJobs project={project} />
        ) : (
          <History project={project} path={route.path} />
        )}
      </SettingsPanel>
    </div>
  );
}

function ItemList({
  project,
  filter,
}: {
  project: string;
  filter: KnowledgeFilter;
}) {
  const list = useSWR(apiSWRKey.knowledge(project, filter), () =>
    fetchKnowledge(project, { filter }),
  );
  if (list.error && !list.data)
    return (
      <InlineAlert onRetry={() => void list.mutate()}>
        {errorMessage(list.error, "Couldn't load the knowledge")}
      </InlineAlert>
    );
  if (!list.data) return <SettingCardSkeleton rows={4} />;
  if (!list.data.items.length)
    return <EmptyState placement="card">{emptyCopy(filter)}</EmptyState>;
  const day = today();
  return (
    <SettingCard>
      {list.data.items.map((item) => (
        <div key={item.path} className={KNOWLEDGE_ROW}>
          <div className={KNOWLEDGE_ROW_HEAD}>
            <span className={KNOWLEDGE_ROW_TITLE}>{item.title}</span>
            {itemBadges(item).map((badge) => (
              <Badge key={badge.label} tone={badge.tone}>
                {badge.label}
              </Badge>
            ))}
          </div>
          <div className={KNOWLEDGE_ROW_LINE}>{freshnessLine(item, day)}</div>
        </div>
      ))}
    </SettingCard>
  );
}

function ImportJobs({ project }: { project: string }) {
  const jobs = useSWR(
    apiSWRKey.knowledgeJobs(project),
    () => fetchKnowledgeJobs(project),
    {
      refreshInterval: (latest) =>
        latest && runningJob(latest) ? JOB_POLL_MS : 0,
    },
  );
  if (jobs.error && !jobs.data)
    return (
      <InlineAlert onRetry={() => void jobs.mutate()}>
        {errorMessage(jobs.error, "Couldn't load the imports")}
      </InlineAlert>
    );
  if (!jobs.data) return <SettingCardSkeleton rows={2} />;
  if (!jobs.data.length)
    return (
      <EmptyState placement="card">
        No imports yet. Import your mailbox, docs, website or files
      </EmptyState>
    );
  return (
    <SettingCard>
      {jobs.data.map((job) => (
        <div key={job.id} className={KNOWLEDGE_ROW}>
          <div className={KNOWLEDGE_ROW_TITLE}>{jobLine(job)}</div>
          <div className={KNOWLEDGE_ROW_LINE}>
            Started {relativeTime(job.startedAt)}
          </div>
        </div>
      ))}
    </SettingCard>
  );
}

function History({ project, path }: { project: string; path?: string }) {
  const history = useSWR(apiSWRKey.knowledgeHistory(project, path), () =>
    fetchKnowledgeHistory(project, { path }),
  );
  if (history.error && !history.data)
    return (
      <InlineAlert onRetry={() => void history.mutate()}>
        {errorMessage(history.error, "Couldn't load the history")}
      </InlineAlert>
    );
  if (!history.data) return <SettingCardSkeleton rows={4} />;
  if (!history.data.length)
    return <EmptyState placement="card">No changes yet</EmptyState>;
  return (
    <SettingCard>
      {history.data.map((commit) => (
        <div key={commit.sha} className={KNOWLEDGE_ROW}>
          <div className={KNOWLEDGE_ROW_TITLE}>{commit.subject}</div>
          <div className={KNOWLEDGE_ROW_LINE}>
            {commit.author} · {relativeTime(commit.date)}
          </div>
        </div>
      ))}
    </SettingCard>
  );
}
