// Which suggestions a person picked on the Suggestions tab, and the batch
// actions on them (approve, discard, approve one with edits). Pure: the
// requests, the confirm dialog, the reload and the toast come in as deps,
// so the tab's behaviour is tested without a DOM.

import type { KnowledgeFrontMatterDraft } from "../api/knowledge";
import { errorMessage } from "../error-message";

/** A value: every change answers a new selection. */
export interface Selection {
  /** The listed paths, in list order. */
  readonly paths: readonly string[];
  /** The picked ones, in list order. */
  readonly selected: readonly string[];
  readonly count: number;
  /** Every listed path is picked (never for an empty list). */
  readonly allSelected: boolean;
  has(path: string): boolean;
  toggle(path: string): Selection;
  /** Pick everything, or nothing when everything already is. */
  selectAll(): Selection;
  clear(): Selection;
}

/** The selection over `paths`; `selected` keeps only paths still listed,
 *  so a reloaded list drops what went away. */
export function selectionModel(
  paths: readonly string[],
  selected: Iterable<string> = [],
): Selection {
  const listed = [...paths];
  const picked = new Set(selected);
  const ordered = listed.filter((path) => picked.has(path));
  const chosen = new Set(ordered);
  const allSelected = listed.length > 0 && ordered.length === listed.length;
  return {
    paths: listed,
    selected: ordered,
    count: ordered.length,
    allSelected,
    has: (path) => chosen.has(path),
    toggle: (path) => {
      if (!listed.includes(path)) return selectionModel(listed, ordered);
      const next = new Set(chosen);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return selectionModel(listed, next);
    },
    selectAll: () => selectionModel(listed, allSelected ? [] : listed),
    clear: () => selectionModel(listed),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The toast after an approval. */
export function approvedCopy(n: number): string {
  return `Approved ${plural(n, "article", "articles")}`;
}

/** What `useConfirm()` takes (ui/confirm.tsx ConfirmRequest), with an
 *  awaitable `onConfirm` so the run can be followed. */
export interface SuggestionConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: true;
  onConfirm: () => Promise<void>;
}

/** A suggestion's front matter and body as edited before approving. */
export interface SuggestionEdit {
  fm: KnowledgeFrontMatterDraft;
  body: string;
}

export interface SuggestionBatchDeps {
  /** approveSuggestions for the project. */
  approve: (
    paths: string[],
    edits?: Record<string, SuggestionEdit>,
  ) => Promise<{ approved: string[] }>;
  /** discardSuggestions for the project. */
  discard: (paths: string[]) => Promise<unknown>;
  confirm: (request: SuggestionConfirm) => void;
  /** Load the lists again (the suggestions and the counts). */
  reload: () => Promise<unknown>;
  /** A toast; `error` for a failure. */
  notify: (message: string, error: boolean) => void;
  /** The selection after a batch went through: empty. */
  onSelection: (selection: Selection) => void;
  onBusy: (busy: boolean) => void;
}

export interface SuggestionBatch {
  approve: (selection: Selection) => Promise<void>;
  /** Asks first; the discard runs from the dialog's confirm. */
  discard: (selection: Selection) => void;
  /** Approve one suggestion with what the person changed; true when it
   *  went through (the editor closes). */
  approveEdited: (path: string, edit: SuggestionEdit) => Promise<boolean>;
}

export function suggestionBatch(deps: SuggestionBatchDeps): SuggestionBatch {
  /** Runs `write`, reloads and says `done`; a failure keeps everything
   *  as it was and says why. */
  async function run(
    write: () => Promise<string>,
    fallback: string,
  ): Promise<boolean> {
    deps.onBusy(true);
    try {
      const done = await write();
      await deps.reload();
      deps.notify(done, false);
      return true;
    } catch (error) {
      deps.notify(errorMessage(error, fallback), true);
      return false;
    } finally {
      deps.onBusy(false);
    }
  }

  return {
    approve: async (selection) => {
      const paths = [...selection.selected];
      if (!paths.length) return;
      const ok = await run(async () => {
        const res = await deps.approve(paths);
        return approvedCopy(res.approved.length);
      }, "Couldn't approve");
      if (ok) deps.onSelection(selection.clear());
    },
    discard: (selection) => {
      const paths = [...selection.selected];
      if (!paths.length) return;
      deps.confirm({
        title:
          paths.length === 1
            ? "Discard this suggestion?"
            : `Discard ${paths.length} suggestions?`,
        description:
          paths.length === 1
            ? "Files attached to it are removed too"
            : "Files attached to them are removed too",
        confirmLabel: "Discard",
        destructive: true,
        onConfirm: async () => {
          const ok = await run(async () => {
            await deps.discard(paths);
            return `Discarded ${plural(paths.length, "suggestion", "suggestions")}`;
          }, "Couldn't discard");
          if (ok) deps.onSelection(selection.clear());
        },
      });
    },
    approveEdited: (path, edit) =>
      run(async () => {
        const res = await deps.approve([path], { [path]: edit });
        return approvedCopy(res.approved.length);
      }, "Couldn't approve"),
  };
}
