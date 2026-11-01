import { useEffect, useRef, useState } from "react";
import type { SkillSummary } from "../../../shared/instance-skills";
import { relativeTime } from "../../lib/api";
import { ApiError } from "../../lib/api/request";
import {
  createSkill,
  fetchSkills,
  uploadSkill,
} from "../../lib/api/instance-skills";
import { errorMessage } from "../../lib/error-message";
import { isTouchPrimary } from "../../lib/platform";
import { skillNameProblem } from "../../../shared/instance-skills";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import { Disclosure } from "../../ui/disclosure";
import { Field, Input, Textarea } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconChevronRight, IconPlus } from "../icons";
import { SkillPage } from "./SkillPage";

// Settings → Skills: the instance skills every session loads next to the ones
// a project's checkout carries (server/instance-skills.ts). A list, a create
// dialog and an upload; one skill opens its own page (SkillPage) to edit its
// files. The skills the server ships are listed read only, folded, so a name
// that replaces one of them is not a surprise.

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [version, setVersion] = useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetchSkills()
      .then((result) => {
        if (!alive) return;
        setSkills(result.skills);
        setDir(result.dir);
      })
      .catch((fetchError) => {
        if (alive) setError(errorMessage(fetchError, "Failed to load skills"));
      });
    return () => {
      alive = false;
    };
  }, [version]);

  const refresh = () => setVersion((value) => value + 1);

  /** Send the upload. A taken name comes back as the server's message, so
   *  the caller can ask before replacing it; anything else resolves null. */
  async function send(files: File[], replace: boolean): Promise<string | null> {
    setUploading(true);
    let conflict: string | null = null;
    try {
      const result = await uploadSkill(files, { replace });
      toast(
        result.replaced ? `Replaced ${result.name}` : `Added ${result.name}`,
        { variant: "success" },
      );
      refresh();
    } catch (uploadError) {
      if (
        !replace &&
        uploadError instanceof ApiError &&
        uploadError.status === 409
      )
        conflict = uploadError.message;
      else
        toast(errorMessage(uploadError, "Failed to upload the skill"), {
          variant: "error",
        });
    }
    setUploading(false);
    return conflict;
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    const conflict = await send(files, false);
    if (conflict)
      confirm({
        title: "Replace the existing skill?",
        description: `${conflict} Uploading replaces all of its files.`,
        confirmLabel: "Replace",
        destructive: true,
        onConfirm: () => void send(files, true),
      });
  }

  if (open)
    return (
      <SkillPage
        key={open}
        name={open}
        onBack={() => {
          setOpen(null);
          refresh();
        }}
        onRenamed={setOpen}
      />
    );

  const instance = (skills || []).filter((s) => s.origin === "instance");
  const shipped = (skills || []).filter((s) => s.origin === "shipped");

  const uploadButton = isTouchPrimary ? (
    // A phone cannot pick a folder; an archive or a SKILL.md covers it.
    <Button
      variant="default"
      className="phone:min-h-11"
      disabled={uploading}
      onClick={() => fileInput.current?.click()}
    >
      {uploading ? "Uploading…" : "Upload"}
    </Button>
  ) : (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="default" disabled={uploading} caret>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        }
      />
      <Menu.Popup align="end" sideOffset={4}>
        <Menu.Item onClick={() => fileInput.current?.click()}>
          Archive or SKILL.md…
        </Menu.Item>
        <Menu.Item onClick={() => folderInput.current?.click()}>
          Folder…
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );

  return (
    <SettingsPanel>
      <SettingsHeader
        // On a phone the two actions take their own row under the sentence,
        // rather than squeezing it into a column of single words.
        className="phone:flex-col phone:items-stretch phone:[&>div:last-child]:w-full phone:[&>div:last-child>*]:flex-1"
        title="Skills"
        description="Skills every session can use, on top of the ones in a project's own checkout. When two share a name, the project's skill wins."
        actions={
          <>
            {uploadButton}
            <Button
              variant="primary"
              className="phone:min-h-11"
              icon={<IconPlus size={16} />}
              onClick={() => setCreating(true)}
            >
              New skill
            </Button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".zip,.skill,.md,application/zip,text/markdown"
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files || [])];
          event.target.value = "";
          void upload(files);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        // Not in React's input types; every desktop browser supports it.
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          const files = [...(event.target.files || [])];
          event.target.value = "";
          void upload(files);
        }}
      />

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {skills === null && !error ? (
        <SettingCardSkeleton rows={3} label="Loading skills" />
      ) : (
        <SettingCard>
          {instance.length ? (
            instance.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                onOpen={() => setOpen(skill.name)}
              />
            ))
          ) : (
            <EmptyState placement="card" title="No skills yet">
              Create one, or upload a skill's folder, a .zip or a .skill file.
            </EmptyState>
          )}
        </SettingCard>
      )}
      {dir && (
        <SettingsHint>
          Saved on the server in <span className="font-mono">{dir}</span>.
          Changes apply from a session's next turn.
        </SettingsHint>
      )}

      {shipped.length > 0 && (
        <>
          <SettingsGroupLabel>Built in</SettingsGroupLabel>
          <div className="px-5">
            <Disclosure
              title={`${shipped.length} ${shipped.length === 1 ? "skill" : "skills"} that come with the server`}
            >
              <ul className="m-0 flex list-none flex-col gap-3 p-0 pt-2">
                {shipped.map((skill) => (
                  <li key={skill.name} className="min-w-0">
                    <div className="truncate font-mono text-meta text-fg">
                      {skill.name}
                    </div>
                    <div className="line-clamp-2 text-supporting text-dim phone:text-meta">
                      {skill.description}
                    </div>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        </>
      )}

      <CreateSkillDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(name) => {
          setCreating(false);
          setOpen(name);
        }}
      />
      {confirmDialog}
    </SettingsPanel>
  );
}

function SkillRow({
  skill,
  onOpen,
}: {
  skill: SkillSummary;
  onOpen: () => void;
}) {
  const files = skill.fileCount ?? 1;
  return (
    <Button
      variant="ghost"
      className="group min-h-11 w-full justify-start gap-3 whitespace-normal rounded-2xl px-5 py-3.5 text-left font-normal"
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-item-title font-medium text-fg">
            {skill.name}
          </span>
          {skill.replacesShipped && <Badge>Replaces built in</Badge>}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-supporting text-dim phone:text-meta">
          {skill.description}
        </span>
        <span className="mt-1 block text-meta text-faint">
          {files} {files === 1 ? "file" : "files"}
          {skill.updatedAt ? ` · updated ${relativeTime(skill.updatedAt)}` : ""}
        </span>
      </span>
      <IconChevronRight
        size={20}
        className="shrink-0 text-faint group-hover:text-dim"
      />
    </Button>
  );
}

function CreateSkillDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setTouched(false);
  }, [open]);

  const problem = skillNameProblem(name);
  const ready = !problem && description.trim().length > 0;

  async function submit() {
    setTouched(true);
    if (!ready) return;
    setSaving(true);
    try {
      const skill = await createSkill(name, description.trim());
      toast(`Created ${skill.name}`, { variant: "success" });
      onCreated(skill.name);
    } catch (createError) {
      toast(errorMessage(createError, "Failed to create the skill"), {
        variant: "error",
      });
    }
    setSaving(false);
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[30rem]">
        <Modal.Header
          title="New skill"
          description="A SKILL.md with a name and a description. You write the steps next."
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Field label="Name">
              <Input
                autoFocus
                value={name}
                placeholder="release-notes"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="new-skill-name-hint"
                aria-invalid={touched && !!problem && !!name}
                className="font-mono phone:text-[length:var(--text-input-phone)]"
                onChange={(event) =>
                  setName(event.target.value.toLowerCase().replace(/\s+/g, "-"))
                }
              />
            </Field>
            {touched && problem && name ? (
              <span id="new-skill-name-hint" className="text-meta text-red">
                {problem}
              </span>
            ) : (
              <span id="new-skill-name-hint" className="text-meta text-faint">
                Also the command: /{name || "release-notes"}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Field label="When to use it">
              <Textarea
                value={description}
                rows={3}
                placeholder="Write release notes from the PRs merged since the last tag."
                aria-describedby="new-skill-description-hint"
                className="phone:text-[length:var(--text-input-phone)]"
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <span
              id="new-skill-description-hint"
              className="text-meta text-faint"
            >
              Agents read this to decide when the skill applies.
            </span>
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
              disabled={saving || !ready}
            >
              {saving ? "Creating…" : "Create"}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
