import { useId, useState } from "react";
import {
  addKeychainCredential,
  KEYCHAIN_METHODS,
  testKeychainCredential,
  updateKeychainCredential,
  type KeychainCredentialDto,
  type KeychainGrantDto,
  type KeychainMethod,
} from "../../lib/api";
import {
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  FORM_SECTION_TITLE,
} from "../../lib/incident-settings-classes";
import {
  credentialForm,
  credentialName,
  credentialSpec,
  defaultScheme,
  editEffect,
  expiryNote,
  injectionPreview,
  formChanged,
  list,
  serviceIdError,
  serviceSlug,
  testOutcome,
  type CredentialFormState,
  type TestResult,
} from "../../lib/keychain-credential";
import {
  ROLE_CHIP_OFF,
  ROLE_CHIP_ON,
} from "../../lib/project-settings-classes";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../ui/cn";
import { Field, FieldGrid, Input } from "../../ui/input";
import { OptionSelect } from "../../ui/select";
import { PlainButton } from "../../ui/plain-button";
import { InlineAlert } from "../../ui/state";
import { TextLink } from "../../ui/text-link";
import { SettingsDialog } from "./incidents/SettingsDialog";

/** Bearer, Basic, Token or none: "" can't be a select value. */
const SCHEME_OPTIONS = [
  { value: "Bearer", label: "Bearer" },
  { value: "Basic", label: "Basic" },
  { value: "Token", label: "Token" },
  { value: "none", label: "None" },
];

/** A test result's line takes its tone's ink. */
const TEST_TONE = {
  success: "text-green",
  warning: "text-yellow",
  danger: "text-red",
} as const;

/**
 * A credential's name, free text for people, and its ID, the slug agents
 * ask for it by. The ID follows the name until the person edits it by
 * hand. An existing credential's ID is fixed: grants and agents refer to
 * it. A refusal of the ID opens its field and shows under it. A hook that
 * returns the fields, so they render as part of the dialog's own output.
 */
function useNameAndIdFields({
  name,
  service,
  existing,
  error,
  namePlaceholder,
  idPlaceholder,
  onChange,
}: {
  name: string;
  service: string;
  existing: boolean;
  /** The server's refusal of the ID, worded for the field. */
  error: string | null;
  namePlaceholder: string;
  idPlaceholder: string;
  onChange: (next: { name?: string; service?: string }) => void;
}) {
  // Edited by hand: the ID no longer follows the name.
  const [custom, setCustom] = useState(false);
  const [open, setOpen] = useState(false);
  const idLineId = useId();
  const idHintId = useId();
  const errorId = useId();
  const editingId = !existing && (open || error !== null);
  const nameDescribedBy = editingId ? idHintId : `${idLineId} ${idHintId}`;
  const idDescribedBy = error === null ? idHintId : `${idHintId} ${errorId}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Field label="Name">
        <Input
          className={DIALOG_INPUT}
          value={name}
          onChange={(e) => {
            const next = e.target.value;
            onChange(
              custom || existing
                ? { name: next }
                : { name: next, service: serviceSlug(next) },
            );
          }}
          placeholder={namePlaceholder}
          aria-describedby={nameDescribedBy}
        />
      </Field>
      {editingId ? (
        <Field label="ID">
          <Input
            className={DIALOG_INPUT}
            value={service}
            onChange={(e) => {
              setCustom(true);
              onChange({ service: serviceSlug(e.target.value, true) });
            }}
            onBlur={() => onChange({ service: serviceSlug(service) })}
            placeholder={idPlaceholder}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null || undefined}
            aria-describedby={idDescribedBy}
          />
        </Field>
      ) : (
        <p id={idLineId} className={cn(FIELD_HINT, "[overflow-wrap:anywhere]")}>
          {"ID: "}
          {service ? (
            <span className="font-mono text-fg">{service}</span>
          ) : (
            "follows the name"
          )}
          {!existing && (
            <>
              {" · "}
              <TextLink type="button" onClick={() => setOpen(true)}>
                Edit
              </TextLink>
            </>
          )}
        </p>
      )}
      <p id={idHintId} className={FIELD_HINT}>
        {existing
          ? "Agents ask for it by this ID, so it stays as it is"
          : "Agents ask for it by this ID"}
      </p>
      {error !== null && (
        <p id={errorId} className={FIELD_ERROR}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Adding or editing an API credential: one form for both. Mounted only
 * while open (the Keychain section renders it conditionally), so a typed
 * secret never outlives the dialog in React state.
 *
 * Three zones: what the credential is, the ceiling on how it may be used,
 * and a status-only test of what is on screen, saved or not.
 */
export function CredentialDialog({
  credential,
  grants = [],
  onClose,
  onSaved,
}: {
  /** Edit this credential; absent: add a new one. */
  credential?: KeychainCredentialDto;
  /** The credential's grants in view, to say what saving does to them. */
  grants?: readonly KeychainGrantDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = credential !== undefined;
  const [initial] = useState(() => credentialForm(credential));
  const [form, setForm] = useState<CredentialFormState>(initial);
  const [secret, setSecret] = useState("");
  // Adding always takes a secret; editing keeps the current one until
  // the owner chooses to rotate it.
  const [rotating, setRotating] = useState(!editing);
  const [busy, setBusy] = useState(false);
  // A failed save is the dialog's own message, above its buttons, unless
  // it is about the ID, which shows under the ID.
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [test, setTest] = useState<{ result: TestResult; path: string } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const descriptionHintId = useId();
  const secretHintId = useId();
  const headerHintId = useId();
  const methodsLabelId = useId();
  const methodsHintId = useId();
  const prefixesHintId = useId();
  const statusOnlyHintId = useId();
  const expiryHintId = useId();
  const testHintId = useId();
  const testResultId = useId();

  const set = <K extends keyof CredentialFormState>(
    key: K,
    value: CredentialFormState[K],
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    // A result describes what was on screen when it ran.
    setTest(null);
  };
  const toggleMethod = (method: KeychainMethod) =>
    set(
      "methods",
      form.methods.includes(method)
        ? form.methods.filter((m) => m !== method)
        : KEYCHAIN_METHODS.filter(
            (m) => m === method || form.methods.includes(m),
          ),
    );

  const canSave = editing
    ? formChanged(initial, form) || secret.length > 0
    : Boolean(serviceSlug(form.service) && form.host.trim() && secret);
  const testPath = form.testPath.trim() || list(form.prefixes)[0] || "/";
  const canTest = Boolean(form.host.trim() && (editing || secret));
  const expiry = expiryNote(form.expiresOn || undefined);
  // Said before the save, where the Save button is.
  const effect = editing ? editEffect(initial, form, grants) : null;

  const save = () => {
    setBusy(true);
    setError(null);
    setIdError(null);
    const spec = credentialSpec(form);
    const saving = credential
      ? updateKeychainCredential(credential.id, {
          ...spec,
          // Empty keeps the current secret.
          secret,
          expectedUpdatedAt: credential.updatedAt,
        })
      : addKeychainCredential({ ...spec, secret });
    saving
      .then(() => {
        // Cleared first and always: it must not survive a failed reload.
        setSecret("");
        onSaved();
      })
      .catch((e) => {
        setBusy(false);
        const message = errorMessage(e, "Couldn't save the credential");
        const aboutId = editing ? null : serviceIdError(message);
        if (aboutId) setIdError(aboutId);
        else setError(message);
      });
  };

  const runTest = () => {
    setTesting(true);
    const path = testPath;
    testKeychainCredential({
      credentialId: credential?.id,
      spec: credentialSpec(form),
      // Empty tests with the saved secret.
      secret,
      path,
    })
      .then((result) => {
        const aboutId =
          !editing && "error" in result
            ? serviceIdError(String(result.error))
            : null;
        if (aboutId) setIdError(aboutId);
        else setTest({ result, path });
      })
      .catch((e) => {
        const message = errorMessage(e, "Couldn't run the test");
        const aboutId = editing ? null : serviceIdError(message);
        if (aboutId) setIdError(aboutId);
        else setTest({ result: { error: message }, path });
      })
      .finally(() => setTesting(false));
  };
  const outcome = test && testOutcome(test.result, test.path);
  const nameAndId = useNameAndIdFields({
    name: form.name,
    service: form.service,
    existing: editing,
    error: idError,
    namePlaceholder: "Acme orders",
    idPlaceholder: "acme-orders",
    onChange: (next) => {
      setForm((f) => ({ ...f, ...next }));
      setTest(null);
      if (next.service !== undefined) setIdError(null);
    },
  });

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title={
        credential ? `Edit ${credentialName(credential)}` : "Add credential"
      }
      error={error}
      busy={busy}
      canSave={canSave}
      saveLabel={busy ? "Saving…" : credential ? "Save" : "Add credential"}
      onSave={save}
      notice={effect && <InlineAlert variant="warn">{effect.text}</InlineAlert>}
    >
      <p className={FIELD_HINT}>
        A session can borrow it with your approval. The secret is injected
        server-side, so the agent never sees it.
      </p>
      <div className="flex flex-col gap-3">
        {nameAndId}
        <Field label="API host">
          <Input
            className={DIALOG_INPUT}
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
            placeholder="api.example.test"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        {rotating ? (
          <div className="flex flex-col gap-1.5">
            <Field label={editing ? "New secret" : "Secret"}>
              <Input
                className={DIALOG_INPUT}
                type="password"
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setTest(null);
                }}
                autoComplete="off"
                aria-describedby={secretHintId}
              />
            </Field>
            <p id={secretHintId} className={FIELD_HINT}>
              {editing
                ? "Replaces the current secret when you save. Never shown again"
                : "Never shown again, here or to any session"}
              {editing && (
                <>
                  {" · "}
                  <TextLink
                    type="button"
                    onClick={() => {
                      setSecret("");
                      setRotating(false);
                      setTest(null);
                    }}
                  >
                    Keep the current one
                  </TextLink>
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 phone:min-h-11">
            <span className="flex flex-col">
              <span className="text-label font-medium text-dim">Secret</span>
              <span className="text-meta text-faint">
                Set, never shown. Last changed{" "}
                {new Date(credential!.updatedAt).toLocaleDateString()}
              </span>
            </span>
            <Button
              type="button"
              variant="soft"
              size="sm"
              className="phone:min-h-11"
              onClick={() => setRotating(true)}
            >
              Rotate secret
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Field label="Description">
            <Input
              className={DIALOG_INPUT}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Read orders for support replies"
              aria-describedby={descriptionHintId}
            />
          </Field>
          <p id={descriptionHintId} className={FIELD_HINT}>
            Optional. Teammates and their sessions see it
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldGrid>
            <Field label="Header">
              <Input
                className={DIALOG_INPUT}
                value={form.header}
                onChange={(e) => {
                  const header = e.target.value;
                  // The scheme follows the header until it is chosen:
                  // Bearer for Authorization, none for anything else.
                  if (form.scheme === defaultScheme(form.header))
                    set("scheme", defaultScheme(header));
                  set("header", header);
                }}
                placeholder="Authorization"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={headerHintId}
              />
            </Field>
            <Field label="Scheme">
              <OptionSelect
                label="Scheme"
                value={form.scheme || "none"}
                options={SCHEME_OPTIONS}
                onChange={(value) =>
                  set("scheme", value === "none" ? "" : value)
                }
                className="w-full justify-between phone:min-h-11"
              />
            </Field>
          </FieldGrid>
          <p
            id={headerHintId}
            className="m-0 font-mono text-meta text-fg [overflow-wrap:anywhere]"
          >
            Sends: {injectionPreview(form)}
          </p>
          <p className={FIELD_HINT}>
            Paste the token alone; a pasted scheme is dropped. For Basic, paste
            user:password and it is sent base64-encoded
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={FORM_SECTION_TITLE}>Limits</h3>
        {/* Six fixed values: chips, not a text field to spell them in. */}
        <div
          className="flex flex-col gap-1.5"
          role="group"
          aria-labelledby={methodsLabelId}
          aria-describedby={methodsHintId}
        >
          <span id={methodsLabelId} className="text-label font-medium text-dim">
            Allowed methods
          </span>
          {/* Narrower than the role chips so all six fit one dialog row;
              each still has a 44px target through the chip's ::before. */}
          <div className="flex flex-wrap gap-x-1">
            {KEYCHAIN_METHODS.map((method) => (
              <PlainButton
                key={method}
                aria-pressed={form.methods.includes(method)}
                className={cn(
                  form.methods.includes(method) ? ROLE_CHIP_ON : ROLE_CHIP_OFF,
                  "px-2",
                )}
                onClick={() => toggleMethod(method)}
              >
                {method}
              </PlainButton>
            ))}
          </div>
          <p id={methodsHintId} className={FIELD_HINT}>
            None selected allows any method
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="Allowed path prefixes">
            <Input
              className={DIALOG_INPUT}
              value={form.prefixes}
              onChange={(e) => set("prefixes", e.target.value)}
              placeholder="/v1/orders"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={prefixesHintId}
            />
          </Field>
          <p id={prefixesHintId} className={FIELD_HINT}>
            Separate several with commas. Each one covers the paths under it.
            Empty allows any path
          </p>
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="flex cursor-pointer items-center gap-2 text-label phone:min-h-11">
            <Checkbox
              checked={form.statusOnly}
              onCheckedChange={(v) => set("statusOnly", v === true)}
              aria-describedby={statusOnlyHintId}
            />
            Return only the status code, never the response
          </label>
          <p id={statusOnlyHintId} className={cn(FIELD_HINT, "pl-6")}>
            Use this when the API might echo the key back
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-label phone:min-h-11">
          <Checkbox
            checked={form.workspace}
            onCheckedChange={(v) => set("workspace", v === true)}
          />
          Share with the workspace: every session can use it without asking
        </label>
        <div className="flex flex-col gap-1.5">
          <Field label="Expires">
            <Input
              className={cn(DIALOG_INPUT, "w-auto self-start")}
              type="date"
              value={form.expiresOn}
              onChange={(e) => set("expiresOn", e.target.value)}
              aria-describedby={expiryHintId}
            />
          </Field>
          <p
            id={expiryHintId}
            className={cn(FIELD_HINT, expiry?.expired && "text-yellow")}
          >
            {expiryHint(expiry)}
            {form.expiresOn && (
              <>
                {" · "}
                <TextLink type="button" onClick={() => set("expiresOn", "")}>
                  No expiry
                </TextLink>
              </>
            )}
          </p>
        </div>
        <p className="m-0 text-supporting leading-relaxed text-faint">
          Narrow the methods and paths where you can. A grant can only reach
          what the credential allows, so this is the ceiling on anything you
          approve later.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className={FORM_SECTION_TITLE}>Test</h3>
        <div className="flex items-end gap-2">
          <Field label="Test path" className="flex-1">
            <Input
              className={DIALOG_INPUT}
              value={form.testPath}
              onChange={(e) => set("testPath", e.target.value)}
              placeholder={list(form.prefixes)[0] || "/"}
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={`${testHintId} ${testResultId}`}
            />
          </Field>
          <Button
            type="button"
            variant="soft"
            className="phone:min-h-11"
            disabled={!canTest || testing}
            onClick={runTest}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
        </div>
        <p id={testHintId} className={FIELD_HINT}>
          Sends one GET with what is on screen, saved or not, and shows only the
          status code
        </p>
        {/* Space kept for the result, so it lands without moving the
            buttons under it. */}
        <p
          id={testResultId}
          role="status"
          className={cn(
            "m-0 min-h-5 text-meta font-medium [overflow-wrap:anywhere]",
            outcome && TEST_TONE[outcome.tone],
          )}
        >
          {outcome?.text}
        </p>
      </div>
    </SettingsDialog>
  );
}

/**
 * Adding or editing a login: a test account a session signs in with.
 * Unlike an API credential, its password reaches the agent when the owner
 * releases it, so the dialog says so where the password is typed.
 */
export function LoginDialog({
  credential,
  onClose,
  onSaved,
}: {
  credential?: KeychainCredentialDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = credential !== undefined;
  const [name, setName] = useState(credential?.name ?? "");
  const [service, setService] = useState(credential?.service ?? "");
  const [loginUrl, setLoginUrl] = useState(credential?.loginUrl ?? "");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [password, setPassword] = useState("");
  const [description, setDescription] = useState(credential?.description ?? "");
  const [expiresOn, setExpiresOn] = useState(credential?.expiresOn ?? "");
  const [rotating, setRotating] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const descriptionHintId = useId();
  const passwordHintId = useId();
  const expiryHintId = useId();
  const expiry = expiryNote(expiresOn || undefined);
  const nameAndId = useNameAndIdFields({
    name,
    service,
    existing: editing,
    error: idError,
    namePlaceholder: "Acme staging",
    idPlaceholder: "acme-staging",
    onChange: (next) => {
      if (next.name !== undefined) setName(next.name);
      if (next.service !== undefined) {
        setService(next.service);
        setIdError(null);
      }
    },
  });
  const changed =
    name.trim() !== (credential?.name ?? "") ||
    loginUrl.trim() !== (credential?.loginUrl ?? "") ||
    username.trim() !== (credential?.username ?? "") ||
    description.trim() !== (credential?.description ?? "") ||
    expiresOn !== (credential?.expiresOn ?? "");
  const canSave = editing
    ? changed || password.length > 0
    : Boolean(
        serviceSlug(service) && loginUrl.trim() && username.trim() && password,
      );

  const save = () => {
    setBusy(true);
    setError(null);
    setIdError(null);
    const fields = {
      name: name.trim(),
      loginUrl: loginUrl.trim(),
      username: username.trim(),
      description: description.trim(),
      expiresOn: expiresOn || null,
    };
    const saving = credential
      ? updateKeychainCredential(credential.id, {
          ...fields,
          // Empty keeps the current password.
          secret: password,
          expectedUpdatedAt: credential.updatedAt,
        })
      : addKeychainCredential({
          ...fields,
          service: serviceSlug(service),
          kind: "login",
          secret: password,
        });
    saving
      .then(() => {
        setPassword("");
        onSaved();
      })
      .catch((e) => {
        setBusy(false);
        const message = errorMessage(e, "Couldn't save the login");
        const aboutId = editing ? null : serviceIdError(message);
        if (aboutId) setIdError(aboutId);
        else setError(message);
      });
  };

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title={credential ? `Edit ${credentialName(credential)}` : "Add login"}
      error={error}
      busy={busy}
      canSave={canSave}
      saveLabel={busy ? "Saving…" : credential ? "Save" : "Add login"}
      onSave={save}
    >
      <p className={FIELD_HINT}>
        A test account a session can sign in with. You approve each release, and
        the agent can read the password once it has it.
      </p>
      <div className="flex flex-col gap-3">
        {nameAndId}
        <Field label="Sign-in page">
          <Input
            className={DIALOG_INPUT}
            value={loginUrl}
            onChange={(e) => setLoginUrl(e.target.value)}
            placeholder="https://app.example.test/login"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="Username">
          <Input
            className={DIALOG_INPUT}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="qa@example.test"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {rotating ? (
          <div className="flex flex-col gap-1.5">
            <Field label={editing ? "New password" : "Password"}>
              <Input
                className={DIALOG_INPUT}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby={passwordHintId}
              />
            </Field>
            <p id={passwordHintId} className={FIELD_HINT}>
              Never shown again here
              {editing && (
                <>
                  {" · "}
                  <TextLink
                    type="button"
                    onClick={() => {
                      setPassword("");
                      setRotating(false);
                    }}
                  >
                    Keep the current one
                  </TextLink>
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 phone:min-h-11">
            <span className="flex flex-col">
              <span className="text-label font-medium text-dim">Password</span>
              <span className="text-meta text-faint">Set, never shown</span>
            </span>
            <Button
              type="button"
              variant="soft"
              size="sm"
              className="phone:min-h-11"
              onClick={() => setRotating(true)}
            >
              Change password
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Field label="Description">
            <Input
              className={DIALOG_INPUT}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="QA account for checkout tests"
              aria-describedby={descriptionHintId}
            />
          </Field>
          <p id={descriptionHintId} className={FIELD_HINT}>
            Optional. Teammates and their sessions see it
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="Expires">
            <Input
              className={cn(DIALOG_INPUT, "w-auto self-start")}
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-describedby={expiryHintId}
            />
          </Field>
          <p
            id={expiryHintId}
            className={cn(FIELD_HINT, expiry?.expired && "text-yellow")}
          >
            {expiryHint(expiry)}
          </p>
        </div>
      </div>
    </SettingsDialog>
  );
}

function expiryHint(expiry: ReturnType<typeof expiryNote>): string {
  if (!expiry) return "Optional. Sessions can't use it after this day";
  return expiry.expired
    ? `${expiry.text}. Sessions can't use it until you move the date`
    : `${expiry.text}. Sessions can't use it after that day`;
}
