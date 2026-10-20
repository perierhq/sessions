import { useState } from "react";
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
}: {
  entries: HiddenListEntry[];
  isPhone: boolean;
  onOpenEntry: (entry: HiddenListEntry) => void;
  onRestore: (entry: HiddenListEntry) => void;
  /** Told when the list opens, so its names can be refreshed. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [requestedOpen, setOpen] = useState(false);
  const setListOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  // Restoring the last entry takes the list and the row it opened from.
  const open = requestedOpen && entries.length > 0;
  if (entries.length === 0) return null;

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
        if (entries.length === 1) setListOpen(false);
        onRestore(entry);
      }}
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

function HiddenList({
  entries,
  onOpenEntry,
  onRestore,
  className,
}: {
  entries: HiddenListEntry[];
  onOpenEntry: (entry: HiddenListEntry) => void;
  onRestore: (entry: HiddenListEntry) => void;
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
                  // to the next Restore rather than falling to the page.
                  const item = event.currentTarget.closest("li");
                  const neighbour = (
                    item?.nextElementSibling ?? item?.previousElementSibling
                  )?.querySelector<HTMLElement>("[data-hidden-restore]");
                  onRestore(entry);
                  neighbour?.focus();
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
