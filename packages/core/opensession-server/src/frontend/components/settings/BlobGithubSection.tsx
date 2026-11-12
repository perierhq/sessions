import { useId, useState } from "react";
import {
  BLOB_GITHUB_DOCS_URL,
  BLOB_GITHUB_PURPOSE,
  BLOB_GITHUB_STEPS,
  parseLabels,
  tokenExpiry,
  type BlobGithub,
  type BlobGithubLoad,
} from "../../lib/blob-github";
import { blobGithubActions } from "../../lib/blob-github-actions";
import { blobInset, blobSubhead } from "../../lib/blob-member-classes";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../ui/cn";
import { useConfirm } from "../../ui/confirm";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";

// Blob's card, GitHub account: the owner sets up the machine user Blob
// writes on GitHub as. The server decides who sees it (401 and 403 hide the
// section); the token goes up once and is never shown again.

/** The section, with its own state and requests. `load` null is still
 *  loading, and shows nothing; `repos` are the registered GitHub
 *  repositories. */
export function BlobGithubSection({
  load,
  repos,
  now,
}: {
  load: BlobGithubLoad | null;
  repos: string[];
  now?: number;
}) {
  const [saved, setSaved] = useState<BlobGithub | null>(null);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  // Nothing while loading either: most people are not the owner, and a
  // placeholder for a part they never get would flash and vanish.
  if (load === null || load.kind === "hidden") return null;
  if (load.kind === "error")
    return (
      <BlobGithubFrame>
        <div className={cn("py-3 text-supporting text-dim", blobInset)}>
          Couldn&rsquo;t load Blob&rsquo;s GitHub account.
        </div>
      </BlobGithubFrame>
    );

  const settings = saved ?? load.settings;
  const act = blobGithubActions({
    settings,
    token,
    setSaved,
    setToken,
    setTokenError,
    setError,
    setBusy,
    confirm,
  });

  return (
    <>
      <BlobGithubView
        settings={settings}
        repos={repos}
        now={now}
        token={token}
        tokenError={tokenError}
        error={error}
        busy={busy}
        onTokenChange={(value) => {
          setToken(value);
          if (tokenError) setTokenError(null);
        }}
        onSaveToken={() => void act.saveToken()}
        onEnabledChange={(enabled) => void act.setEnabled(enabled)}
        onRepoChange={(name, on) => void act.setRepo(name, on)}
        onPublicRepoChange={(name, on) => void act.setPublicRepo(name, on)}
        onLabelsChange={(labels) => void act.setLabels(labels)}
        onRemoveToken={act.removeToken}
      />
      {confirmDialog}
    </>
  );
}

function BlobGithubFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-2">
      <div className={blobSubhead}>GitHub account</div>
      {children}
    </div>
  );
}

/** The section as a picture of its state, so each state renders without
 *  requests. */
export function BlobGithubView({
  settings,
  repos,
  now = Date.now(),
  token = "",
  tokenError = null,
  error = null,
  busy = false,
  onTokenChange = () => {},
  onSaveToken = () => {},
  onEnabledChange = () => {},
  onRepoChange = () => {},
  onPublicRepoChange = () => {},
  onLabelsChange = () => {},
  onRemoveToken = () => {},
}: {
  settings: BlobGithub;
  repos: string[];
  now?: number;
  token?: string;
  tokenError?: string | null;
  error?: string | null;
  busy?: boolean;
  onTokenChange?: (value: string) => void;
  onSaveToken?: () => void;
  onEnabledChange?: (enabled: boolean) => void;
  onRepoChange?: (name: string, on: boolean) => void;
  onPublicRepoChange?: (name: string, on: boolean) => void;
  onLabelsChange?: (labels: string[]) => void;
  onRemoveToken?: () => void;
}) {
  const errorId = useId();
  const tokenField = (
    <TokenField
      token={token}
      error={tokenError}
      busy={busy}
      onChange={onTokenChange}
      onSave={onSaveToken}
    />
  );
  const errorLine = error && (
    <p role="alert" className="m-0 text-supporting text-red" id={errorId}>
      {error}
    </p>
  );

  if (!settings.tokenSet)
    return (
      <BlobGithubFrame>
        <div className={cn("flex flex-col gap-3 py-2", blobInset)}>
          <p className="m-0 text-supporting text-dim">{BLOB_GITHUB_PURPOSE}</p>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-supporting text-dim marker:text-faint">
            {BLOB_GITHUB_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={BLOB_GITHUB_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="self-start text-supporting text-dim underline decoration-line-strong underline-offset-2 hover:text-fg phone:py-2.5"
          >
            All setup steps
          </a>
          {settings.login && (
            <p className="m-0 text-supporting text-dim">
              Blob&rsquo;s account is <GithubLogin login={settings.login} />.
              Paste a new token for it.
            </p>
          )}
          {tokenField}
          {errorLine}
        </div>
      </BlobGithubFrame>
    );

  const expiry = tokenExpiry(settings.expiresAt, now);
  const chosen = new Set(settings.repos);
  // A repository Blob was given that is no longer registered still shows,
  // so it can be taken away.
  const all = [...repos, ...settings.repos.filter((r) => !repos.includes(r))];
  const publicChoices = all.filter((r) => chosen.has(r));

  return (
    <BlobGithubFrame>
      <div className={cn("flex flex-col gap-4 py-2", blobInset)}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_12rem]">
            <div className="text-item-title font-medium text-fg">
              {settings.login ? (
                <GithubLogin login={settings.login} />
              ) : (
                "Token saved"
              )}
            </div>
            {expiry && (
              <div
                className={cn(
                  "mt-0.5 text-supporting tabular-nums",
                  expiry.warn ? "text-yellow" : "text-dim",
                )}
              >
                {expiry.expired
                  ? "Expired. Paste a new token."
                  : expiry.warn
                    ? `${expiry.text}. Paste a new token before then.`
                    : expiry.text}
              </div>
            )}
          </div>
          <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-3 text-supporting text-fg">
            Post on GitHub
            <Switch
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(checked) => onEnabledChange(checked)}
            />
          </label>
        </div>
        {expiry?.warn && tokenField}

        <RepoGroup
          title="Repositories"
          hint="Blob writes only on the ones ticked here."
          empty="No GitHub repository is registered yet."
          names={all}
          checked={chosen}
          busy={busy}
          onChange={onRepoChange}
        />
        <RepoGroup
          title="Public repositories"
          hint={
            "Tick the ones that are public on GitHub. Blob\u2019s comments there are public."
          }
          empty="Tick a repository above first."
          names={publicChoices}
          checked={new Set(settings.publicRepos)}
          busy={busy}
          onChange={onPublicRepoChange}
        />
        {settings.labels && (
          <LabelsField
            // Remounts on a save, so the field shows what the server kept.
            key={settings.labels.join("\n")}
            labels={settings.labels}
            busy={busy}
            onSave={onLabelsChange}
          />
        )}

        {errorLine}
        <Button
          variant="danger"
          size="sm"
          className="self-start phone:min-h-11"
          disabled={busy}
          onClick={onRemoveToken}
        >
          Remove token
        </Button>
      </div>
    </BlobGithubFrame>
  );
}

function GithubLogin({ login }: { login: string }) {
  return (
    <a
      href={`https://github.com/${encodeURIComponent(login)}`}
      target="_blank"
      rel="noreferrer"
      className="text-fg no-underline hover:underline"
    >
      @{login}
    </a>
  );
}

function TokenField({
  token,
  error,
  busy,
  onChange,
  onSave,
}: {
  token: string;
  error: string | null;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const errorId = useId();
  return (
    <form
      className="flex items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          type="password"
          aria-label="GitHub token"
          placeholder="Fine-grained token"
          value={token}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "font-mono placeholder:font-sans phone:min-h-11 phone:text-input-phone",
            error && "border-red",
          )}
          onChange={(e) => onChange(e.target.value)}
        />
        {error && (
          <div
            id={errorId}
            role="alert"
            className="mt-1.5 text-supporting text-red"
          >
            {error}
          </div>
        )}
      </div>
      <Button
        type="submit"
        variant="primary"
        disabled={busy}
        className="phone:min-h-11"
      >
        Save
      </Button>
    </form>
  );
}

function LabelsField({
  labels,
  busy,
  onSave,
}: {
  labels: string[];
  busy: boolean;
  onSave: (labels: string[]) => void;
}) {
  const [text, setText] = useState(labels.join(", "));
  const inputId = useId();
  const hintId = useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(parseLabels(text));
      }}
    >
      <label
        htmlFor={inputId}
        className="block text-supporting font-medium text-fg"
      >
        Labels Blob may set
      </label>
      <div
        id={hintId}
        className="mt-0.5 text-supporting text-dim phone:text-meta"
      >
        Separate them with commas. With none, Blob sets no labels.
      </div>
      <div className="mt-2 flex items-start gap-2">
        <Input
          id={inputId}
          aria-describedby={hintId}
          placeholder="bug, needs-info"
          value={text}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
          className="min-w-0 flex-1 phone:min-h-11 phone:text-input-phone"
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="submit"
          variant="soft"
          disabled={busy}
          className="phone:min-h-11"
        >
          Save labels
        </Button>
      </div>
    </form>
  );
}

function RepoGroup({
  title,
  hint,
  empty,
  names,
  checked,
  busy,
  onChange,
}: {
  title: string;
  hint: string;
  empty: string;
  names: string[];
  checked: Set<string>;
  busy: boolean;
  onChange: (name: string, on: boolean) => void;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId}>
      <div id={titleId} className="text-supporting font-medium text-fg">
        {title}
      </div>
      <div className="mt-0.5 text-supporting text-dim phone:text-meta">
        {hint}
      </div>
      {names.length === 0 ? (
        <div className="mt-2 text-supporting text-faint">{empty}</div>
      ) : (
        <ul className="m-0 mt-1 list-none p-0">
          {names.map((name) => (
            <li key={name}>
              <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-supporting text-fg phone:min-h-11">
                <Checkbox
                  checked={checked.has(name)}
                  disabled={busy}
                  onCheckedChange={(on) => onChange(name, on)}
                />
                <span className="min-w-0 truncate">{name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
