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
  FIELD_HINT,
  FORM_SECTION_TITLE,
} from "../../lib/incident-settings-classes";
import {
  credentialForm,
  credentialSpec,
  editEffect,
  expiryNote,
  formChanged,
  list,
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
import { Field, Input } from "../../ui/input";
import { PlainButton } from "../../ui/plain-button";
import { InlineAlert } from "../../ui/state";
import { TextLink } from "../../ui/text-link";
import { SettingsDialog } from "./incidents/SettingsDialog";

/** A test result's line takes its tone's ink. */
const TEST_TONE = {
  success: "text-green",
  warning: "text-yellow",
  danger: "text-red",
} as const;

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
  // A failed save is the dialog's own message, above its buttons.
  const [error, setError] = useState<string | null>(null);
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
    : Boolean(form.service.trim() && form.host.trim() && secret);
  const testPath = form.testPath.trim() || list(form.prefixes)[0] || "/";
  const canTest = Boolean(form.host.trim() && (editing || secret));
  const expiry = expiryNote(form.expiresOn || undefined);
  // Said before the save, where the Save button is.
  const effect = editing ? editEffect(initial, form, grants) : null;

  const save = () => {
    setBusy(true);
    setError(null);
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
        setError(errorMessage(e, "Couldn't save the credential"));
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
      .then((result) => setTest({ result, path }))
      .catch((e) =>
        setTest({
          result: { error: errorMessage(e, "Couldn't run the test") },
          path,
        }),
      )
      .finally(() => setTesting(false));
  };
  const outcome = test && testOutcome(test.result, test.path);

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title={credential ? `Edit ${credential.service}` : "Add credential"}
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
        {!editing && (
          <Field label="Service">
            <Input
              className={DIALOG_INPUT}
              value={form.service}
              onChange={(e) => set("service", e.target.value)}
              placeholder="acme-api"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        )}
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
          <Field label="Injection header">
            <Input
              className={DIALOG_INPUT}
              value={form.header}
              onChange={(e) => set("header", e.target.value)}
              placeholder="Authorization"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={headerHintId}
            />
          </Field>
          <p id={headerHintId} className={FIELD_HINT}>
            Leave empty to send Authorization: Bearer &lt;secret&gt;. Paste the
            token alone; a leading Bearer is dropped.
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
  const [service, setService] = useState("");
  const [loginUrl, setLoginUrl] = useState(credential?.loginUrl ?? "");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [password, setPassword] = useState("");
  const [description, setDescription] = useState(credential?.description ?? "");
  const [expiresOn, setExpiresOn] = useState(credential?.expiresOn ?? "");
  const [rotating, setRotating] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionHintId = useId();
  const passwordHintId = useId();
  const expiryHintId = useId();
  const expiry = expiryNote(expiresOn || undefined);
  const changed =
    loginUrl.trim() !== (credential?.loginUrl ?? "") ||
    username.trim() !== (credential?.username ?? "") ||
    description.trim() !== (credential?.description ?? "") ||
    expiresOn !== (credential?.expiresOn ?? "");
  const canSave = editing
    ? changed || password.length > 0
    : Boolean(service.trim() && loginUrl.trim() && username.trim() && password);

  const save = () => {
    setBusy(true);
    setError(null);
    const fields = {
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
          service: service.trim(),
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
        setError(errorMessage(e, "Couldn't save the login"));
      });
  };

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title={credential ? `Edit ${credential.service}` : "Add login"}
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
        {!editing && (
          <Field label="Service">
            <Input
              className={DIALOG_INPUT}
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="acme-staging"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        )}
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
