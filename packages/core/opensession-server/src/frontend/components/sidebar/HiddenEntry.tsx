import { useEffect, useRef, useState } from "react";
import { relativeTime } from "../../lib/api";
import type { HiddenListEntry } from "../../lib/hidden-list";
import {
  HIDDEN_POPUP,
  HIDDEN_POPUP_HEADER,
  HIDDEN_POPUP_LIST,
  HIDDEN_POPUP_TITLE,
  HIDDEN_ROW,
  HIDDEN_ROW_ITEM,
  HIDDEN_ROW_MARK,
  HIDDEN_ROW_META,
  HIDDEN_ROW_OPEN,
  HIDDEN_ROW_RESTORE,
  HIDDEN_ROW_TITLE,
  HIDDEN_SHEET_HEADER,
  HIDDEN_SHEET_LIST,
  HIDDEN_SHEET_TITLE,
} from "../../lib/hidden-list-classes";
import {
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
} from "../../lib/sidebar-classes";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { IconEyeOff, IconX } from "../icons";
import { RepoTile, repoLabel } from "../RepoTile";

const TITLE = "Hidden from your sidebar";

/**
 * Whether the list is open once the entry count is `count`. An empty list
 * closes, and stays closed: entries coming back later (another hide, or one
 * made on another device) must not reopen a list nobody asked to see.
 */
export function nextListOpen(requestedOpen: boolean, count: number): boolean {
  return count > 0 && requestedOpen;
}

/** The parts of a list item the Restore focus hand-off walks. */
interface RestoreFocusItem {
  nextElementSibling: { querySelector: (selector: string) => unknown } | null;
  previousElementSibling: {
    querySelector: (selector: string) => unknown;
  } | null;
}

type Focusable = { focus: (options?: FocusOptions) => void };

/**
 * Where keyboard focus goes when a Restore takes its row away: the next
 * row's Restore, else the previous one's, else (the last entry, so the list
 * and its row are about to go) the stable target the sidebar names, so focus
 * never falls to the page.
 */
export function restoreFocusTarget(
  item: RestoreFocusItem | null,
  fallback: () => Focusable | null,
): Focusable | null {
  const neighbour = item?.nextElementSibling ?? item?.previousElementSibling;
  const restore = neighbour?.querySelector("[data-hidden-restore]") as
    | Focusable
    | null
    | undefined;
  return restore ?? fallback();
}

/**
 * The way back for hidden rows: a quiet "Hidden" row at the foot of the
 * sidebar, shown only while something is hidden. It opens the list of what
 * you hid, each with Restore. A popover beside the sidebar on desktop, the
 * shared bottom sheet on phones.
 */
export function HiddenEntry({
  entries,
  isPhone,
  onOpenEntry,
  onRestore,
  onOpenChange,
  focusFallback = () => null,
}: {
  entries: HiddenListEntry[];
  isPhone: boolean;
  onOpenEntry: (entry: HiddenListEntry) => void;
  onRestore: (entry: HiddenListEntry) => void;
  /** Told when the list opens, so its names can be refreshed. */
  onOpenChange?: (open: boolean) => void;
  /**
   * A control that outlives this row (the Archived link, or the sidebar's
   * scroll container), for focus to land on when the last entry is restored
   * and the row and its list go.
   */
  focusFallback?: () => HTMLElement | null;
}) {
  const [requestedOpen, setOpen] = useState(false);
  const setListOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  // However the list empties (the last Restore here, a restore on another
  // device, a blocked row consuming its hide), close it for good, so it does
  // not reopen by itself when something is hidden again.
  const count = entries.length;
  useEffect(() => {
    setOpen((current) => nextListOpen(current, count));
  }, [count]);
  // Set when the last entry is restored: the popover's trigger is about to
  // unmount, so closing must not try to hand focus back to it.
  const closeFocus = useRef<HTMLElement | null>(null);
  // Restoring the last entry takes the list and the row it opened from.
  const open = nextListOpen(requestedOpen, count);
  if (count === 0) return null;

  const label = `Hidden, ${entries.length} ${entries.length === 1 ? "item" : "items"}`;
  const rowClass = cn(
    SIDEBAR_GROUP_HEADER,
    SIDEBAR_GROUP_HEADER_INSET,
    SIDEBAR_HEADER_ROW,
    SIDEBAR_HOVER_LAYER,
    "transition-colors",
    open && "bg-selected text-fg",
  );
  const rowContent = (
    <>
      <span className={SIDEBAR_RAIL}>
        <IconEyeOff size={20} />
      </span>
      <span className={SIDEBAR_GROUP_NAME}>Hidden</span>
      <span className={cn(SIDEBAR_GROUP_COUNT, "shrink-0")}>
        {entries.length}
      </span>
    </>
  );
  const list = (
    <HiddenList
      entries={entries}
      onOpenEntry={(entry) => {
        setListOpen(false);
        onOpenEntry(entry);
      }}
      onRestore={(entry) => {
        if (entries.length === 1) {
          closeFocus.current = focusFallback();
          setListOpen(false);
        }
        onRestore(entry);
      }}
      focusFallback={focusFallback}
      className={isPhone ? HIDDEN_SHEET_LIST : HIDDEN_POPUP_LIST}
    />
  );

  if (isPhone) {
    return (
      <>
        <button
          type="button"
          className={rowClass}
          aria-label={label}
          aria-haspopup="dialog"
          onClick={() => setListOpen(true)}
        >
          {rowContent}
        </button>
        <ResponsiveDialog
          open={open}
          onClose={() => setListOpen(false)}
          phone
          label={TITLE}
          sheetClassName="max-h-[88dvh]"
        >
          <div className={HIDDEN_SHEET_HEADER}>
            <h2 className={HIDDEN_SHEET_TITLE}>{TITLE}</h2>
            <SheetIconButton
              aria-label="Close"
              onClick={() => setListOpen(false)}
            >
              <IconX />
            </SheetIconButton>
          </div>
          <SheetBody>{list}</SheetBody>
        </ResponsiveDialog>
      </>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setListOpen}>
      <Popover.Trigger className={rowClass} aria-label={label}>
        {rowContent}
      </Popover.Trigger>
      <Popover.Popup
        side="right"
        align="end"
        elevation="lg"
        initialFocus
        finalFocus={() => closeFocus.current ?? true}
        aria-label={TITLE}
        className={HIDDEN_POPUP}
      >
        <div className={HIDDEN_POPUP_HEADER}>
          <span className={HIDDEN_POPUP_TITLE}>{TITLE}</span>
        </div>
        {list}
      </Popover.Popup>
    </Popover.Root>
  );
}

export function HiddenList({
  entries,
  onOpenEntry,
  onRestore,
  focusFallback,
  className,
}: {
  entries: HiddenListEntry[];
  onOpenEntry: (entry: HiddenListEntry) => void;
  onRestore: (entry: HiddenListEntry) => void;
  focusFallback: () => HTMLElement | null;
  className: string;
}) {
  return (
    <ul className={className}>
      {entries.map((entry) => {
        // A repository is named by its label and described as one; a row by
        // its title, with the repo it files under.
        const title =
          entry.kind === "repo" ? repoLabel(entry.repo) : entry.title;
        const context =
          entry.kind === "repo"
            ? "Repository"
            : entry.repo
              ? repoLabel(entry.repo)
              : null;
        return (
          <li key={entry.key} className={HIDDEN_ROW_ITEM}>
            <div className={HIDDEN_ROW}>
              <span className={HIDDEN_ROW_MARK} aria-hidden="true">
                {entry.repo && <RepoTile name={entry.repo} />}
              </span>
              <button
                type="button"
                className={HIDDEN_ROW_OPEN}
                onClick={() => onOpenEntry(entry)}
              >
                <span className={HIDDEN_ROW_TITLE}>{title}</span>
                <span className={HIDDEN_ROW_META}>
                  {context && (
                    <span className="min-w-0 truncate">{context}</span>
                  )}
                  <span className="shrink-0 tabular-nums">
                    Hidden {relativeTime(entry.hiddenAt)}
                  </span>
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className={HIDDEN_ROW_RESTORE}
                aria-label={`Restore ${title} to your sidebar`}
                // The hook the focus hand-off below looks for.
                data-hidden-restore=""
                onClick={(event) => {
                  // The row leaves with its button, so keyboard focus moves
                  // first: to the next Restore, or, restoring the last entry,
                  // to a control that outlives the list, never to the page.
                  restoreFocusTarget(
                    event.currentTarget.closest("li"),
                    focusFallback,
                  )?.focus({ preventScroll: true });
                  onRestore(entry);
                }}
              >
                Restore
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
