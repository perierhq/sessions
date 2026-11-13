import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { outdatedOwnThreadIds } from "../agents/github/review";
import {
  getConfigAsync,
  githubBotLogins,
  isGithubBotLogin,
  isReviewAgentLogin,
} from "./config";
import {
  __setBlobGithubDepsForTest,
  parseTokenExpiry,
  setBlobGithubSettings,
  validateBlobGithubPatch,
} from "./github-blob";
import { handleBlobGithubRoutes } from "./routes/blob-github";
import type { RouteContext } from "./routes/context";
import { isReservedTeamName } from "./session-actors";

const TOKEN = "github_pat_11AAAAAAA0secretvalue";
const saved = {
  config: process.env.OPENSESSION_CONFIG,
  secrets: process.env.OPENSESSION_WORKSPACE_SECRETS_STORE,
};
const dirs: string[] = [];
const restores: (() => void)[] = [];
let dir = "";

async function setup(blob?: Record<string, unknown>): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "github-blob-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      repos: {
        widget: { repo: join(dir, "widget"), ghRepo: "acme/widget" },
        docs: { repo: join(dir, "docs"), ghRepo: "acme/docs" },
        stored: {
          repo: join(dir, "stored"),
          ghRepo: "acme/stored",
          host: "codestorage",
          csRepo: "acme/stored",
        },
      },
      integrations: { github: { appSlug: "acme-app", ...(blob && { blob }) } },
      identity: {
        team: [
          { name: "Ada Lovelace", github: "ada" },
          { name: "Grace Hopper", github: "grace" },
        ],
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(dir, "secrets.json");
  await getConfigAsync();
}

function github(
  status: number,
  body: unknown,
  expiry: string | null = "2027-02-09 12:00:00 UTC",
) {
  const calls: { url: string; auth: string | null }[] = [];
  restores.push(
    __setBlobGithubDepsForTest({
      now: () => Date.parse("2026-11-11T00:00:00Z"),
      fetch: async (url, init) => {
        calls.push({
          url,
          auth: new Headers(init.headers).get("authorization"),
        });
        return Response.json(body, {
          status,
          headers: expiry
            ? { "github-authentication-token-expiration": expiry }
            : {},
        });
      },
    }),
  );
  return calls;
}

function request(
  method: string,
  body?: unknown,
  login: string | null = "ada",
  path = "/api/blob/github",
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    url,
    path,
    publicPrefix: "",
    authUser: login
      ? { login, name: login === "ada" ? "Ada Lovelace" : "Grace Hopper" }
      : null,
  };
}

async function call(ctx: RouteContext) {
  const res = (await handleBlobGithubRoutes(ctx))!;
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

const storedBlob = () =>
  JSON.parse(readFileSync(process.env.OPENSESSION_CONFIG!, "utf8")).integrations
    .github.blob;
const storedSecrets = (): { purpose: string; value: string }[] => {
  try {
    return JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")).secrets;
  } catch {
    return [];
  }
};

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  const put = (key: string, value: string | undefined) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  put("OPENSESSION_CONFIG", saved.config);
  put("OPENSESSION_WORKSPACE_SECRETS_STORE", saved.secrets);
  if (saved.config) await getConfigAsync();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Blob's GitHub account settings", () => {
  test("saving a token verifies it, records login and expiry, and never returns it", async () => {
    await setup();
    const calls = github(200, { login: "acme-blob", type: "User" });
    const put = await call(
      request("PUT", {
        token: TOKEN,
        repos: ["Acme/Widget", "acme/docs"],
        publicRepos: ["acme/docs"],
        labels: ["bug", "triage"],
        enabled: true,
      }),
    );
    expect(put.status).toBe(200);
    expect(calls).toEqual([
      { url: "https://api.github.com/user", auth: `Bearer ${TOKEN}` },
    ]);
    expect(put.body.blob).toEqual({
      as: "own-account",
      login: "acme-blob",
      expiresAt: "2027-02-09T12:00:00.000Z",
      repos: ["acme/widget", "acme/docs"],
      publicRepos: ["acme/docs"],
      labels: ["bug", "triage"],
      enabled: true,
      tokenSet: true,
    });
    expect(put.text).not.toContain(TOKEN);

    // The config holds a ref; the secret store holds the token.
    const blob = storedBlob();
    expect(JSON.stringify(blob)).not.toContain(TOKEN);
    expect(blob.tokenRef).toMatch(/^wssec-/);
    expect(storedSecrets()).toEqual([
      expect.objectContaining({ purpose: "github.blob", value: TOKEN }),
    ]);

    const get = await call(request("GET"));
    expect(get.status).toBe(200);
    expect(get.body.blob.tokenSet).toBe(true);
    expect(get.text).not.toContain(TOKEN);
    expect(get.text).not.toContain(blob.tokenRef);
  });

  test("the label allowlist is edited through the same route", async () => {
    await setup();
    const cleared = await call(request("PUT", { labels: [] }));
    expect(cleared.status).toBe(200);
    expect(cleared.body.blob.labels).toEqual([]);
    const bad = await call(request("PUT", { labels: ["os-review"] }));
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("starts an agent loop");
  });

  test("a new token replaces the old secret", async () => {
    await setup();
    github(200, { login: "acme-blob" });
    await call(request("PUT", { token: TOKEN }));
    const first = storedBlob().tokenRef;
    await call(request("PUT", { token: `${TOKEN}2` }));
    expect(storedBlob().tokenRef).not.toBe(first);
    expect(storedSecrets().map((s) => s.value)).toEqual([`${TOKEN}2`]);
  });

  test("only the signed-in instance owner may read or change it", async () => {
    await setup();
    const calls = github(200, { login: "acme-blob" });
    for (const ctx of [
      request("GET", undefined, "grace"),
      request("PUT", { token: TOKEN }, "grace"),
      request("DELETE", undefined, "grace", "/api/blob/github/token"),
    ])
      expect((await call(ctx)).status).toBe(403);
    for (const ctx of [
      request("GET", undefined, null),
      request("PUT", { token: TOKEN }, null),
    ])
      expect((await call(ctx)).status).toBe(401);
    // An automation is never a person.
    const automation = request("GET");
    automation.authUser = {
      login: "ada",
      name: "Ada Lovelace",
      automation: true,
    } as RouteContext["authUser"];
    expect((await call(automation)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(storedSecrets()).toEqual([]);
  });

  test("a token GitHub refuses is not stored", async () => {
    await setup();
    github(401, { message: "Bad credentials" });
    const res = await call(request("PUT", { token: TOKEN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("refused the token");
    expect(storedSecrets()).toEqual([]);
    expect(storedBlob()).toBeUndefined();
  });

  test("a token without an expiry is not stored", async () => {
    await setup();
    github(200, { login: "acme-blob" }, null);
    const res = await call(request("PUT", { token: TOKEN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no expiry");
    expect(storedSecrets()).toEqual([]);
  });

  test("an unreadable or past expiry, a GitHub error or no network is refused", async () => {
    await setup();
    github(200, { login: "acme-blob" }, "soon");
    expect((await call(request("PUT", { token: TOKEN }))).status).toBe(502);
    github(200, { login: "acme-blob" }, "2026-01-01 00:00:00 UTC");
    expect((await call(request("PUT", { token: TOKEN }))).body.error).toContain(
      "expired",
    );
    github(503, {});
    expect((await call(request("PUT", { token: TOKEN }))).status).toBe(502);
    restores.push(
      __setBlobGithubDepsForTest({
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect((await call(request("PUT", { token: TOKEN }))).status).toBe(502);
    expect(storedSecrets()).toEqual([]);
  });

  test("a classic token or a teammate's account is refused", async () => {
    await setup();
    const calls = github(200, { login: "Grace" });
    const classic = await call(request("PUT", { token: "ghp_abc123" }));
    expect(classic.status).toBe(400);
    expect(classic.body.error).toContain("fine-grained");
    expect(calls).toEqual([]);
    const teammate = await call(request("PUT", { token: TOKEN }));
    expect(teammate.status).toBe(400);
    expect(teammate.body.error).toContain("teammate");
    expect(storedSecrets()).toEqual([]);
  });

  test("repositories must be registered GitHub repositories", async () => {
    await setup();
    for (const [body, error] of [
      [{ repos: ["acme/other"] }, "acme/other is not a registered"],
      [{ repos: ["acme/stored"] }, "acme/stored is not a registered"],
      [{ repos: "acme/widget" }, "repos: must be a list"],
      [
        { repos: ["acme/widget"], publicRepos: ["acme/docs"] },
        "acme/docs is not one of Blob's repositories",
      ],
      [{ enabled: true }, "Save a token"],
      [{ token: TOKEN, extra: 1 }, "unknown field: extra"],
    ] as const) {
      const res = await call(request("PUT", body));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(error);
    }
    expect(storedBlob()).toBeUndefined();

    const ok = await call(
      request("PUT", { repos: ["acme/widget", "acme/docs"] }),
    );
    expect(ok.body.blob.repos).toEqual(["acme/widget", "acme/docs"]);
    await call(request("PUT", { publicRepos: ["acme/docs"] }));
    // Dropping a repository drops it from the public list too.
    const narrowed = await call(request("PUT", { repos: ["acme/widget"] }));
    expect(narrowed.body.blob.publicRepos).toEqual([]);
  });

  test("a token for another account is refused while a login is recorded", async () => {
    await setup();
    github(200, { login: "acme-blob" });
    await call(request("PUT", { token: TOKEN }));
    const kept = storedBlob();
    github(200, { login: "other-bot" });
    const res = await call(request("PUT", { token: `${TOKEN}2` }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "This token belongs to @other-bot, but Blob's account is @acme-blob; remove Blob's account first.",
    );
    expect(storedBlob()).toEqual(kept);
    expect(storedSecrets().map((s) => s.value)).toEqual([TOKEN]);

    // Also after the token was removed: the login stays Blob's.
    await call(request("DELETE", undefined, "ada", "/api/blob/github/token"));
    expect((await call(request("PUT", { token: TOKEN }))).status).toBe(400);
    expect(storedSecrets()).toEqual([]);
    // The same account, in any case, is fine.
    github(200, { login: "Acme-Blob" });
    expect((await call(request("PUT", { token: TOKEN }))).status).toBe(200);
  });

  test("the check never follows a redirect", async () => {
    await setup();
    let redirect: RequestRedirect | undefined;
    restores.push(
      __setBlobGithubDepsForTest({
        now: () => Date.parse("2026-11-11T00:00:00Z"),
        fetch: async (_url, init) => {
          redirect = init.redirect;
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.test/user" },
          });
        },
      }),
    );
    const res = await call(request("PUT", { token: TOKEN }));
    expect(redirect).toBe("manual");
    expect(res.status).toBe(502);
    expect(storedSecrets()).toEqual([]);
  });

  test("removing the token turns posting off and keeps the login", async () => {
    await setup();
    github(200, { login: "acme-blob" });
    await call(request("PUT", { token: TOKEN, enabled: true }));
    const res = await call(
      request("DELETE", undefined, "ada", "/api/blob/github/token"),
    );
    expect(res.status).toBe(200);
    expect(res.body.blob).toMatchObject({
      login: "acme-blob",
      expiresAt: null,
      enabled: false,
      tokenSet: false,
    });
    expect(storedSecrets()).toEqual([]);
    expect(storedBlob().tokenRef).toBeUndefined();
  });

  test("reads GitHub's expiry header with a zone name or an offset", () => {
    expect(parseTokenExpiry("2027-02-09 12:00:00 UTC")).toBe(
      "2027-02-09T12:00:00.000Z",
    );
    expect(parseTokenExpiry("2027-02-09 12:00:00 -0700")).toBe(
      "2027-02-09T19:00:00.000Z",
    );
    expect(parseTokenExpiry("never")).toBeUndefined();
  });
});

describe("Blob's GitHub login", () => {
  test("is one of our bot logins", async () => {
    await setup({ login: "Acme-Blob", repos: [], enabled: false });
    expect(githubBotLogins()).toEqual(["acme-app[bot]", "acme-blob"]);
    expect(isGithubBotLogin("acme-blob")).toBe(true);
  });

  test("is not the review agent's, whose outdated threads alone are resolved", async () => {
    await setup({ login: "acme-blob" });
    expect(isReviewAgentLogin("acme-app[bot]")).toBe(true);
    expect(isReviewAgentLogin("Acme-Blob")).toBe(false);
    const thread = (id: string, rootAuthor: string, isOutdated = true) => ({
      id,
      rootAuthor,
      isOutdated,
      isResolved: false,
    });
    expect(
      outdatedOwnThreadIds([
        thread("agent", "acme-app[bot]"),
        thread("blob", "acme-blob"),
        thread("human", "ada"),
        thread("current", "acme-app[bot]", false),
        { ...thread("done", "acme-app[bot]"), isResolved: true },
      ]),
    ).toEqual(["agent"]);
  });

  test("is reserved for Blob on the roster", async () => {
    await setup({ login: "acme-blob" });
    expect(isReservedTeamName("ACME-blob")).toBe(true);
    expect(isReservedTeamName("acme")).toBe(false);
    await setup();
    expect(isReservedTeamName("acme-blob")).toBe(false);
  });
});

describe("posting as the owner's account", () => {
  test("a token for the signed-in owner's own account is saved as theirs", async () => {
    await setup();
    github(200, { login: "Ada" });
    const put = await call(
      request("PUT", { as: "owner", token: TOKEN, repos: ["acme/docs"] }),
    );
    expect(put.status).toBe(200);
    expect(put.body.blob).toMatchObject({
      as: "owner",
      login: "Ada",
      repos: ["acme/docs"],
      tokenSet: true,
    });
    expect(storedBlob()).toMatchObject({ as: "owner", login: "Ada" });
    expect(put.text).not.toContain(TOKEN);
  });

  test("the owner's login is never a bot login nor reserved", async () => {
    await setup({ as: "owner", login: "ada", repos: [], enabled: true });
    expect(githubBotLogins()).toEqual(["acme-app[bot]"]);
    expect(isGithubBotLogin("ada")).toBe(false);
    expect(isReviewAgentLogin("ada")).toBe(false);
    expect(isReservedTeamName("ada")).toBe(false);
    // Blob's own name stays reserved either way.
    expect(isReservedTeamName("Blob")).toBe(true);
  });

  test("a token for anyone but the owner is refused, and nothing is stored", async () => {
    await setup();
    for (const login of ["grace", "acme-blob"]) {
      github(200, { login });
      const res = await call(request("PUT", { as: "owner", token: TOKEN }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        `This token belongs to @${login}, but your GitHub account is @ada. To post as you, Blob needs a token from your own account.`,
      );
    }
    expect(storedSecrets()).toEqual([]);
    expect(storedBlob()).toBeUndefined();
  });

  test("the token must match the login the owner signed in with", async () => {
    await setup();
    github(200, { login: "ada" });
    for (const signedInLogin of [undefined, "grace"]) {
      const result = await setBlobGithubSettings(
        { as: "owner", token: TOKEN },
        "Ada",
        { signedInLogin },
      );
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Sign in with GitHub as @ada to save a token for your account.",
      });
    }
    expect(storedSecrets()).toEqual([]);
  });

  test("an owner without a GitHub login on the roster can't use it", async () => {
    await setup();
    github(200, { login: "ada" });
    restores.push(
      __setBlobGithubDepsForTest({
        now: () => Date.parse("2026-11-11T00:00:00Z"),
        fetch: async () =>
          Response.json(
            { login: "ada" },
            {
              headers: {
                "github-authentication-token-expiration":
                  "2027-02-09 12:00:00 UTC",
              },
            },
          ),
        instanceOwner: async () => ({ name: "Ada Lovelace" }),
      }),
    );
    const res = await call(request("PUT", { as: "owner", token: TOKEN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("has no GitHub login on the roster");
  });

  test("switching needs a token, and Blob's own recorded account is removed first", async () => {
    await setup();
    const noToken = await call(request("PUT", { as: "owner" }));
    expect(noToken.status).toBe(400);
    expect(noToken.body.error).toBe(
      "Paste a token for the account Blob will post as.",
    );

    github(200, { login: "acme-blob" });
    await call(request("PUT", { token: TOKEN }));
    await call(request("DELETE", undefined, "ada", "/api/blob/github/token"));
    github(200, { login: "ada" });
    const res = await call(request("PUT", { as: "owner", token: TOKEN }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Blob's own account @acme-blob is still recorded, so its earlier posts count as Blob's. Remove Blob's account (integrations.github.blob) first.",
    );
    expect(storedBlob().as).toBeUndefined();
    expect(storedBlob().login).toBe("acme-blob");
  });

  test("removing the owner's token drops the login, so Blob's own account can follow", async () => {
    await setup();
    github(200, { login: "ada" });
    await call(request("PUT", { as: "owner", token: TOKEN, enabled: true }));
    const removed = await call(
      request("DELETE", undefined, "ada", "/api/blob/github/token"),
    );
    expect(removed.body.blob).toMatchObject({
      as: "owner",
      login: null,
      enabled: false,
      tokenSet: false,
    });
    // Blob's own account must still be nobody's on the roster.
    const mine = await call(
      request("PUT", { as: "own-account", token: TOKEN }),
    );
    expect(mine.status).toBe(400);
    expect(mine.body.error).toContain("is a teammate on the roster");
    github(200, { login: "acme-blob" });
    const own = await call(request("PUT", { as: "own-account", token: TOKEN }));
    expect(own.status).toBe(200);
    expect(own.body.blob).toMatchObject({
      as: "own-account",
      login: "acme-blob",
    });
    expect(storedBlob().as).toBeUndefined();
    expect(githubBotLogins()).toContain("acme-blob");
  });

  test("as is checked", () => {
    expect(validateBlobGithubPatch({ as: "pat" })).toEqual({
      error: 'as: must be "own-account" or "owner"',
    });
    expect(validateBlobGithubPatch({ as: "owner" })).toEqual({ as: "owner" });
  });
});
