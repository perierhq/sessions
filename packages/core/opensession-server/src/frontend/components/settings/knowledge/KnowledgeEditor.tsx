import { useId, useRef, useState, type ReactNode } from "react";
import useSWR, { mutate as revalidateApiResources } from "swr";
import type {
  KnowledgeKind,
  KnowledgeStatus,
} from "../../../../shared/knowledge";
import { apiSWRKey, knowledgeKeyFilter } from "../../../lib/api-swr";
import {
  attachKnowledgeFile,
  canAttachTo,
  confirmKnowledge,
  fetchKnowledgeItem,
  knowledgeAttachmentUrl,
  retireKnowledge,
  saveKnowledgeItem,
  type KnowledgeRead,
} from "../../../lib/api/knowledge";
import { ApiError } from "../../../lib/api/request";
import {
  KNOWLEDGE_EDITOR_ACTION,
  KNOWLEDGE_EDITOR_ACTIONS,
  KNOWLEDGE_EDITOR_ATTACHMENT,
  KNOWLEDGE_EDITOR_ATTACHMENTS,
  KNOWLEDGE_EDITOR_BAR,
  KNOWLEDGE_EDITOR_BODY,
  KNOWLEDGE_EDITOR_CONTROL,
  KNOWLEDGE_EDITOR_ERROR,
  KNOWLEDGE_EDITOR_GROUP,
  KNOWLEDGE_EDITOR_HINT,
  KNOWLEDGE_EDITOR_INPUT,
  KNOWLEDGE_EDITOR_LABEL,
  KNOWLEDGE_EDITOR_LINES,
  KNOWLEDGE_EDITOR_PAIR,
  KNOWLEDGE_EDITOR_SWITCH_ROW,
} from "../../../lib/knowledge-classes";
import {
  ATTACH_ACCEPT,
  CONFLICT_COPY,
  NEW_ARTICLE,
  attachmentLink,
  withLink,
  bodyAttachments,
  editorState,
  sameEdit,
  toSave,
  trustLine,
  validateEditor,
  type EditorErrors,
  type EditorField,
  type EditorState,
} from "../../../lib/knowledge/editor-model";
import {
  knowledgeAlert,
  knowledgeErrorMessage,
  todayUtc,
} from "../../../lib/knowledge/models";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { Input, Textarea } from "../../../ui/input";
import { OptionSelect } from "../../../ui/select";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import {
  SettingCardSkeleton,
  SettingsForm,
  SettingsGroupLabel,
  SettingsHeader,
} from "../../../ui/settings";
import { InlineAlert } from "../../../ui/state";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { IconHistory, IconPaperclip } from "../../icons";

function kindOf(value: string): KnowledgeKind {
  return value === "internal" ? "internal" : "answer";
}

const STATUS_OPTIONS: Array<{ value: KnowledgeStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "needs-check", label: "Needs check" },
  { value: "retired", label: "Retired" },
];

/**
 * One item open for editing (`path`), or a new article (NEW_ARTICLE). Loads
 * the item, then hands it to the form; Reload after a conflict reads it
 * again and starts the form over from what is there now.
 */
export function KnowledgeEditor({
  project,
  path,
  onSaved,
  onHistory,
  saveLabel,
  savedMessage,
}: {
  project: string;
  path: string;
  /** Saved: the item's path (a new article's is known only now). */
  onSaved: (path: string) => void;
  onHistory: (path: string) => void;
  /** The Save button's word, when saving does more than save (Needs check
   *  marks the item still true too). */
  saveLabel?: string;
  /** The toast once saved, to match `saveLabel`. */
  savedMessage?: string;
}) {
  const creating = path === NEW_ARTICLE;
  const read = useSWR(
    creating ? null : apiSWRKey.knowledgeItem(project, path),
    () => fetchKnowledgeItem(project, path),
  );
  const [generation, setGeneration] = useState(0);
  const today = todayUtc();
  const reload = () => {
    void read.mutate().then(() => setGeneration((n) => n + 1));
  };
  if (creating)
    return (
      <KnowledgeEditorForm
        key={`new:${generation}`}
        project={project}
        read={null}
        today={today}
        onSaved={onSaved}
        onReload={() => setGeneration((n) => n + 1)}
      />
    );
  if (read.error && !read.data)
    return (
      <>
        <SettingsHeader title="Article" />
        <InlineAlert
          {...knowledgeAlert(
            read.error,
            "Couldn't load the article",
            () => void read.mutate(),
          )}
        />
      </>
    );
  if (!read.data)
    return (
      <>
        <SettingsHeader title="Article" />
        <SettingCardSkeleton rows={5} />
      </>
    );
  return (
    <KnowledgeEditorForm
      key={`${read.data.item.blob}:${generation}`}
      project={project}
      read={read.data}
      today={today}
      onSaved={onSaved}
      onReload={reload}
      onHistory={() => onHistory(path)}
      saveLabel={saveLabel}
      savedMessage={savedMessage}
    />
  );
}

/** The form itself: the front matter as controls, the Markdown body, the
 *  attachments, and Save and Retire stuck to the bottom of the page. */
export function KnowledgeEditorForm({
  project,
  read,
  today,
  onSaved,
  onReload,
  onHistory,
  saveLabel = "Save",
  savedMessage = "Saved",
}: {
  project: string;
  read: KnowledgeRead | null;
  today: string;
  onSaved: (path: string) => void;
  onReload: () => void;
  onHistory?: () => void;
  saveLabel?: string;
  savedMessage?: string;
}) {
  const [initial] = useState(() => editorState(read, today));
  const [state, setState] = useState(initial);
  const [errors, setErrors] = useState<EditorErrors>({});
  const [busy, setBusy] = useState<"save" | "retire" | "attach" | null>(null);
  const [failure, setFailure] = useState<
    { conflict: true } | { message: string } | null
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const dirty = !sameEdit(initial, state);
  const update = (next: Partial<EditorState>) =>
    setState((s) => ({ ...s, ...next }));
  const fieldError = (field: EditorField) => errors[field];
  const errorId = (field: EditorField) => `${id}-${field}-error`;
  const labelId = (name: string) => `${id}-${name}-label`;
  const invalid = (field: EditorField) =>
    errors[field]
      ? { "aria-invalid": true, "aria-describedby": errorId(field) }
      : {};

  // Leaving Active ends "confirm": confirming makes an item active again.
  const statusChange = (status: KnowledgeStatus): Partial<EditorState> => {
    const next: Partial<EditorState> = { status };
    if (status !== "active" && state.confirm) {
      next.confirm = false;
      next.validAsOf = initial.validAsOf;
    }
    return next;
  };

  const refresh = () => revalidateApiResources(knowledgeKeyFilter(project));

  async function write(next: EditorState, done: string) {
    const found = validateEditor(next, today);
    setErrors(found);
    if (Object.keys(found).length) return;
    setFailure(null);
    const { fm, body } = toSave(next);
    const saved = await saveKnowledgeItem(
      project,
      next.path
        ? { fm, body, path: next.path, expectedBlob: next.blob }
        : { fm, body, expectedBlob: null },
    );
    const path = saved.item?.path ?? next.path;
    if (next.confirm && path)
      await confirmKnowledge(project, [path]).catch((error: Error) =>
        toast(
          `Saved, but not confirmed: ${knowledgeErrorMessage(error, "the code repository couldn't be read")}`,
          { variant: "error" },
        ),
      );
    void refresh();
    toast(done, { variant: "success" });
    if (path) onSaved(path);
  }

  function run(kind: "save" | "retire", task: () => Promise<void>) {
    setBusy(kind);
    return task().then(
      () => setBusy(null),
      (error: Error) => {
        setFailure(
          error instanceof ApiError && error.status === 409
            ? { conflict: true }
            : {
                message: knowledgeErrorMessage(
                  error,
                  "Couldn't save the article",
                ),
              },
        );
        setBusy(null);
      },
    );
  }

  const save = () =>
    run("save", () =>
      write(
        state,
        // A Needs check save marks the item still true, but not one saved as
        // retired (it stays retired).
        state.status === "retired" ? "Saved" : savedMessage,
      ),
    );

  // A clean item retires as its own commit ("Retire <title>"); one with
  // unsaved edits keeps them and saves as retired.
  const retire = () =>
    run("retire", async () => {
      if (dirty)
        return write(
          { ...state, status: "retired", confirm: false },
          "Retired",
        );
      setFailure(null);
      await retireKnowledge(project, [state.path!]);
      void refresh();
      toast("Retired", { variant: "success" });
      onReload();
    });

  function attach(file: File | undefined) {
    const article = state.path;
    if (!file || !article) return;
    setBusy("attach");
    const settled = () => {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    };
    void attachKnowledgeFile(project, article, file).then(
      ({ path }) => {
        const link = attachmentLink(article, path);
        setState((s) => ({ ...s, body: withLink(s.body, link) }));
        toast(`Attached ${file.name}. Save to keep the link`, {
          variant: "success",
        });
        settled();
      },
      (error: Error) => {
        toast(knowledgeErrorMessage(error, "Couldn't attach the file"), {
          variant: "error",
        });
        settled();
      },
    );
  }

  const attachments = state.path ? bodyAttachments(state.path, state.body) : [];
  const attachable = state.path ? canAttachTo(state.path) : true;
  const check =
    read?.item.status === "needs-check" ? read.item.check : undefined;

  return (
    <>
      <SettingsHeader
        title={read ? read.item.title : "New article"}
        description={trustLine(state.kept.trust)}
        actions={
          onHistory ? (
            <Button
              type="button"
              variant="ghost"
              icon={<IconHistory size={20} />}
              className={KNOWLEDGE_EDITOR_ACTION}
              onClick={onHistory}
            >
              History
            </Button>
          ) : null
        }
      />
      {check ? (
        <InlineAlert variant="warn" className="mb-3">
          {`Needs a check: ${check.reason}`}
        </InlineAlert>
      ) : null}

      <SettingsForm className={KNOWLEDGE_EDITOR_GROUP}>
        <Labeled
          label="Title"
          labelId={labelId("title")}
          error={fieldError("title")}
          errorId={errorId("title")}
        >
          <Input
            name="title"
            value={state.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Exporting a project as CSV"
            aria-labelledby={labelId("title")}
            className={KNOWLEDGE_EDITOR_INPUT}
            {...invalid("title")}
          />
        </Labeled>
        <Labeled
          label="Article"
          labelId={labelId("body")}
          hint="Markdown"
          error={fieldError("body")}
          errorId={errorId("body")}
        >
          <Textarea
            name="body"
            value={state.body}
            onChange={(e) => update({ body: e.target.value })}
            aria-labelledby={labelId("body")}
            className={KNOWLEDGE_EDITOR_BODY}
            spellCheck
            {...invalid("body")}
          />
        </Labeled>
        {attachable || attachments.length ? (
          <div className={KNOWLEDGE_EDITOR_CONTROL}>
            <span className={KNOWLEDGE_EDITOR_LABEL}>Attachments</span>
            {attachments.length ? (
              <div className={KNOWLEDGE_EDITOR_ATTACHMENTS}>
                {attachments.map((a) => (
                  <a
                    key={a.path}
                    href={knowledgeAttachmentUrl(project, a.path)}
                    target="_blank"
                    rel="noreferrer"
                    className={KNOWLEDGE_EDITOR_ATTACHMENT}
                  >
                    {a.name}
                  </a>
                ))}
              </div>
            ) : null}
            {attachable ? (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept={ATTACH_ACCEPT}
                  className="hidden"
                  onChange={(e) => attach(e.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="soft"
                  icon={<IconPaperclip size={20} />}
                  className={KNOWLEDGE_EDITOR_ACTION}
                  disabled={!state.path || busy !== null}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy === "attach" ? "Attaching" : "Attach"}
                </Button>
                <span className={KNOWLEDGE_EDITOR_HINT}>
                  {state.path
                    ? "Screenshots and PDFs, up to 10 MB"
                    : "Save the article first to attach screenshots or PDFs"}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsForm>

      <SettingsGroupLabel className="mt-6">Details</SettingsGroupLabel>
      <SettingsForm className={KNOWLEDGE_EDITOR_GROUP}>
        <div className={KNOWLEDGE_EDITOR_PAIR}>
          <Labeled label="Kind" labelId={labelId("kind")}>
            <Segmented
              label="Kind"
              aria-labelledby={labelId("kind")}
              value={state.kind}
              onValueChange={(kind) => update({ kind: kindOf(kind) })}
              className="self-start"
            >
              <SegmentedOption
                value="answer"
                className={KNOWLEDGE_EDITOR_ACTION}
              >
                Answer
              </SegmentedOption>
              <SegmentedOption
                value="internal"
                className={KNOWLEDGE_EDITOR_ACTION}
              >
                Internal
              </SegmentedOption>
            </Segmented>
            <span className={KNOWLEDGE_EDITOR_HINT}>
              {state.kind === "internal"
                ? "For the team only: a reply that quotes it waits for a person"
                : "Pat may say this to a customer"}
            </span>
          </Labeled>
          <Labeled label="Status" labelId={labelId("status")}>
            <OptionSelect
              label="Status"
              value={state.status}
              options={STATUS_OPTIONS}
              onChange={(status) => update(statusChange(status))}
              className={KNOWLEDGE_EDITOR_INPUT}
            />
          </Labeled>
        </div>

        <Labeled
          label="Topics"
          labelId={labelId("topics")}
          hint="Separate with commas"
          error={fieldError("topics")}
          errorId={errorId("topics")}
        >
          <Input
            name="topics"
            value={state.topics}
            onChange={(e) => update({ topics: e.target.value })}
            placeholder="export, csv"
            aria-labelledby={labelId("topics")}
            className={KNOWLEDGE_EDITOR_INPUT}
            {...invalid("topics")}
          />
        </Labeled>
      </SettingsForm>

      <SettingsGroupLabel className="mt-6">Freshness</SettingsGroupLabel>
      <SettingsForm className={KNOWLEDGE_EDITOR_GROUP}>
        <div className={KNOWLEDGE_EDITOR_PAIR}>
          <Labeled
            label="Valid as of"
            labelId={labelId("validAsOf")}
            error={fieldError("validAsOf")}
            errorId={errorId("validAsOf")}
          >
            <Input
              type="date"
              name="validAsOf"
              value={state.validAsOf}
              max={today}
              disabled={state.confirm}
              onChange={(e) => update({ validAsOf: e.target.value })}
              aria-labelledby={labelId("validAsOf")}
              className={cn(KNOWLEDGE_EDITOR_INPUT, "tabular-nums")}
              {...invalid("validAsOf")}
            />
          </Labeled>
          <Labeled
            label="Review by"
            labelId={labelId("reviewBy")}
            hint="Optional"
            error={fieldError("reviewBy")}
            errorId={errorId("reviewBy")}
          >
            <Input
              type="date"
              name="reviewBy"
              value={state.reviewBy}
              min={state.validAsOf || undefined}
              onChange={(e) => update({ reviewBy: e.target.value })}
              aria-labelledby={labelId("reviewBy")}
              className={cn(KNOWLEDGE_EDITOR_INPUT, "tabular-nums")}
              {...invalid("reviewBy")}
            />
          </Labeled>
        </div>
        {state.status === "active" ? (
          <div className={KNOWLEDGE_EDITOR_SWITCH_ROW}>
            <span id={`${id}-confirm`} className="flex min-w-0 flex-col">
              <span className="text-supporting text-fg">
                Confirm against the current docs
              </span>
              <span className={KNOWLEDGE_EDITOR_HINT}>
                Valid as of today and the code&rsquo;s latest commit
              </span>
            </span>
            <Switch
              checked={state.confirm}
              aria-labelledby={`${id}-confirm`}
              onCheckedChange={(confirm) =>
                update({
                  confirm,
                  validAsOf: confirm ? today : initial.validAsOf,
                })
              }
            />
          </div>
        ) : null}
        <Labeled
          label="Depends on"
          labelId={labelId("dependsOn")}
          hint="One per line: repo:docs/export.md, repo:docs/, url:https://…, issue:42, pr:57, release:v1.4.0"
          error={fieldError("dependsOn")}
          errorId={errorId("dependsOn")}
        >
          <Textarea
            name="dependsOn"
            value={state.dependsOn}
            onChange={(e) => update({ dependsOn: e.target.value })}
            aria-labelledby={labelId("dependsOn")}
            className={KNOWLEDGE_EDITOR_LINES}
            spellCheck={false}
            {...invalid("dependsOn")}
          />
        </Labeled>
        <Labeled
          label="Sources"
          labelId={labelId("sources")}
          hint="One per line: where the text came from"
          error={fieldError("sources")}
          errorId={errorId("sources")}
        >
          <Textarea
            name="sources"
            value={state.sources}
            onChange={(e) => update({ sources: e.target.value })}
            aria-labelledby={labelId("sources")}
            className={KNOWLEDGE_EDITOR_LINES}
            spellCheck={false}
            {...invalid("sources")}
          />
        </Labeled>
      </SettingsForm>

      <div className={KNOWLEDGE_EDITOR_BAR}>
        {failure ? (
          "conflict" in failure ? (
            <InlineAlert onRetry={onReload} retryLabel="Reload">
              {CONFLICT_COPY}
            </InlineAlert>
          ) : (
            <InlineAlert>{failure.message}</InlineAlert>
          )
        ) : null}
        <div className={KNOWLEDGE_EDITOR_ACTIONS}>
          {state.path && initial.status !== "retired" ? (
            <Button
              type="button"
              variant="danger"
              className={cn(KNOWLEDGE_EDITOR_ACTION, "mr-auto")}
              disabled={busy !== null}
              onClick={() => void retire()}
            >
              {busy === "retire" ? "Retiring" : "Retire"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className={KNOWLEDGE_EDITOR_ACTION}
            disabled={busy !== null || (!!state.path && !dirty)}
            onClick={() => void save()}
          >
            {busy === "save" ? "Saving" : saveLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

/** A label over its control, a hint beside the label, and the field's
 *  error under it (the control points at it with aria-describedby). */
function Labeled({
  label,
  labelId,
  hint,
  error,
  errorId,
  children,
}: {
  label: string;
  /** The label's id; the control names itself with aria-labelledby. */
  labelId: string;
  hint?: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className={KNOWLEDGE_EDITOR_CONTROL}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span id={labelId} className={KNOWLEDGE_EDITOR_LABEL}>
          {label}
        </span>
        {hint ? <span className={KNOWLEDGE_EDITOR_HINT}>{hint}</span> : null}
      </span>
      {children}
      {error ? (
        <span id={errorId} className={KNOWLEDGE_EDITOR_ERROR}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
