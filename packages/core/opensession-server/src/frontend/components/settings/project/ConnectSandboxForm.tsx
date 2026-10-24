import { useId, useState } from "react";
import {
  connectSandbox,
  fetchSandboxConnections,
} from "../../../lib/api/sandboxes";
import { waitForConnection } from "../../../lib/project-settings/connect";
import { patchProjectDefaults } from "../../../lib/api/projects";
import { errorMessage } from "../../../lib/error-message";
import {
  CONNECT_BUTTON,
  CONNECT_CHOICE,
  CONNECT_CHOICES,
  CONNECT_ERROR,
  CONNECT_FIELDS,
  CONNECT_FORM,
  CONNECT_INPUT,
} from "../../../lib/project-settings-classes";
import { nearestRegion } from "../../../lib/project-settings/page-model";
import { browserTimeZone } from "../../../lib/time-of-day";
import { Button } from "../../../ui/button";
import { Field, Input } from "../../../ui/input";
import { Radio, RadioGroup } from "../../../ui/radio";
import { OptionSelect } from "../../../ui/select";
import { toast } from "../../../ui/toast";

type Provider = "daytona" | "box";

const CHOICES: Array<{ id: Provider; label: string; desc: string }> = [
  { id: "daytona", label: "Daytona", desc: "Hosted, pay per minute" },
  { id: "box", label: "Boat", desc: "On your own server" },
];

const REGIONS = [
  { value: "eu", label: "eu" },
  { value: "us", label: "us" },
];

/**
 * Connect a sandbox provider from the checklist, when incident agents have
 * nowhere to run. With no global default yet, the new connection becomes
 * it, so every project can use it. The Connect button is the screen's one
 * ink button while this step blocks.
 */
export function ConnectSandboxForm({
  hasGlobalDefault,
  onConnected,
}: {
  hasGlobalDefault: boolean;
  onConnected: () => void;
}) {
  const [provider, setProvider] = useState<Provider>("daytona");
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState(() => nearestRegion(browserTimeZone()));
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const errorId = useId();
  const name = provider === "daytona" ? "Daytona" : "Boat";

  const connect = async () => {
    setBusy(true);
    try {
      const first = await connectSandbox(provider, {
        apiKey: apiKey.trim(),
        settings: provider === "daytona" ? { region } : {},
      });
      setApiKey("");
      onConnected();
      // Only a connection that passed its check becomes the global
      // default; until then nothing else changes.
      const result = await waitForConnection(provider, first, {
        fetch: fetchSandboxConnections,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      if (result?.state === "ready") {
        if (!hasGlobalDefault)
          await patchProjectDefaults({ sandbox: provider });
        toast(`${name} is connected`, { variant: "success" });
      } else if (result) {
        toast(
          `${name} couldn't connect. ${result.qualification?.failureSummary ?? "See Organization → Sandboxes"}`,
          { variant: "error" },
        );
      } else {
        toast(`${name} is still being checked. See Organization → Sandboxes`);
      }
      onConnected();
    } catch (error) {
      toast(errorMessage(error, `Couldn't connect ${name}`), {
        variant: "error",
      });
    }
    setBusy(false);
  };

  return (
    <form
      className={CONNECT_FORM}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (!apiKey.trim()) return setMissing(true);
        void connect();
      }}
    >
      <RadioGroup
        className={CONNECT_CHOICES}
        aria-label="Provider"
        value={provider}
        onValueChange={(next) =>
          setProvider(next === "box" ? "box" : "daytona")
        }
      >
        {CHOICES.map((choice) => (
          <label
            key={choice.id}
            className={CONNECT_CHOICE}
            data-checked={provider === choice.id ? "" : undefined}
          >
            <Radio value={choice.id} />
            <span className="min-w-0">
              <span className="block text-item-title font-medium text-fg">
                {choice.label}
              </span>
              <span className="block text-meta text-dim">{choice.desc}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <div className={CONNECT_FIELDS}>
        <Field label={`${name} API key`}>
          <Input
            type="password"
            autoComplete="off"
            placeholder={provider === "daytona" ? "dtn_…" : "boat_…"}
            value={apiKey}
            className={CONNECT_INPUT}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? errorId : undefined}
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setMissing(false);
            }}
          />
        </Field>
        {provider === "daytona" ? (
          <Field label="Region" className="phone:order-2">
            <OptionSelect
              label="Region"
              value={region}
              options={REGIONS}
              onChange={(next) => setRegion(next === "us" ? "us" : "eu")}
              className="w-full justify-between phone:min-h-11"
            />
          </Field>
        ) : (
          <span className="phone:hidden" />
        )}
        <Button
          type="submit"
          variant="primary"
          className={CONNECT_BUTTON}
          disabled={busy}
        >
          {busy ? `Checking ${name}` : `Connect ${name}`}
        </Button>
        {/* Under the key field: the grid's next row, first column (right
            after the field on a phone). */}
        {missing && (
          <p id={errorId} role="alert" className={CONNECT_ERROR}>
            {`Paste your ${name} API key first`}
          </p>
        )}
      </div>
      {!hasGlobalDefault && (
        <p className="m-0 text-meta text-faint">
          {`Once its check passes, ${name} becomes the global default, so other projects can use it too`}
        </p>
      )}
    </form>
  );
}
