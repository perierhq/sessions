import { useEffect, useEffectEvent, useState } from "react";
import useSWR from "swr";
import type {
  KnowledgeFilter,
  KnowledgeItem,
} from "../../../../shared/knowledge";
import { apiSWRKey } from "../../../lib/api-swr";
import { fetchKnowledge } from "../../../lib/api/knowledge";
import {
  KNOWLEDGE_CHIP,
  KNOWLEDGE_CHIP_ON,
  KNOWLEDGE_CHIPS,
  KNOWLEDGE_MORE,
  KNOWLEDGE_ROW_ALERT,
  KNOWLEDGE_ROW_BUTTON,
  KNOWLEDGE_ROW_GHOST,
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
  knowledgeAlert,
  knowledgeErrorMessage,
  listLine,
  todayUtc,
} from "../../../lib/knowledge/models";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { SettingCard, SettingCardSkeleton } from "../../../ui/settings";
import { EmptyState, InlineAlert, ListSkeleton } from "../../../ui/state";
import { PlainButton } from "../../../ui/plain-button";
import { IconPlus } from "../../icons";

const PAGE = 50;

/**
 * The Articles tab: a search box (250 ms after the last key), the filter
 * chips, and every item that matches, newest first, 50 at a time. A row
 * opens the item in the editor. The filter and the search live in the URL
 * (`filter`, `q`), so Back from an item and a shared link land on the same
 * list. Same component at both widths; on a phone the chips scroll
 * sideways and every row is a 44px target.
 */
export function KnowledgeList({
  project,
  filter = "all",
  q = "",
  onQuery,
  onOpen,
  onNew,
}: {
  project: string;
  /** The chip in effect, from the route. */
  filter?: KnowledgeFilter;
  /** The search in effect (trimmed), from the route. */
  q?: string;
  /** A new filter or search, written back to the route. */
  onQuery: (filter: KnowledgeFilter, q: string) => void;
  onOpen: (path: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState(q);
  const [pages, setPages] = useState(1);
  const writeQuery = useEffectEvent((next: string) => {
    if (next === q) return;
    setPages(1);
    onQuery(filter, next);
  });
  useEffect(() => {
    const timer = setTimeout(
      () => writeQuery(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
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
              setPages(1);
              onQuery(f, q);
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
      <InlineAlert
        {...knowledgeAlert(
          list.error,
          "Couldn't load the knowledge",
          () => void list.mutate(),
        )}
      />
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
      <InlineAlert
        className={KNOWLEDGE_ROW_ALERT}
        {...knowledgeAlert(
          page.error,
          "Couldn't load the knowledge",
          () => void page.mutate(),
        )}
      />
    );
  // Rows inside the list's card, so ghost rows rather than a second card.
  if (!page.data)
    return (
      <ListSkeleton
        variant="rows"
        rows={2}
        rowClassName={KNOWLEDGE_ROW_GHOST}
      />
    );
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
    <PlainButton
      key={item.path}
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
    </PlainButton>
  ));
}
