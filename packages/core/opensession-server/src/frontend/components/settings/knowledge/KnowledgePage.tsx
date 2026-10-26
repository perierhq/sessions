import { useEffect, useRef } from "react";
import useSWR from "swr";
import { apiSWRKey } from "../../../lib/api-swr";
import type { KnowledgeRoute, KnowledgeTab } from "../../../lib/app-route";
import { fetchKnowledge } from "../../../lib/api/knowledge";
import {
  KNOWLEDGE_EDITOR_FRAME,
  KNOWLEDGE_PAGE_BACK,
  KNOWLEDGE_TAB,
  KNOWLEDGE_TAB_COUNT,
  KNOWLEDGE_TABS_SCROLL,
} from "../../../lib/knowledge-classes";
import { NEW_ARTICLE } from "../../../lib/knowledge/editor-model";
import { PROJECT_PAGE_FRAME } from "../../../lib/project-settings-classes";
import { repoLabel } from "../../../lib/repo-label";
import { Button } from "../../../ui/button";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { SettingsHeader, SettingsPanel } from "../../../ui/settings";
import { IconChevronLeft } from "../../icons";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeHistory } from "./KnowledgeHistory";
import { KnowledgeImport } from "./KnowledgeImport";
import { KnowledgeList } from "./KnowledgeList";
import { KnowledgeSuggestions } from "./KnowledgeSuggestions";
import { KnowledgeNeedsCheck } from "./KnowledgeNeedsCheck";

/** The tabs in the bar, in order. History opens from an item's page. */
const TABS: Array<{ tab: KnowledgeTab; label: string }> = [
  { tab: "articles", label: "Articles" },
  { tab: "suggestions", label: "Suggestions" },
  { tab: "needs-check", label: "Needs check" },
  { tab: "import", label: "Import" },
];

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
  const openPath = (path: string) => onNavigate({ tab: "articles", path });

  // A tab opened from elsewhere (the project page's counts, a link) may sit
  // past the phone's edge: bring it into view, again once the counts have
  // widened the tabs.
  const tabsRef = useRef<HTMLDivElement>(null);
  const counted = counts !== undefined;
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [route.tab, counted]);

  // An item open in the editor: the page is the item, and Back is the list.
  if (route.tab === "articles" && route.path)
    return (
      <div className={KNOWLEDGE_EDITOR_FRAME}>
        <SettingsPanel className="self-start">
          <div className={KNOWLEDGE_PAGE_BACK}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="phone:min-h-11"
              icon={<IconChevronLeft size={18} />}
              aria-label="Back to articles"
              onClick={() => onNavigate({ tab: "articles" })}
            >
              Articles
            </Button>
          </div>
          <KnowledgeEditor
            key={route.path}
            project={project}
            path={route.path}
            onSaved={openPath}
            onHistory={(path) => onNavigate({ tab: "history", path })}
          />
        </SettingsPanel>
      </div>
    );

  // An item open beside its change: the page is the item, the same frame as
  // the editor's so Edit's Save bar sticks, and its own Back (to the queue,
  // or to the comparison while editing) is the only one.
  if (route.tab === "needs-check" && route.path)
    return (
      <div className={KNOWLEDGE_EDITOR_FRAME}>
        <SettingsPanel className="self-start">
          <KnowledgeNeedsCheck
            project={project}
            path={route.path}
            onNavigate={onNavigate}
          />
        </SettingsPanel>
      </div>
    );

  // An item's history (the repository's without a path): Back is the item.
  if (route.tab === "history")
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
              aria-label={
                route.path ? "Back to the article" : "Back to articles"
              }
              onClick={() =>
                onNavigate(
                  route.path
                    ? { tab: "articles", path: route.path }
                    : { tab: "articles" },
                )
              }
            >
              {route.path ? "Article" : "Articles"}
            </Button>
          </div>
          <KnowledgeHistory project={project} path={route.path} />
        </SettingsPanel>
      </div>
    );

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
        <div ref={tabsRef} className={KNOWLEDGE_TABS_SCROLL}>
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
        {route.tab === "articles" ? (
          <KnowledgeList
            project={project}
            filter={route.filter}
            q={route.q}
            onQuery={(filter, q) =>
              onNavigate({
                tab: "articles",
                ...(filter !== "all" && { filter }),
                ...(q && { q }),
              })
            }
            onOpen={openPath}
            onNew={() => openPath(NEW_ARTICLE)}
          />
        ) : route.tab === "suggestions" ? (
          <KnowledgeSuggestions project={project} />
        ) : route.tab === "needs-check" ? (
          <KnowledgeNeedsCheck project={project} onNavigate={onNavigate} />
        ) : route.tab === "import" ? (
          <KnowledgeImport project={project} />
        ) : null}
      </SettingsPanel>
    </div>
  );
}
