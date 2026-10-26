/**
 * Which GitHub credential a session's server-side git uses. A support
 * session is credited to the assistant persona; a persona named like a
 * teammate must never pick up that teammate's token, in either mode.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "./config";
import {
  createGithubCredential,
  sessionPushGithubCredential,
} from "./session-github-credential";
import { __setIdentitiesForTest } from "./shared/user-mappings";

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_AUTH_STORE",
  "OPENSESSION_GITHUB_CLIENT_ID",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const PAT = {
  name: "Pat Smith",
  email: "pat@example.test",
  github: "pat-smith",
};

let dir = "";
let restoreTeam: () => void = () => {};

async function withConfig(config: unknown): Promise<void> {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "session-github-credential-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  // The roster has "Pat Smith"; the persona is "Pat", her first name.
  restoreTeam = __setIdentitiesForTest([PAT]);
  writeFileSync(
    process.env.OPENSESSION_GITHUB_AUTH_STORE,
    JSON.stringify({
      users: {
        "pat-smith": {
          login: "pat-smith",
          token: "gho_pat",
          source: "device",
          connectedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    }),
  );
});

afterEach(async () => {
  restoreTeam();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await getConfigAsync();
  rmSync(dir, { recursive: true, force: true });
});

const supportRefs = [{ kind: "support", id: "sc_1" }];

for (const mode of ["operator", "simple"] as const) {
  describe(`${mode} mode`, () => {
    beforeEach(async () => {
      await withConfig({
        persona: { name: "Pat" },
        identity: { team: [PAT] },
        ...(mode === "operator"
          ? {
              integrations: {
                github: { userPrAuth: true, oauthClientId: "test-client-id" },
              },
            }
          : {}),
      });
    });

    test("a support session credited to the persona pushes with no person's token", () => {
      const support = { createdBy: "Pat", externalRefs: supportRefs };
      expect(sessionPushGithubCredential(support)).toBeNull();
      // The same creator on an ordinary session resolves to the teammate:
      // only the support rule keeps her token out.
      expect(
        sessionPushGithubCredential({ createdBy: "Pat" })?.env.GH_TOKEN,
      ).toBe("gho_pat");
    });

    test("a support session ignores even a recorded login", () => {
      expect(
        sessionPushGithubCredential({
          createdBy: "Pat",
          createdByLogin: "pat-smith",
          externalRefs: supportRefs,
        }),
      ).toBeNull();
    });

    test("creating into a support workspace or under a support session fetches with no person's token", () => {
      expect(
        createGithubCredential({ user: "Pat", workspaceRefs: supportRefs }),
      ).toBeNull();
      expect(
        createGithubCredential({
          user: "Pat",
          parentSession: { createdBy: "Pat", externalRefs: supportRefs },
        }),
      ).toBeNull();
      expect(createGithubCredential({ user: "Pat" })?.env.GH_TOKEN).toBe(
        "gho_pat",
      );
    });
  });
}

test("automation-owned sessions keep using no person's token", async () => {
  await withConfig({});
  expect(
    sessionPushGithubCredential({ createdBy: "Pat Smith", automation: "a1" }),
  ).toBeNull();
  expect(
    createGithubCredential({
      user: "Pat Smith",
      parentSession: { createdBy: "Pat Smith", automation: "a1" },
    }),
  ).toBeNull();
});
