import { useEffect, useState } from "react";
import type { InstanceSkillDetail } from "../../../shared/instance-skills";
import {
  deleteSkill,
  deleteSkillFile,
  fetchSkill,
  fetchSkillFile,
  saveSkillFile,
} from "../../lib/api/instance-skills";
import { errorMessage } from "../../lib/error-message";
import { formatBytes } from "../../lib/images";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import { Field, Input, Textarea } from "../../ui/input";
import { Modal } from "../../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  SettingsSection,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconChevronLeft, IconFileText2, IconPlus, IconTrash } from "../icons";

// One instance skill: its files, an editor for the selected one, and delete.
// Every file is edited as text, SKILL.md included, so frontmatter the form
// would not know about (allowed-tools, license, metadata) survives an edit.
// The server checks SKILL.md on save and says what is wrong.

const SKILL_FILE = "SKILL.md";

export function SkillPage({
  name,
  onBack,
  onRenamed,
}: {
  name: string;
  onBack: () => void;
  /** SKILL.md gave the skill a new name; the page follows it. */
  onRenamed: (name: string) => void;
}) {
  const [detail, setDetail] = useState<InstanceSkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [path, setPath] = useState(SKILL_FILE);
  // The file as saved, and the draft over it. null while it loads.
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Why the last save was refused (a SKILL.md the engine would not load),
  // kept beside the editor until the next edit rather than in a toast.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    let alive = true;
    fetchSkill(name)
      .then((next) => alive && setDetail(next))
      .catch(
        (fetchError) =>
          alive &&
          setError(errorMessage(fetchError, "Failed to load the skill")),
      );
    return () => {
      alive = false;
    };
  }, [name, version]);

  const selected = detail?.files.find((file) => file.path === path);
  const selectedIsText = selected?.text !== false;

  useEffect(() => {
    let alive = true;
    setSaved(null);
    setFileError(null);
    setSaveError(null);
    if (!selectedIsText) return;
    fetchSkillFile(name, path)
      .then((content) => {
        if (!alive) return;
        setSaved(content);
        setDraft(content);
      })
      .catch((fetchError) => {
        if (alive)
          setFileError(errorMessage(fetchError, "Failed to open the file"));
      });
    return () => {
      alive = false;
    };
  }, [name, path, selectedIsText]);

  const dirty = saved !== null && draft !== saved;

  /** Run `go` now, or after the person agrees to drop unsaved edits. */
  function leaving(go: () => void) {
    if (!dirty) return go();
    confirm({
      title: "Discard your changes?",
      description: `${path} has edits that are not saved.`,
      confirmLabel: "Discard",
      destructive: true,
      onConfirm: go,
    });
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await saveSkillFile(name, path, draft);
      setSaved(draft);
      toast(next !== name ? `Saved and renamed to ${next}` : `Saved ${path}`, {
        variant: "success",
      });
      if (next !== name) onRenamed(next);
      else setVersion((value) => value + 1);
    } catch (failure) {
      setSaveError(errorMessage(failure, "Failed to save the file"));
    }
    setSaving(false);
  }

  function removeFile(filePath: string) {
    confirm({
      title: `Delete ${filePath}?`,
      description: "Sessions stop seeing it from their next turn.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteSkillFile(name, filePath);
          if (filePath === path) setPath(SKILL_FILE);
          setVersion((value) => value + 1);
        } catch (deleteError) {
          toast(errorMessage(deleteError, "Failed to delete the file"), {
            variant: "error",
          });
        }
      },
    });
  }

  function removeSkill() {
    confirm({
      title: `Delete ${name}?`,
      description:
        "Its folder and every file in it are removed from the server. Sessions stop loading it from their next turn.",
      confirmLabel: "Delete skill",
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteSkill(name);
          toast(`Deleted ${name}`, { variant: "success" });
          onBack();
        } catch (deleteError) {
          toast(errorMessage(deleteError, "Failed to delete the skill"), {
            variant: "error",
          });
        }
      },
    });
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title={name}
        description={
          <>
            {/* The phone sheet hides the h1 and names the section instead,
                so the skill's own name rides here there. */}
            <span className="hidden text-section-title font-title text-fg [.settings-sheet_&]:mb-1 [.settings-sheet_&]:block">
              {name}
            </span>
            {detail?.description}
          </>
        }
      />
      <div className="mb-3 px-5">
        <Button
          size="sm"
          variant="ghost"
          className="phone:min-h-11"
          icon={<IconChevronLeft size={18} />}
          onClick={() => leaving(onBack)}
        >
          Skills
        </Button>
      </div>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      <SettingsGroupLabel
        className="mt-3"
        actions={
          <Button
            size="sm"
            variant="ghost"
            className="phone:min-h-11"
            icon={<IconPlus size={16} />}
            disabled={!detail}
            onClick={() => leaving(() => setAdding(true))}
          >
            Add file
          </Button>
        }
      >
        Files
      </SettingsGroupLabel>
      {!detail ? (
        <SettingCardSkeleton rows={2} label="Loading files" />
      ) : (
        <SettingCard>
          {detail.files.map((file) => (
            <div
              key={file.path}
              className={cn(
                "flex items-center gap-1 pr-3",
                file.path === path && "bg-hover",
              )}
            >
              <Button
                variant="ghost"
                aria-current={file.path === path ? "true" : undefined}
                className="min-h-11 min-w-0 flex-1 justify-start gap-3 rounded-2xl px-5 py-3 text-left font-normal"
                icon={<IconFileText2 size={18} />}
                onClick={() => {
                  if (file.path !== path) leaving(() => setPath(file.path));
                }}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-3">
                  <span className="truncate font-mono text-meta text-fg">
                    {file.path}
                  </span>
                  <span className="ml-auto shrink-0 text-meta text-faint">
                    {formatBytes(file.size)}
                  </span>
                </span>
              </Button>
              {file.path === SKILL_FILE ? (
                // Holds the column, so every size lines up.
                <span aria-hidden className="size-8 shrink-0 phone:size-11" />
              ) : (
                <Button
                  variant="ghost"
                  className="shrink-0 phone:size-11"
                  icon={<IconTrash size={18} />}
                  aria-label={`Delete ${file.path}`}
                  onClick={() => removeFile(file.path)}
                />
              )}
            </div>
          ))}
        </SettingCard>
      )}

      <SettingsGroupLabel>
        <span className="font-mono">{path}</span>
      </SettingsGroupLabel>
      <SettingsSection>
        {!selectedIsText ? (
          <p className="m-0 text-supporting text-dim">
            This file is not text, so it cannot be edited here. Upload the skill
            again to replace it, or delete it.
          </p>
        ) : fileError ? (
          <InlineAlert>{fileError}</InlineAlert>
        ) : (
          <>
            <Textarea
              aria-label={`Contents of ${path}`}
              className="min-h-[24rem] font-mono text-meta leading-relaxed phone:min-h-[60dvh] phone:text-[length:var(--text-input-phone)]"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={saved === null}
              value={saved === null ? "" : draft}
              placeholder={saved === null ? "Loading…" : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaveError(null);
              }}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            {saveError && (
              <InlineAlert
                className="mt-3"
                onDismiss={() => setSaveError(null)}
              >
                {saveError}
              </InlineAlert>
            )}
            <div className="mt-3 flex items-center justify-end gap-2 phone:[&>button]:min-h-11 phone:[&>button]:flex-1">
              <Button
                variant="soft"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(saved ?? "");
                  setSaveError(null);
                }}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </SettingsSection>
      {path === SKILL_FILE && (
        <SettingsHint>
          Keep the frontmatter: a name (lowercase words joined by hyphens) and a
          description of when to use the skill. Changing the name renames the
          skill.
        </SettingsHint>
      )}

      <SettingsGroupLabel>Remove</SettingsGroupLabel>
      <SettingCard>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Delete this skill</SettingRowTitle>
            <SettingRowDescription>
              Removes the folder and every file in it.
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Button
              variant="danger"
              className="phone:min-h-11"
              disabled={!detail}
              onClick={removeSkill}
            >
              Delete
            </Button>
          </SettingRowControl>
        </SettingRow>
      </SettingCard>

      <AddFileDialog
        open={adding}
        onOpenChange={setAdding}
        taken={new Set(detail?.files.map((file) => file.path))}
        onAdd={async (filePath) => {
          await saveSkillFile(name, filePath, "");
          setAdding(false);
          setVersion((value) => value + 1);
          setPath(filePath);
        }}
      />
      {confirmDialog}
    </SettingsPanel>
  );
}

function AddFileDialog({
  open,
  onOpenChange,
  taken,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: Set<string>;
  onAdd: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setPath("");
  }, [open]);

  const clean = path.trim().replace(/^\.?\/+/, "");
  const exists = taken.has(clean);

  async function submit() {
    if (!clean || exists) return;
    setSaving(true);
    try {
      await onAdd(clean);
    } catch (addError) {
      toast(errorMessage(addError, "Failed to add the file"), {
        variant: "error",
      });
    }
    setSaving(false);
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[28rem]">
        <Modal.Header
          title="Add a file"
          description="Reference material or a script the skill points to. Link it from SKILL.md by this path."
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Field label="Path in the skill folder">
              <Input
                autoFocus
                value={path}
                placeholder="references/style-guide.md"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={exists}
                className="font-mono phone:text-[length:var(--text-input-phone)]"
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
            {exists && (
              <span role="alert" className="text-meta text-red">
                That file already exists.
              </span>
            )}
          </div>
          <Modal.Footer>
            <Button
              type="button"
              variant="soft"
              className="phone:min-h-11 phone:flex-1"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="phone:min-h-11 phone:flex-1"
              disabled={saving || !clean || exists}
            >
              {saving ? "Adding…" : "Add"}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
