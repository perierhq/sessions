import { useEffect, useId, useState } from "react";
import {
  MAINSPRING_DOCS_URL,
  MAINSPRING_PURPOSE,
  loadMainspring,
  maskedKey,
  modelsSummary,
  plainError,
  removeMainspringKey,
  saveMainspring,
  testMainspring,
  type Mainspring,
  type MainspringLoad,
  type MainspringPatch,
} from "../../lib/mainspring";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { useConfirm } from "../../ui/confirm";
import { Input } from "../../ui/input";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";

// Settings, Providers, Mainspring: the owner points Claude turns at a
// Mainspring gateway. The server decides who sees it (401 and 403 hide the
// section); the key goes up once and only its last four come back.

/** How many model ids the list shows before "and N more". */
const MODELS_SHOWN = 12;

export function MainspringSection() {
  const [load, setLoad] = useState<MainspringLoad | null>(null);
  const [saved, setSaved] = useState<Mainspring | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { ok: true; text: string } | { ok: false; text: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    let live = true;
    void loadMainspring().then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, []);

  // Nothing while loading: most people are not the owner, and a placeholder
  // for a part they never get would flash and vanish.
  if (load === null || load.kind === "hidden") return null;
  if (load.kind === "error")
    return (
      <MainspringFrame>
        <SettingCard>
          <SettingRow>
            <SettingRowDescription className="mt-0">
              Couldn&rsquo;t load the Mainspring settings.
            </SettingRowDescription>
          </SettingRow>
        </SettingCard>
      </MainspringFrame>
    );

  const settings = saved ?? load.settings;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    await work().then(
      () => {},
      (caught: Error) => setError(plainError(caught)),
    );
    setBusy(false);
  };
  const save = (patch: MainspringPatch) =>
    run(async () => {
      setSaved(await saveMainspring(patch));
      if (patch.key !== undefined) setKey("");
      if (patch.url !== undefined) setUrl(null);
      setTestResult(null);
    });

  return (
    <>
      <MainspringView
        settings={settings}
        url={url ?? settings.url ?? ""}
        keyText={key}
        error={error}
        testResult={testResult}
        busy={busy}
        onUrlChange={setUrl}
        onKeyChange={setKey}
        onSave={() => {
          const patch: MainspringPatch = {};
          const nextUrl = (url ?? settings.url ?? "").trim();
          if (nextUrl && nextUrl !== settings.url) patch.url = nextUrl;
          if (key.trim()) patch.key = key;
          if (Object.keys(patch).length) void save(patch);
        }}
        onTest={() =>
          void run(async () => {
            const result = await testMainspring();
            setSaved(result.mainspring);
            setTestResult(
              result.test.ok
                ? {
                    ok: true,
                    text: `Connected. ${result.test.models} ${result.test.models === 1 ? "model" : "models"} listed.`,
                  }
                : { ok: false, text: `${result.test.error}.` },
            );
          })
        }
        onRouteClaudeChange={(routeClaude) => void save({ routeClaude })}
        onFallbackChange={(fallbackDirect) => void save({ fallbackDirect })}
        onRemoveKey={() =>
          confirm({
            title: "Remove the Mainspring key?",
            description:
              "Claude turns go back to the accounts connected here, and pi/mainspring models stop working until you paste a key again.",
            confirmLabel: "Remove key",
            destructive: true,
            onConfirm: () =>
              run(async () => {
                setSaved(await removeMainspringKey());
                setTestResult(null);
              }),
          })
        }
      />
      {confirmDialog}
    </>
  );
}

function MainspringFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsGroupLabel>Mainspring</SettingsGroupLabel>
      {children}
    </>
  );
}

/** The section as a picture of its state, so each state renders without
 *  requests. */
export function MainspringView({
  settings,
  url: urlProp,
  keyText = "",
  error = null,
  testResult = null,
  busy = false,
  onUrlChange = () => {},
  onKeyChange = () => {},
  onSave = () => {},
  onTest = () => {},
  onRouteClaudeChange = () => {},
  onFallbackChange = () => {},
  onRemoveKey = () => {},
}: {
  settings: Mainspring;
  url?: string;
  keyText?: string;
  error?: string | null;
  testResult?: { ok: boolean; text: string } | null;
  busy?: boolean;
  onUrlChange?: (value: string) => void;
  onKeyChange?: (value: string) => void;
  onSave?: () => void;
  onTest?: () => void;
  onRouteClaudeChange?: (on: boolean) => void;
  onFallbackChange?: (on: boolean) => void;
  onRemoveKey?: () => void;
}) {
  const url = urlProp ?? settings.url ?? "";
  const urlId = useId();
  const keyId = useId();
  const ready = Boolean(settings.url && settings.keySet);
  const dirty =
    keyText.trim().length > 0 ||
    (url.trim().length > 0 && url.trim() !== (settings.url ?? ""));
  const summary = modelsSummary(settings);
  const shown = settings.models.slice(0, MODELS_SHOWN);
  const more = settings.models.length - shown.length;
  const fieldClass =
    "min-w-0 flex-[1_1_16rem] font-mono placeholder:font-sans phone:min-h-11 phone:text-input-phone";

  return (
    <MainspringFrame>
      <SettingCard>
        <SettingRow className="items-start">
          <SettingRowText className="flex flex-col gap-3">
            <div>
              <SettingRowTitle>Gateway</SettingRowTitle>
              <SettingRowDescription>
                {ready
                  ? `${settings.url} · ${maskedKey(settings.keyHint)}`
                  : "Mainspring's address and a key from its Keys page."}
              </SettingRowDescription>
            </div>
            <label htmlFor={urlId} className="flex flex-col gap-1">
              <span className="text-label text-dim">Address</span>
              <Input
                id={urlId}
                type="url"
                inputMode="url"
                placeholder="https://mainspring.example.test"
                value={url}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                className={fieldClass}
                onChange={(e) => onUrlChange(e.target.value)}
              />
            </label>
            <label htmlFor={keyId} className="flex flex-col gap-1">
              <span className="text-label text-dim">Key</span>
              <Input
                id={keyId}
                type="password"
                placeholder={
                  settings.keySet
                    ? `${maskedKey(settings.keyHint)} (paste to replace)`
                    : "sk-ms-…"
                }
                value={keyText}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                className={fieldClass}
                onChange={(e) => onKeyChange(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !dirty}
                onClick={onSave}
              >
                Save
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={busy || !ready}
                onClick={onTest}
              >
                Test
              </Button>
              {settings.keySet && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={onRemoveKey}
                >
                  Remove key
                </Button>
              )}
            </div>
            {testResult && (
              <p
                role="status"
                className={cn(
                  "m-0 text-supporting",
                  testResult.ok ? "text-green" : "text-red",
                )}
              >
                {testResult.text}
              </p>
            )}
            {error && (
              <p role="alert" className="m-0 text-supporting text-red">
                {error}
              </p>
            )}
          </SettingRowText>
        </SettingRow>

        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Route Claude through Mainspring</SettingRowTitle>
            <SettingRowDescription>
              {ready
                ? "Claude turns run on Mainspring's accounts. Each session stays on one account."
                : "Save an address and a key first."}
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Switch
              aria-label="Route Claude through Mainspring"
              checked={settings.routeClaude}
              disabled={busy || (!ready && !settings.routeClaude)}
              onCheckedChange={(checked) => onRouteClaudeChange(checked)}
            />
          </SettingRowControl>
        </SettingRow>

        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Fall back to direct accounts</SettingRowTitle>
            <SettingRowDescription>
              When Mainspring can&rsquo;t serve a Claude turn, run it on the
              accounts connected here instead of stopping.
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Switch
              aria-label="Fall back to direct accounts"
              checked={settings.fallbackDirect}
              disabled={busy}
              onCheckedChange={(checked) => onFallbackChange(checked)}
            />
          </SettingRowControl>
        </SettingRow>

        {summary && (
          <SettingRow className="items-start">
            <SettingRowText>
              <SettingRowTitle>Models</SettingRowTitle>
              <SettingRowDescription>
                {summary}. Use any of them as pi/mainspring/&lt;model&gt;.
              </SettingRowDescription>
              {shown.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {shown.map((m) => (
                    <span
                      key={m.id}
                      className="rounded-sm bg-active px-1.5 py-px text-meta text-dim"
                      title={m.name ?? m.id}
                    >
                      {m.id}
                    </span>
                  ))}
                  {more > 0 && (
                    <span className="px-1.5 py-px text-meta text-faint">
                      and {more} more
                    </span>
                  )}
                </div>
              )}
            </SettingRowText>
          </SettingRow>
        )}
      </SettingCard>
      <SettingsHint>
        {MAINSPRING_PURPOSE} The key is stored on the server and never shown
        again.{" "}
        <a
          href={MAINSPRING_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-2 hover:text-fg"
        >
          Setup steps
        </a>
      </SettingsHint>
    </MainspringFrame>
  );
}
