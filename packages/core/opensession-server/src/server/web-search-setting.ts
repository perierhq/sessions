/**
 * Settings › Models › Web search: which provider the `web_search` and
 * `web_fetch` tools (pi-web-search.ts) use. `auto` uses the session's own
 * provider and never another vendor; `anthropic` or `openai` uses only that
 * provider; `off` removes both tools. Stored as { provider } in the state dir and read fresh
 * (asynchronously) for every turn, so a change applies from the next turn.
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { legacyInputsChanged } from "./projects/legacy-inputs";

export const WEB_SEARCH_SETTINGS = [
  "auto",
  "anthropic",
  "openai",
  "off",
] as const;
export type WebSearchSetting = (typeof WEB_SEARCH_SETTINGS)[number];

export const DEFAULT_WEB_SEARCH_SETTING: WebSearchSetting = "auto";

const storePath = () => stateDir("web-search.json");

export function parseWebSearchSetting(value: unknown): WebSearchSetting | null {
  return typeof value === "string" &&
    (WEB_SEARCH_SETTINGS as readonly string[]).includes(value)
    ? (value as WebSearchSetting)
    : null;
}

/** The stored choice; Automatic when unset or unreadable. */
export async function readWebSearchSetting(
  path = storePath(),
): Promise<WebSearchSetting> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return parseWebSearchSetting(raw?.provider) ?? DEFAULT_WEB_SEARCH_SETTING;
  } catch {
    return DEFAULT_WEB_SEARCH_SETTING;
  }
}

export async function writeWebSearchSetting(
  setting: WebSearchSetting,
  path = storePath(),
): Promise<WebSearchSetting> {
  await writeJsonAtomicAsync(path, { provider: setting });
  legacyInputsChanged();
  return setting;
}
