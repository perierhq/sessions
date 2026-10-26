import * as React from "react";
import useSWR, { useSWRConfig } from "swr";
import { apiSWRKey, knowledgeKeyFilter } from "../../../lib/api-swr";
import {
  approveSuggestions,
  discardSuggestions,
  fetchKnowledge,
  fetchKnowledgeItem,
} from "../../../lib/api/knowledge";
import {
  KNOWLEDGE_ROW_HEAD,
  KNOWLEDGE_ROW_LINE,
  KNOWLEDGE_ROW_TITLE,
} from "../../../lib/knowledge-classes";
import {
  SUGGESTION_EDIT_ACTIONS,
  SUGGESTION_EDIT_BODY,
  SUGGESTION_EDIT_ERROR,
  SUGGESTION_EDIT_FORM,
  SUGGESTION_EDIT_INPUT,
  SUGGESTION_EDIT_TITLE,
  SUGGESTION_ROW,
  SUGGESTION_ROW_CHECK,
  SUGGESTION_ROW_EDIT,
  SUGGESTION_ROW_LABEL,
  SUGGESTION_ROW_TEXT,
  SUGGESTIONS_CHECK_LABEL,
  SUGGESTIONS_PHONE_BAR,
  SUGGESTIONS_PHONE_BAR_BUTTON,
  SUGGESTIONS_PHONE_BAR_SPACE,
  SUGGESTIONS_TOOLBAR,
  SUGGESTIONS_TOOLBAR_ACTIONS,
} from "../../../lib/knowledge-suggestion-classes";
import {
  editorState,
  toSave,
  validateEditor,
  type EditorState,
} from "../../../lib/knowledge/editor-model";
import {
  emptyCopy,
  itemBadges,
  knowledgeAlert,
  knowledgeErrorMessage,
} from "../../../lib/knowledge/models";
import {
  selectionModel,
  suggestionBatch,
  type Selection,
  type SuggestionEdit,
} from "../../../lib/knowledge/selection";
import { suggestionLine } from "../../../lib/knowledge/suggestions";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { cn } from "../../../ui/cn";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { useConfirm } from "../../../ui/confirm";
import { Field, Input, Textarea } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { SettingCard, SettingCardSkeleton } from "../../../ui/settings";
import { ResponsiveDialog } from "../../../ui/sheet";
import { EmptyState, InlineAlert, LoadingState } from "../../../ui/state";
import { toast } from "../../../ui/toast";

/** The day, read in UTC, for the editor's checks. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The Suggestions tab: what the agent proposed from replies, to approve as
 * articles in batches, edit and approve one, or discard. A checkbox per row
 * and "Select all" over the list; the batch actions sit beside "Select all"
 * on a desktop and in a bottom bar on a phone.
 */
export function KnowledgeSuggestions({ project }: { project: string }) {
  const { mutate } = useSWRConfig();
  const list = useSWR(apiSWRKey.knowledge(project, "suggestions"), () =>
    fetchKnowledge(project, { filter: "suggestions" }),
  );
  const items = list.data?.items ?? [];
  const [picked, setPicked] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const isPhone = useIsPhone();
  // Rebuilt from the list on every render, so a reload drops what left it.
  const selection = selectionModel(
    items.map((item) => item.path),
    picked,
  );
  const select = (next: Selection) => setPicked(next.selected);

  const batch = suggestionBatch({
    approve: (paths, edits) => approveSuggestions(project, paths, edits),
    discard: async (paths) => {
      await discardSuggestions(project, paths);
    },
    confirm: (request) =>
      confirm({ ...request, onConfirm: () => void request.onConfirm() }),
    reload: async () => {
      await mutate(knowledgeKeyFilter(project));
    },
    notify: (message, error) =>
      toast(message, { variant: error ? "error" : "success" }),
    onSelection: select,
    onBusy: setBusy,
  });

  if (list.error && !list.data)
    return (
      <InlineAlert
        {...knowledgeAlert(
          list.error,
          "Couldn't load the suggestions",
          () => void list.mutate(),
        )}
      />
    );
  if (!list.data) return <SettingCardSkeleton rows={4} />;
  if (!items.length)
    return <EmptyState placement="card">{emptyCopy("suggestions")}</EmptyState>;

  const n = selection.count;
  const approveLabel = n ? `Approve (${n})` : "Approve";
  const discardLabel = n ? `Discard (${n})` : "Discard";
  const actions = (buttonClass?: string) => (
    <>
      <Button
        type="button"
        variant="danger"
        className={buttonClass}
        disabled={!n || busy}
        onClick={() => batch.discard(selection)}
      >
        {discardLabel}
      </Button>
      <Button
        type="button"
        variant="primary"
        className={buttonClass}
        disabled={!n || busy}
        onClick={() => void batch.approve(selection)}
      >
        {approveLabel}
      </Button>
    </>
  );

  return (
    <div className={cn(n > 0 && SUGGESTIONS_PHONE_BAR_SPACE)}>
      <SettingCard>
        <div className={SUGGESTIONS_TOOLBAR}>
          <label className={SUGGESTIONS_CHECK_LABEL}>
            <Checkbox
              checked={selection.allSelected}
              indeterminate={n > 0 && !selection.allSelected}
              disabled={busy}
              onCheckedChange={() => select(selection.selectAll())}
            />
            {n ? `${n} selected` : "Select all"}
          </label>
          <div className={SUGGESTIONS_TOOLBAR_ACTIONS}>{actions()}</div>
        </div>
        {items.map((item) => (
          <div key={item.path} className={SUGGESTION_ROW}>
            <label className={SUGGESTION_ROW_LABEL}>
              <Checkbox
                className={SUGGESTION_ROW_CHECK}
                checked={selection.has(item.path)}
                disabled={busy}
                onCheckedChange={() => select(selection.toggle(item.path))}
              />
              <span className={SUGGESTION_ROW_TEXT}>
                <span className={KNOWLEDGE_ROW_HEAD}>
                  <span className={KNOWLEDGE_ROW_TITLE}>{item.title}</span>
                  {itemBadges(item)
                    // Every suggestion is reference until approved.
                    .filter((badge) => badge.label !== "Reference")
                    .map((badge) => (
                      <Badge key={badge.label} tone={badge.tone}>
                        {badge.label}
                      </Badge>
                    ))}
                </span>
                <span className={KNOWLEDGE_ROW_LINE}>
                  {suggestionLine(item)}
                </span>
              </span>
            </label>
            <Button
              type="button"
              variant="ghost"
              className={SUGGESTION_ROW_EDIT}
              disabled={busy}
              aria-label={`Edit ${item.title}`}
              onClick={() => setEditing(item.path)}
            >
              Edit
            </Button>
          </div>
        ))}
      </SettingCard>
      {n > 0 ? (
        <div className={SUGGESTIONS_PHONE_BAR}>
          {actions(SUGGESTIONS_PHONE_BAR_BUTTON)}
        </div>
      ) : null}
      <ResponsiveDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        phone={isPhone}
        label="Edit suggestion"
        modalClassName="w-[min(640px,calc(100vw-32px))]"
      >
        {(dismiss) =>
          editing ? (
            <SuggestionEditor
              project={project}
              path={editing}
              onCancel={dismiss}
              onApprove={async (edit) => {
                const ok = await batch.approveEdited(editing, edit);
                if (ok) {
                  select(selection.clear());
                  dismiss();
                }
              }}
            />
          ) : null
        }
      </ResponsiveDialog>
      {confirmDialog}
    </div>
  );
}

/** The suggestion as a form: its title, kind, topics and text. Approving
 *  saves the edits and makes it an article in one commit. */
function SuggestionEditor({
  project,
  path,
  onCancel,
  onApprove,
}: {
  project: string;
  path: string;
  onCancel: () => void;
  onApprove: (edit: SuggestionEdit) => Promise<void>;
}) {
  const read = useSWR(apiSWRKey.knowledgeItem(project, path), () =>
    fetchKnowledgeItem(project, path),
  );
  if (read.error && !read.data)
    return (
      <div className={SUGGESTION_EDIT_FORM}>
        <InlineAlert
          {...knowledgeAlert(
            read.error,
            "Couldn't load the suggestion",
            () => void read.mutate(),
          )}
        />
      </div>
    );
  if (!read.data)
    return (
      <div className={SUGGESTION_EDIT_FORM}>
        <LoadingState placement="card">Loading the suggestion</LoadingState>
      </div>
    );
  return (
    <SuggestionForm
      key={read.data.item.blob}
      initial={editorState(read.data, today())}
      onCancel={onCancel}
      onApprove={onApprove}
    />
  );
}

function SuggestionForm({
  initial,
  onCancel,
  onApprove,
}: {
  initial: EditorState;
  onCancel: () => void;
  onApprove: (edit: SuggestionEdit) => Promise<void>;
}) {
  const [state, setState] = React.useState(initial);
  const [shown, setShown] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const errors = validateEditor(state, initial.today);
  const visible = shown ? errors : {};
  // Fields the form doesn't show still have to pass; say so in one line.
  const hidden = shown
    ? (errors.sources ??
      errors.dependsOn ??
      errors.validAsOf ??
      errors.reviewBy ??
      null)
    : null;
  const ids = React.useId();
  const set = (patch: Partial<EditorState>) =>
    setState((prev) => ({ ...prev, ...patch }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShown(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    // onApprove never rejects: a failure is a toast and the form stays.
    await onApprove(toSave(state));
    setSaving(false);
  };

  const describe = (field: keyof typeof errors) =>
    visible[field] ? `${ids}-${field}` : undefined;
  const error = (field: keyof typeof errors) =>
    visible[field] ? (
      <span id={`${ids}-${field}`} className={SUGGESTION_EDIT_ERROR}>
        {visible[field]}
      </span>
    ) : null;

  return (
    <form className={SUGGESTION_EDIT_FORM} onSubmit={submit} noValidate>
      <div className={SUGGESTION_EDIT_TITLE}>Edit suggestion</div>
      <Field label="Title">
        <Input
          value={state.title}
          className={SUGGESTION_EDIT_INPUT}
          aria-invalid={visible.title ? true : undefined}
          aria-describedby={describe("title")}
          onChange={(e) => set({ title: e.target.value })}
        />
        {error("title")}
      </Field>
      <Segmented
        label="Kind"
        value={state.kind}
        onValueChange={(value) =>
          set({ kind: value === "internal" ? "internal" : "answer" })
        }
        className="self-start"
      >
        <SegmentedOption value="answer" className="phone:min-h-11">
          Answer
        </SegmentedOption>
        <SegmentedOption value="internal" className="phone:min-h-11">
          Internal note
        </SegmentedOption>
      </Segmented>
      <Field label="Topics">
        <Input
          value={state.topics}
          placeholder="export, csv"
          className={SUGGESTION_EDIT_INPUT}
          aria-invalid={visible.topics ? true : undefined}
          aria-describedby={describe("topics")}
          onChange={(e) => set({ topics: e.target.value })}
        />
        {error("topics")}
      </Field>
      <Field label="Text">
        <Textarea
          value={state.body}
          rows={10}
          className={SUGGESTION_EDIT_BODY}
          aria-invalid={visible.body ? true : undefined}
          aria-describedby={describe("body")}
          onChange={(e) => set({ body: e.target.value })}
        />
        {error("body")}
      </Field>
      {hidden ? <InlineAlert>{hidden}</InlineAlert> : null}
      <div className={SUGGESTION_EDIT_ACTIONS}>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={saving}>
          Approve
        </Button>
      </div>
    </form>
  );
}
