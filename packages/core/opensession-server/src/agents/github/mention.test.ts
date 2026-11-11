import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfigAsync,
  githubBotLogins,
  reviewAgentBotLogin,
} from "../../server/config";
import { BLOB_MARKER, OWN_MARKERS } from "./github-rest";
import { githubMentionHandles, githubMentionPattern } from "./mention";

describe("GitHub mention handles", () => {
  test("always includes the App slug when aliases are configured", () => {
    expect(
      githubMentionHandles({
        persona: "Open Session",
        appSlug: "open-session-os-tella-dev",
        botLogin: "open-session-os-tella-dev[bot]",
        configured: ["tella-butler"],
      }),
    ).toEqual(["opensession", "open-session-os-tella-dev", "tella-butler"]);
  });

  test("adds environment aliases without replacing canonical handles", () => {
    expect(
      githubMentionHandles({
        persona: "OS",
        appSlug: "open-session-acme",
        environment: "@legacy, open-session-acme[bot]",
      }),
    ).toEqual(["os", "open-session-acme", "legacy"]);
  });
});

describe("our own GitHub content", () => {
  test("a post by Blob's GitHub account is ours", () => {
    expect(OWN_MARKERS).toContain(BLOB_MARKER);
    expect(BLOB_MARKER).toBe("<!-- os:blob -->");
  });
});

describe("Blob's GitHub login is not a review-agent handle", () => {
  const savedConfig = process.env.OPENSESSION_CONFIG;
  const dirs: string[] = [];
  afterEach(async () => {
    if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
    else process.env.OPENSESSION_CONFIG = savedConfig;
    if (savedConfig) await getConfigAsync();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function configure(github: Record<string, unknown>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "mention-test-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ integrations: { github } }));
    process.env.OPENSESSION_CONFIG = path;
    await getConfigAsync();
  }

  const handles = () =>
    githubMentionHandles({
      persona: "OS",
      appSlug: "",
      botLogin: reviewAgentBotLogin(),
    });

  test("when it is the only bot login", async () => {
    await configure({ blob: { login: "Acme-Blob" } });
    expect(githubBotLogins()).toEqual(["acme-blob"]);
    expect(reviewAgentBotLogin()).toBe("");
    expect(handles()).toEqual(["os"]);
    expect(githubMentionPattern(handles()).test("@acme-blob have a look")).toBe(
      false,
    );
    expect(githubMentionPattern(handles()).test("@os have a look")).toBe(true);
  });

  test("when the App is set too", async () => {
    await configure({ appSlug: "acme-app", blob: { login: "acme-blob" } });
    expect(githubBotLogins()).toEqual(["acme-app[bot]", "acme-blob"]);
    expect(reviewAgentBotLogin()).toBe("acme-app[bot]");
    expect(handles()).toEqual(["os", "acme-app"]);
    expect(githubMentionPattern(handles()).test("@acme-blob")).toBe(false);
  });
});
