import { useId, useState } from "react";
import { connectSandbox } from "../../../lib/api/sandboxes";
import { patchProjectDefaults } from "../../../lib/api/projects";
import { errorMessage } from "../../../lib/error-message";
import {
  CONNECT_BUTTON,
  CONNECT_CHOICE,
  CONNECT_CHOICES,
  CONNECT_FIELDS,
  CONNECT_FORM,
  CONNECT_INPUT,
} from "../../../lib/project-settings-classes";
import { nearestRegion } from "../../../lib/project-settings/page-model";
import { browserTimeZone } from "../../../lib/time-of-day";
import { Button } from "../../../ui/button";
import { Field, Input } from "../../../ui/input";
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
  const name = provider === "daytona" ? "Daytona" : "Boat";
  const group = useId();

  const connect = async () => {
    setBusy(true);
    try {
      await connectSandbox(provider, {
        apiKey: apiKey.trim(),
        settings: provider === "daytona" ? { region } : {},
      });
      if (!hasGlobalDefault) await patchProjectDefaults({ sandbox: provider });
      toast(`${name} connection check started`, { variant: "success" });
      setApiKey("");
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
        if (apiKey.trim() && !busy) void connect();
      }}
    >
      <div className={CONNECT_CHOICES} role="radiogroup" aria-label="Provider">
        {CHOICES.map((choice) => (
          <label key={choice.id} className={CONNECT_CHOICE}>
            <input
              type="radio"
              name={group}
              value={choice.id}
              checked={provider === choice.id}
              onChange={() => setProvider(choice.id)}
              className="size-4 accent-[var(--fg)]"
            />
            <span className="min-w-0">
              <span className="block text-item-title font-medium text-fg">
                {choice.label}
              </span>
              <span className="block text-meta text-dim">{choice.desc}</span>
            </span>
          </label>
        ))}
      </div>
      <div className={CONNECT_FIELDS}>
        <Field label={`${name} API key`}>
          <Input
            type="password"
            autoComplete="off"
            placeholder={provider === "daytona" ? "dtn_…" : "boat_…"}
            value={apiKey}
            className={CONNECT_INPUT}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        </Field>
        {provider === "daytona" ? (
          <Field label="Region">
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
          disabled={!apiKey.trim() || busy}
        >
          {`Connect ${name}`}
        </Button>
      </div>
      {!hasGlobalDefault && (
        <p className="m-0 text-meta text-faint">
          {`Once connected, ${name} becomes the global default, so other projects can use it too`}
        </p>
      )}
    </form>
  );
}
