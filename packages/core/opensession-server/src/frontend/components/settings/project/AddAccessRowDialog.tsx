import { useId, useState } from "react";
import useSWR from "swr";
import type {
  AccessRowKey,
  ProjectSettingsView,
} from "../../../../shared/project-settings";
import { parseAutomationEgressDomain } from "../../../../server/sandbox/automation-egress";
import { fetchConnections } from "../../../lib/api/automations";
import { fetchKeychain } from "../../../lib/api/settings";
import { errorMessage } from "../../../lib/error-message";
import {
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
} from "../../../lib/incident-settings-classes";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import {
  SHEET_CHOICE,
  SHEET_CHOICE_DESC,
  SHEET_CHOICE_TITLE,
} from "../../../lib/project-settings-classes";
import { sameRowKey } from "../../../lib/project-settings/page-model";
import { Field, Input } from "../../../ui/input";
import { OptionSelect } from "../../../ui/select";
import { SkeletonBar } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { IconChevronRight } from "../../icons";
import { SettingsDialog } from "../incidents/SettingsDialog";
import { PlainButton } from "../../../ui/plain-button";

type Kind = "connection" | "credential" | "host" | "website";

const KINDS: Array<{ kind: Kind; title: string; desc: string }> = [
  {
    kind: "connection",
    title: "Connector",
    desc: "A connection from Organization → Connections",
  },
  {
    kind: "credential",
    title: "Keychain credential",
    desc: "Lent to incident agents per request or always",
  },
  {
    kind: "host",
    title: "Production host",
    desc: "Read-only commands on a Runner",
  },
  {
    kind: "website",
    title: "Website",
    desc: "A host unattended runs may open",
  },
];

/** The website a person typed, as the allowlist entry it becomes, or why
 *  it can't be one. The server checks again. */
function parseWebsite(text: string): { host: string } | { error: string } {
  try {
    return { host: parseAutomationEgressDomain(text) };
  } catch {
    return { error: "Enter a host name, like status.example.test" };
  }
}

/**
 * Add a row to what agents may use: first what kind, then which one. A new
 * row starts with no role ticked.
 */
export function AddAccessRowDialog({
  open,
  onClose,
  view,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  view: ProjectSettingsView;
  onSave: (body: ProjectPatchBody) => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [pick, setPick] = useState("");
  const [website, setWebsite] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const rows = view.access.groups.flatMap((g) => g.rows.map((r) => r.key));
  const has = (key: AccessRowKey) => rows.some((r) => sameRowKey(r, key));

  const connections = useSWR(
    kind === "connection" ? ["api", "connections-for-project-access"] : null,
    fetchConnections,
  );
  const keychain = useSWR(
    kind === "credential" ? ["api", "keychain-for-project-access"] : null,
    fetchKeychain,
  );

  let choices: Array<{ value: string; label: string }> | null = [];
  if (kind === "connection")
    choices = connections.data
      ? connections.data.mcpServers
          .filter((s) => !has({ kind: "connection", server: s.name }))
          .map((s) => ({ value: s.name, label: s.name }))
      : null;
  else if (kind === "credential")
    choices = keychain.data
      ? keychain.data.credentials
          .filter((c) => c.kind !== "login")
          .filter((c) => !has({ kind: "credential", credential: c.id }))
          .map((c) => ({ value: c.id, label: c.service }))
      : null;
  else if (kind === "host")
    choices = view.runners
      .filter((r) => r.platform !== "win32")
      .filter((r) => !has({ kind: "host", runner: r.id }))
      .map((r) => ({ value: r.id, label: r.name }));
  const loadError =
    kind === "connection"
      ? connections.error
      : kind === "credential"
        ? keychain.error
        : null;

  const parsed = kind === "website" ? parseWebsite(website) : null;
  const chosen = pick || choices?.[0]?.value || "";
  let key: AccessRowKey | null = null;
  if (kind === "website" && parsed && "host" in parsed)
    key = { kind: "website", host: parsed.host };
  else if (kind === "connection" && chosen)
    key = { kind: "connection", server: chosen };
  else if (kind === "credential" && chosen)
    key = { kind: "credential", credential: chosen };
  else if (kind === "host" && chosen) key = { kind: "host", runner: chosen };
  const duplicate = key !== null && has(key);

  const save = () => {
    setTouched(true);
    if (!key || duplicate) return;
    setBusy(true);
    setError(null);
    onSave({ access: { addRows: [key] } }).then(
      () => {
        setBusy(false);
        toast("Added. Tick the roles that may use it");
        onClose();
      },
      (cause) => {
        setBusy(false);
        setError(errorMessage(cause, "Couldn't add it"));
      },
    );
  };

  const title = kind
    ? `Add a ${KINDS.find((k) => k.kind === kind)!.title.toLowerCase()}`
    : "Add to what agents may use";

  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title={title}
      error={error}
      busy={busy}
      canSave={kind !== null && key !== null && !duplicate}
      saveLabel="Add"
      onSave={kind ? save : undefined}
    >
      {!kind ? (
        <div className="-mx-3 flex flex-col">
          {KINDS.map((k) => (
            <PlainButton
              key={k.kind}
              type="button"
              className={SHEET_CHOICE}
              onClick={() => setKind(k.kind)}
            >
              <span className="min-w-0 flex-1">
                <span className={SHEET_CHOICE_TITLE}>{k.title}</span>
                <span className={SHEET_CHOICE_DESC}>{k.desc}</span>
              </span>
              <IconChevronRight size={18} dense className="text-faint" />
            </PlainButton>
          ))}
        </div>
      ) : kind === "website" ? (
        <div className="flex flex-col gap-1.5">
          <Field label="Website">
            <Input
              value={website}
              placeholder="status.example.test"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={DIALOG_INPUT}
              aria-describedby={hintId}
              aria-invalid={(touched && !key) || duplicate || undefined}
              onChange={(event) => setWebsite(event.currentTarget.value)}
              onBlur={() => setTouched(true)}
            />
          </Field>
          <p
            id={hintId}
            className={
              (touched && parsed && "error" in parsed) || duplicate
                ? FIELD_ERROR
                : FIELD_HINT
            }
          >
            {duplicate
              ? "This website is already listed"
              : touched && parsed && "error" in parsed
                ? parsed.error
                : "A host name or *.example.test. No paths or ports"}
          </p>
        </div>
      ) : loadError ? (
        <p className={FIELD_ERROR}>
          {errorMessage(loadError, "Couldn't load the choices")}
        </p>
      ) : choices === null ? (
        <SkeletonBar className="w-[52%]" />
      ) : choices.length ? (
        <Field label={KINDS.find((k) => k.kind === kind)!.title}>
          <OptionSelect
            label={KINDS.find((k) => k.kind === kind)!.title}
            value={chosen}
            options={choices}
            onChange={setPick}
            className="w-full justify-between phone:min-h-11"
          />
        </Field>
      ) : (
        <p className={FIELD_HINT}>
          {kind === "host"
            ? "Every paired Runner is already listed. Pair a new one under Production"
            : "Everything there is already listed"}
        </p>
      )}
    </SettingsDialog>
  );
}
