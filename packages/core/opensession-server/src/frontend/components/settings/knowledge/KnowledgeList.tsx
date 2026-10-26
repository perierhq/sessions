import { useEffect, useState } from "react";
import useSWR from "swr";
import type {
  KnowledgeFilter,
  KnowledgeItem,
} from "../../../../shared/knowledge";
import { apiSWRKey } from "../../../lib/api-swr";
import { fetchKnowledge } from "../../../lib/api/knowledge";
import { errorMessage } from "../../../lib/error-message";
import {
  KNOWLEDGE_CHIP,
  KNOWLEDGE_CHIP_ON,
  KNOWLEDGE_CHIPS,
  KNOWLEDGE_MORE,
  KNOWLEDGE_ROW_BUTTON,
  KNOWLEDGE_ROW_HEAD,
  KNOWLEDGE_ROW_LINE,
  KNOWLEDGE_ROW_TITLE,
  KNOWLEDGE_SEARCH,
  KNOWLEDGE_TOOLBAR,
} from "../../../lib/knowledge-classes";
import {
  LIST_FILTERS,
  SEARCH_DEBOUNCE_MS,
  emptyCopy,
  filterLabel,
  itemBadges,
  listLine,
  todayUtc,
} from "../../../lib/knowledge/models";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { SettingCard, SettingCardSkeleton } from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { IconPlus } from "../../icons";

const PAGE = 50;

/**
 * The Articles tab: a search box (250 ms after the last key), the filter
 * chips, and every item that matches, newest first, 50 at a time. A row
 * opens the item in the editor. Same component at both widths; on a phone
 * the chips scroll sideways and every row is a 44px target.
 */
export function KnowledgeList({
  project,
  onOpen,
  onNew,
}: {
  project: string;
  onOpen: (path: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<KnowledgeFilter>("all");
  const [pages, setPages] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(query.trim());
      setPages(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <>
      <div className={KNOWLEDGE_TOOLBAR}>
        <Input
          type="search"
          name="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search knowledge"
          className={KNOWLEDGE_SEARCH}
        />
        <Button
          type="button"
          icon={<IconPlus size={20} />}
          className={KNOWLEDGE_CHIP}
          onClick={onNew}
        >
          New article
        </Button>
      </div>
      <div className={KNOWLEDGE_CHIPS} role="group" aria-label="Show">
        {LIST_FILTERS.map((f) => (
          <Button
            key={f}
            type="button"
            size="sm"
            variant={f === filter ? "soft" : "ghost"}
            aria-pressed={f === filter}
            className={f === filter ? KNOWLEDGE_CHIP_ON : KNOWLEDGE_CHIP}
            onClick={() => {
              setFilter(f);
              setPages(1);
            }}
          >
            {filterLabel(f)}
          </Button>
        ))}
      </div>
      <FirstPage
        key={`${filter}\n${q}`}
        project={project}
        filter={filter}
        q={q}
        pages={pages}
        onMore={() => setPages((n) => n + 1)}
        onOpen={onOpen}
      />
    </>
  );
}

function FirstPage({
  project,
  filter,
  q,
  pages,
  onMore,
  onOpen,
}: {
  project: string;
  filter: KnowledgeFilter;
  q: string;
  pages: number;
  onMore: () => void;
  onOpen: (path: string) => void;
}) {
  const list = useSWR(apiSWRKey.knowledge(project, filter, q), () =>
    fetchKnowledge(project, { filter, q }),
  );
  if (list.error && !list.data)
    return (
      <InlineAlert onRetry={() => void list.mutate()}>
        {errorMessage(list.error, "Couldn't load the knowledge")}
      </InlineAlert>
    );
  if (!list.data) return <SettingCardSkeleton rows={4} />;
  const { items, total } = list.data;
  if (!items.length)
    return (
      <EmptyState placement="card">
        {q ? `Nothing matches “${q}”` : emptyCopy(filter)}
      </EmptyState>
    );
  const later = Array.from({ length: pages - 1 }, (_, i) => (i + 1) * PAGE);
  const shown = Math.min(total, pages * PAGE);
  return (
    <>
      <SettingCard>
        <Rows items={items} onOpen={onOpen} />
        {later.map((offset) => (
          <LaterPage
            key={offset}
            project={project}
            filter={filter}
            q={q}
            offset={offset}
            onOpen={onOpen}
          />
        ))}
      </SettingCard>
      {shown < total ? (
        <div className={KNOWLEDGE_MORE}>
          <Button
            type="button"
            variant="ghost"
            className={KNOWLEDGE_CHIP}
            onClick={onMore}
          >
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function LaterPage({
  project,
  filter,
  q,
  offset,
  onOpen,
}: {
  project: string;
  filter: KnowledgeFilter;
  q: string;
  offset: number;
  onOpen: (path: string) => void;
}) {
  const page = useSWR(apiSWRKey.knowledge(project, filter, q, offset), () =>
    fetchKnowledge(project, { filter, q, offset }),
  );
  if (page.error && !page.data)
    return (
      <div className="px-5 py-3">
        <InlineAlert onRetry={() => void page.mutate()}>
          {errorMessage(page.error, "Couldn't load the knowledge")}
        </InlineAlert>
      </div>
    );
  if (!page.data) return <SettingCardSkeleton rows={2} />;
  return <Rows items={page.data.items} onOpen={onOpen} />;
}

function Rows({
  items,
  onOpen,
}: {
  items: KnowledgeItem[];
  onOpen: (path: string) => void;
}) {
  const today = todayUtc();
  return items.map((item) => (
    <button
      key={item.path}
      type="button"
      className={KNOWLEDGE_ROW_BUTTON}
      onClick={() => onOpen(item.path)}
    >
      <span className={KNOWLEDGE_ROW_HEAD}>
        <span className={KNOWLEDGE_ROW_TITLE}>{item.title}</span>
        {itemBadges(item).map((badge) => (
          <Badge key={badge.label} tone={badge.tone}>
            {badge.label}
          </Badge>
        ))}
      </span>
      <span className={KNOWLEDGE_ROW_LINE}>{listLine(item, today)}</span>
    </button>
  ));
}
