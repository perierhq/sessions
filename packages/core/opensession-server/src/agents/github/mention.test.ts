import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfigAsync,
  githubBotLogins,
  isGithubBotLogin,
  personaName,
  reviewAgentBotLogin,
} from "../../server/config";
import { isBlobPost } from "./constants";
import { BLOB_MARKER, OWN_MARKERS } from "./github-rest";
import {
  githubMentionHandles,
  githubMentionPattern,
  mentionsAgent,
} from "./mention";

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

  test("Blob posting as the owner: the marker alone says the post is ours", async () => {
    await configure({
      appSlug: "acme-app",
      blob: { as: "owner", login: "ada" },
    });
    // The owner's login stays a person's.
    expect(githubBotLogins()).toEqual(["acme-app[bot]"]);
    expect(isGithubBotLogin("ada")).toBe(false);
    const handle = personaName()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    const asked = `@${handle} could you take a look?`;
    const byBlob = `${asked}\n\n<sub>Written by Blob, Ada's assistant</sub>${BLOB_MARKER}`;
    expect(isBlobPost(byBlob)).toBe(true);
    expect(mentionsAgent(byBlob)).toBe(false);
    // The owner's own comment, without the marker, is still a person's.
    expect(isBlobPost(asked)).toBe(false);
    expect(mentionsAgent(asked)).toBe(true);
  });

  test("when the App is set too", async () => {
    await configure({ appSlug: "acme-app", blob: { login: "acme-blob" } });
    expect(githubBotLogins()).toEqual(["acme-app[bot]", "acme-blob"]);
    expect(reviewAgentBotLogin()).toBe("acme-app[bot]");
    expect(handles()).toEqual(["os", "acme-app"]);
    expect(githubMentionPattern(handles()).test("@acme-blob")).toBe(false);
  });
});
