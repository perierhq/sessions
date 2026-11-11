import { useState } from "react";
import useSWR from "swr";
import {
  BARK_ALGORITHMS,
  BARK_KEY_LENGTH,
  BARK_MODES,
  BARK_OPEN_IN,
  fetchBarkSettings,
  saveBarkSettings,
  sendBarkTest,
  type BarkAlgorithm,
  type BarkMode,
  type BarkOpenIn,
  type BarkPatch,
} from "../../lib/api/bark";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";

// A field and its button take the whole row on a phone.
const FIELD_ROW = "phone:ml-0 phone:w-full phone:max-w-none phone:basis-full";
const FIELD = "w-56 phone:w-full phone:text-input-phone";

type AlgorithmChoice = BarkAlgorithm | "off";

/** Pushes to the owner's iPhone through the Bark app (server: bark.ts). */
export function BarkSection() {
  const user = getCurrentUser();
  const { data, mutate } = useSWR(
    ["api", "supervisor-bark", user] as const,
    () => fetchBarkSettings(),
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [deviceKey, setDeviceKey] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [algorithm, setAlgorithm] = useState<AlgorithmChoice | null>(null);
  const [mode, setMode] = useState<BarkMode | null>(null);
  const [encryptionKey, setEncryptionKey] = useState("");

  const serverValue = server ?? data?.serverUrl ?? "";
  const algorithmValue: AlgorithmChoice =
    algorithm ?? data?.encryption?.algorithm ?? "off";
  const modeValue: BarkMode = mode ?? data?.encryption?.mode ?? "GCM";
  const encryptionChanged =
    algorithmValue !== (data?.encryption?.algorithm ?? "off") ||
    (algorithmValue !== "off" && modeValue !== data?.encryption?.mode) ||
    encryptionKey !== "";

  async function save(patch: BarkPatch, done?: () => void) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await mutate(await saveBarkSettings(patch), { revalidate: false });
      done?.();
    } catch (error) {
      setNote({
        text: errorMessage(error, "Couldn't save Bark settings"),
        error: true,
      });
    }
    setBusy(false);
  }

  function saveEncryption() {
    let encryption: BarkPatch["encryption"] = null;
    if (algorithmValue !== "off") {
      encryption = { algorithm: algorithmValue, mode: modeValue };
      // Left out, the server keeps the saved key for the same algorithm.
      if (encryptionKey) encryption.key = encryptionKey;
    }
    return save({ encryption }, () => {
      setEncryptionKey("");
      setAlgorithm(null);
      setMode(null);
    });
  }

  async function test() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await sendBarkTest();
      setNote({ text: "Test sent. Check your iPhone.", error: false });
    } catch (error) {
      setNote({
        text: errorMessage(error, "Couldn't send the test"),
        error: true,
      });
    }
    setBusy(false);
  }

  return (
    <>
      <SettingsGroupLabel>iPhone through Bark</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Send to Bark"
          desc="The same alerts as push, on the iPhone where the Bark app runs. If that iPhone also has push from Sessions on, each alert shows twice: turn push off there to get one."
          control={
            <Switch
              aria-label="Send to Bark"
              checked={data?.enabled === true}
              disabled={!data?.deviceKey || busy}
              onCheckedChange={(enabled) => void save({ enabled })}
            />
          }
        />
        <SettingRow
          title="Device key"
          desc={
            data?.deviceKey
              ? `Saved: ${data.deviceKey}`
              : "In the Bark app, copy the part of your URL after api.day.app/."
          }
          controlClassName={FIELD_ROW}
          control={
            <div className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                aria-label="Device key"
                className={FIELD}
                value={deviceKey}
                onChange={(e) => setDeviceKey(e.target.value)}
                placeholder={data?.deviceKey ? "Replace key" : "Device key"}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !deviceKey.trim()}
                onClick={() =>
                  void save({ deviceKey: deviceKey.trim() }, () =>
                    setDeviceKey(""),
                  )
                }
              >
                Save
              </Button>
              {data?.deviceKey && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void save({ deviceKey: null })}
                >
                  Remove
                </Button>
              )}
            </div>
          }
        />
        <SettingRow
          title="Server"
          desc="Change it only if you run your own Bark server."
          controlClassName={FIELD_ROW}
          control={
            <div className="flex items-center gap-2">
              <Input
                type="url"
                inputMode="url"
                autoComplete="off"
                aria-label="Server"
                className={FIELD}
                value={serverValue}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://api.day.app"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy || server === null || server === data?.serverUrl}
                onClick={() =>
                  void save({ serverUrl: serverValue.trim() }, () =>
                    setServer(null),
                  )
                }
              >
                Save
              </Button>
            </div>
          }
        />
        <SettingRow
          title="Encryption"
          desc={
            algorithmValue === "off"
              ? "Off. Turn on Push encryption in the Bark app to hide what Bark's server sees."
              : `Use the same algorithm, mode and key as the Bark app${modeValue === "GCM" ? " (padding noPadding)" : " (padding pkcs7)"}. The key is ${BARK_KEY_LENGTH[algorithmValue]} characters.`
          }
          controlClassName={FIELD_ROW}
          control={
            <div className="flex flex-wrap items-center justify-end gap-2 phone:justify-start">
              <Select
                label="Algorithm"
                value={algorithmValue}
                options={[
                  { value: "off" as const, label: "Off" },
                  ...BARK_ALGORITHMS.map((value) => ({ value, label: value })),
                ]}
                onChange={(value) => setAlgorithm(value)}
              />
              {algorithmValue !== "off" && (
                <>
                  <Select
                    label="Mode"
                    value={modeValue}
                    options={BARK_MODES.map((value) => ({
                      value,
                      label: value,
                    }))}
                    onChange={(value) => setMode(value)}
                  />
                  <Input
                    type="password"
                    autoComplete="off"
                    aria-label="Encryption key"
                    className={FIELD}
                    value={encryptionKey}
                    onChange={(e) => setEncryptionKey(e.target.value)}
                    placeholder={
                      data?.encryption ? "Replace key" : "Encryption key"
                    }
                  />
                </>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !encryptionChanged}
                onClick={() => void saveEncryption()}
              >
                Save
              </Button>
            </div>
          }
        />
        <SettingRow
          title="Decisions open in"
          desc="Where tapping a supervisor decision takes you. Choose the web if Blob isn't on that iPhone."
          control={
            <Select
              label="Decisions open in"
              value={data?.openIn ?? "blob"}
              options={BARK_OPEN_IN.map((value: BarkOpenIn) => ({
                value,
                label: value === "blob" ? "Blob" : "Web",
              }))}
              onChange={(openIn) => void save({ openIn })}
            />
          }
        />
        <SettingRow
          title="Read pushes aloud in Blob's voice"
          desc={
            data?.speakAvailable === false && !data.speak
              ? "Not available: this server needs ffmpeg and a Fish Audio key for Blob's voice."
              : "Blob says which project needs you instead of the usual sound. If the clip can't load, Bark plays its Minuet sound."
          }
          control={
            <Switch
              aria-label="Read pushes aloud in Blob's voice"
              checked={data?.speak === true}
              disabled={
                busy || (data?.speakAvailable !== true && data?.speak !== true)
              }
              onCheckedChange={(speak) => void save({ speak })}
            />
          }
        />
        <SettingRow
          title="Send a test"
          desc="Sends one push to check the key and server."
          control={
            <Button
              size="sm"
              disabled={busy || !data?.deviceKey}
              onClick={() => void test()}
            >
              Send test
            </Button>
          }
        />
      </SettingCard>
      <SettingsHint className={note?.error ? "text-red" : undefined}>
        {note?.text ||
          "Without encryption, mentions, comments, reminders and reviews say only what kind of alert it is. Supervisor quiet hours apply here too."}
      </SettingsHint>
    </>
  );
}
