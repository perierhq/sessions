// Blob's GitHub writes (github-blob.ts, blob-github-tools.ts): every guard,
// the footer and marker, audits, limits, a 401 and the expiry warning,
// against GitHub replaced and the real inbox on the in-memory kernel.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "./config";
import {
  BLOB_WRITES_PER_HOUR,
  BLOB_WRITES_PER_INSTANCE_HOUR,
  BLOB_WRITES_PER_THREAD_HOUR,
  __setBlobGithubDepsForTest,
  blobClose,
  blobComment,
  blobLabel,
  blobOpenIssue,
  blobRequestRefusal,
  blobReview,
  blobSupervisorPoster,
  blobTextRefusal,
  checkBlobGithubExpiry,
  setBlobGithubSettings,
  validateBlobGithubPatch,
  type BlobPoster,
} from "./github-blob";
import { __setOwnerRosterForTest } from "./incidents/owner";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import {
  __setSupervisorInboxDepsForTest,
  listSupervisorItems,
  sweepSupervisorInbox,
} from "./supervisor-inbox";

const TOKEN = "github_pat_11AAAAAAA0secretvalue";
const NOW = Date.parse("2026-11-11T09:00:00Z");
const EXPIRES = "2027-02-09 12:00:00 UTC";
const ADA = { name: "Ada Lovelace", email: "ada@example.test", github: "ada" };
const NOLOGIN = { name: "Nell Example", email: "nell@example.test" };
const BOB = { name: "Bob Example", email: "bob@example.test", github: "bob" };
const CAT = { name: "Cat Example", email: "cat@example.test", github: "cat" };
const ADA_POSTS: BlobPoster = { owner: "Ada", sessionId: "os-sup-ada" };

const dir = mkdtempSync(join(tmpdir(), "github-blob-write-"));
const saved = {
  config: process.env.OPENSESSION_CONFIG,
  secrets: process.env.OPENSESSION_WORKSPACE_SECRETS_STORE,
  state: process.env.OPENSESSION_STATE_DIR,
};
process.env.OPENSESSION_STATE_DIR = dir;
process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(dir, "secrets.json");
const configPath = join(dir, "config.json");

let restoreTeam = () => {};
beforeAll(() => {
  restoreTeam = __setIdentitiesForTest([ADA, NOLOGIN, BOB, CAT]);
  __setOwnerRosterForTest([ADA] as never, "Ada");
});
afterAll(() => {
  restoreTeam();
  for (const [key, value] of [
    ["OPENSESSION_CONFIG", saved.config],
    ["OPENSESSION_WORKSPACE_SECRETS_STORE", saved.secrets],
    ["OPENSESSION_STATE_DIR", saved.state],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  redirect?: RequestRedirect;
  auth: string | null;
  body: any;
}

let now = NOW;
let calls: Call[] = [];
let audits: Record<string, unknown>[] = [];
let visibility: Record<string, boolean | null> = {};
/** GitHub's answer to each write: status and body, by method and path
 *  suffix; default 201 with an html_url. */
let answer: (call: Call) => Response | Promise<Response> = () =>
  Response.json(
    { html_url: "https://github.com/x", number: 7 },
    { status: 201 },
  );
let restores: (() => void)[] = [];
let previousStore: SessionKernelStore | undefined;

/** A fresh instance: three GitHub repositories, Blob set up and on. */
async function setup(
  blob: {
    enabled?: boolean;
    publicRepos?: string[];
    labels?: string[];
    as?: "own-account" | "owner";
  } = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  writeFileSync(
    configPath,
    JSON.stringify({
      persona: { name: "Pat" },
      repos: {
        widget: { repo: join(dir, "widget"), ghRepo: "acme/widget" },
        docs: { repo: join(dir, "docs"), ghRepo: "acme/docs" },
        site: { repo: join(dir, "site"), ghRepo: "acme/site" },
        other: { repo: join(dir, "other"), ghRepo: "acme/other" },
      },
      integrations: { github: { appSlug: "acme-app" } },
      identity: { team: [ADA, NOLOGIN, BOB, CAT] },
      ...extra,
    }),
  );
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ secrets: [] }));
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
  // Save the token as the settings route does, with GitHub's /user faked.
  const restore = __setBlobGithubDepsForTest({
    now: () => now,
    fetch: async () =>
      Response.json(
        { login: blob.as === "owner" ? "ada" : "acme-blob" },
        { headers: { "github-authentication-token-expiration": EXPIRES } },
      ),
  });
  const saved = await setBlobGithubSettings(
    {
      ...(blob.as ? { as: blob.as } : {}),
      token: TOKEN,
      repos: ["acme/widget", "acme/docs", "acme/site"],
      publicRepos: blob.publicRepos ?? ["acme/docs"],
      labels: blob.labels ?? ["bug", "triage", "made-up"],
      enabled: blob.enabled ?? true,
    },
    "Ada",
    { signedInLogin: "ada" },
  );
  restore();
  expect(saved.ok).toBe(true);
  restores.push(
    __setBlobGithubDepsForTest({
      now: () => now,
      fetch: async (url, init) => {
        const call: Call = {
          url,
          method: init.method ?? "GET",
          redirect: init.redirect,
          auth: new Headers(init.headers).get("authorization"),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        return answer(call);
      },
      repoIsPrivate: async (repo) => visibility[repo] ?? null,
      audit: (event) => {
        audits.push(event);
      },
      sessionLink: async (id) => `https://sessions.example.test/session/${id}`,
    }),
  );
}

const blobConfig = () =>
  JSON.parse(readFileSync(configPath, "utf8")).integrations.github.blob;

beforeEach(async () => {
  previousStore = __setSessionKernelStoreForTest(
    new SessionKernelStore(":memory:"),
  );
  now = NOW;
  calls = [];
  audits = [];
  visibility = {
    "acme/widget": true,
    "acme/docs": false,
    "acme/site": false,
    "acme/other": true,
  };
  answer = () =>
    Response.json(
      { html_url: "https://github.com/acme/widget/issues/7#c", number: 7 },
      { status: 201 },
    );
  restores.push(
    __setSupervisorInboxDepsForTest({
      now: () => now,
      notify: async () => null,
      markDone: async () => {},
      supervisorSessionId: async (user) => `os-sup-${user.toLowerCase()}`,
      rotateSupervisor: async () => null,
      ensureWatch: async () => null,
      timeZone: () => "UTC",
    }),
  );
  await setup();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  __setSessionKernelStoreForTest(previousStore);
});

const comment = (
  body = "Looks good to me.",
  poster = ADA_POSTS,
  repo = "acme/widget",
) => blobComment(poster, { repo, number: 12, body });

describe("Blob's GitHub writes", () => {
  test("a comment on a private repository: footer with the session, marker, audit", async () => {
    const result = await comment();
    expect(result).toEqual({
      ok: true,
      message: "Commented: https://github.com/acme/widget/issues/7#c",
      url: "https://github.com/acme/widget/issues/7#c",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(
      "https://api.github.com/repos/acme/widget/issues/12/comments",
    );
    expect(call!.method).toBe("POST");
    expect(call!.redirect).toBe("manual");
    expect(call!.auth).toBe(`Bearer ${TOKEN}`);
    expect(call!.body.body).toBe(
      "Looks good to me.\n\n<sub>Blob, for @ada · [session](https://sessions.example.test/session/os-sup-ada)</sub><!-- os:blob -->",
    );
    expect(audits).toEqual([
      {
        kind: "blob_github_write",
        action: "comment",
        repo: "acme/widget",
        number: 12,
        text_sha256: new Bun.CryptoHasher("sha256")
          .update("Looks good to me.")
          .digest("hex"),
        status: 201,
        user: "Ada",
        actor: "Blob",
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain("Looks good");
  });

  test("a listed public repository gets the footer without the session link", async () => {
    expect((await comment("Thanks!", ADA_POSTS, "acme/docs")).ok).toBe(true);
    expect(calls[0]!.body.body).toBe(
      "Thanks!\n\n<sub>Blob, for @ada</sub><!-- os:blob -->",
    );
  });

  test("a review is always event COMMENT, and every body is signed", async () => {
    const result = await blobReview(ADA_POSTS, {
      repo: "acme/widget",
      pr: 4,
      body: "Two notes.",
      comments: [{ path: "src/a.ts", line: 3, body: "Null here?" }],
    });
    expect(result.ok).toBe(true);
    const [call] = calls;
    expect(call!.url).toBe(
      "https://api.github.com/repos/acme/widget/pulls/4/reviews",
    );
    expect(call!.body.event).toBe("COMMENT");
    expect(call!.body.body).toEndWith("<!-- os:blob -->");
    expect(call!.body.body).toContain("<sub>Blob, for @ada");
    expect(call!.body.comments).toEqual([
      {
        path: "src/a.ts",
        line: 3,
        body: expect.stringMatching(
          /^Null here\?\n\n<sub>Blob, for @ada.*<!-- os:blob -->$/,
        ),
      },
    ]);
    expect(audits[0]).toMatchObject({ action: "review", number: 4 });
  });

  test("an issue is opened with the footer", async () => {
    const result = await blobOpenIssue(ADA_POSTS, {
      repo: "widget",
      title: "Login fails on Safari",
      body: "Steps below.",
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toStartWith("Opened #7");
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/widget/issues",
    );
    expect(calls[0]!.body.title).toBe("Login fails on Safari");
    expect(calls[0]!.body.body).toEndWith("<!-- os:blob -->");
  });

  test("labels: only existing ones are added", async () => {
    answer = (call) =>
      call.method === "GET"
        ? Response.json(
            call.url.endsWith("/labels/bug")
              ? { name: "bug" }
              : { message: "Not Found" },
            { status: call.url.endsWith("/labels/bug") ? 200 : 404 },
          )
        : Response.json([], { status: 200 });
    const missing = await blobLabel(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      add: ["made-up"],
      remove: [],
    });
    expect(missing).toEqual({
      ok: false,
      message:
        "acme/widget has no label named made-up. Blob only uses existing labels.",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    calls = [];
    const added = await blobLabel(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      add: ["bug"],
      remove: ["triage"],
    });
    expect(added).toEqual({ ok: true, message: "Added bug; removed triage." });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widget/labels/bug",
      "POST https://api.github.com/repos/acme/widget/issues/12/labels",
      "DELETE https://api.github.com/repos/acme/widget/issues/12/labels/triage",
    ]);
    expect(calls[1]!.body).toEqual({ labels: ["bug"] });
  });
});

describe("guards refuse before anything reaches GitHub", () => {
  async function refused(
    run: () => Promise<{ ok: boolean; message?: string }>,
    pattern: RegExp,
  ) {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  }

  test("posting off", async () => {
    await setup({ enabled: false });
    await refused(() => comment(), /account is off/);
  });

  test("an expired token", async () => {
    now = Date.parse("2027-02-10T00:00:00Z");
    await refused(() => comment(), /has expired/);
  });

  test("no token", async () => {
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ secrets: [] }));
    await refused(() => comment(), /has no token/);
  });

  test("a repository that isn't registered, or isn't Blob's", async () => {
    await refused(
      () => comment("Hi", ADA_POSTS, "someone/else"),
      /not one of Blob's repositories/,
    );
    await refused(
      () => comment("Hi", ADA_POSTS, "acme/other"),
      /not one of Blob's repositories/,
    );
  });

  test("a public repository not listed, and unknown visibility", async () => {
    await refused(
      () => comment("Hi", ADA_POSTS, "acme/site"),
      /public and not on Blob's list/,
    );
    visibility["acme/widget"] = null;
    await refused(() => comment(), /Couldn't confirm acme\/widget is private/);
  });

  test("an owner without a GitHub login", async () => {
    await refused(
      () => comment("Hi", { owner: "Nell" }),
      /no GitHub login on the team roster/,
    );
  });

  test("trigger commands, trigger labels and hidden markers in the text", async () => {
    await refused(() => comment("Please /os-auto-fix this"), /\/os command/);
    await refused(() => comment("/os review"), /\/os command/);
    await refused(() => comment("Add os-auto-fix to it."), /os-auto-fix label/);
    await refused(
      () => comment("<!-- os-review -->"),
      /os-review label|HTML comment/,
    );
    await refused(() => comment("hi <!-- x -->"), /HTML comment/);
    await refused(
      () =>
        blobReview(ADA_POSTS, {
          repo: "acme/widget",
          pr: 4,
          body: "fine",
          comments: [{ path: "a", line: 1, body: "/os-simplify" }],
        }),
      /\/os command/,
    );
    await refused(
      () =>
        blobOpenIssue(ADA_POSTS, {
          repo: "acme/widget",
          title: "os-adversarial please",
          body: "x",
        }),
      /os-adversarial label/,
    );
    // Ordinary text passes: paths, config files, the word OS.
    expect(
      blobTextRefusal(
        "See ~/os/bin, src/os/a.ts and .os-review.json on macOS.",
      ),
    ).toBeNull();
  });

  test("trigger labels are never added or removed", async () => {
    await refused(
      () =>
        blobLabel(ADA_POSTS, {
          repo: "acme/widget",
          number: 1,
          add: ["os-auto-fix"],
          remove: [],
        }),
      /starts an agent loop/,
    );
    await refused(
      () =>
        blobLabel(ADA_POSTS, {
          repo: "acme/widget",
          number: 1,
          add: [],
          remove: ["os"],
        }),
      /starts an agent loop/,
    );
  });

  test("a lead: its own project's repositories, private ones only", async () => {
    const lead: BlobPoster = {
      owner: "Ada",
      sessionId: "os-lead",
      lead: { project: "widget", repos: ["acme/widget"] },
    };
    await refused(
      () =>
        comment(
          "Hi",
          { ...lead, lead: { project: "widget", repos: ["acme/widget"] } },
          "acme/docs",
        ),
      /not one of widget's repositories/,
    );
    await refused(
      () =>
        comment(
          "Hi",
          { ...lead, lead: { project: "docs", repos: ["acme/docs"] } },
          "acme/docs",
        ),
      /private repositories only/,
    );
    const ok = await comment("Hi", lead);
    expect(ok.ok).toBe(true);
    expect(calls[0]!.body.body).toContain(
      "[session](https://sessions.example.test/session/os-lead)",
    );
  });
});

describe("a lead's recorded steps", () => {
  async function refused(
    run: () => Promise<{ ok: boolean; message?: string }>,
    pattern: RegExp,
  ) {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
  }
  const step = (project: string, repos: string[], extra = {}): BlobPoster => ({
    owner: "Ada",
    lead: { project, repos, recordedStep: true },
    ...extra,
  });

  test("may post on a listed public repository of its project, with every text guard", async () => {
    const ok = await comment(
      "Thanks for this!",
      step("docs", ["acme/docs"]),
      "acme/docs",
    );
    expect(ok.ok).toBe(true);
    expect(calls[0]!.body.body).toBe(
      "Thanks for this!\n\n<sub>Blob, for @ada</sub><!-- os:blob -->",
    );
    await refused(
      () => comment("/deploy now", step("docs", ["acme/docs"]), "acme/docs"),
      /slash command/,
    );
  });

  test("never on an unlisted public repository, another project's, or for a private-only owner", async () => {
    await refused(
      () => comment("Hi", step("site", ["acme/site"]), "acme/site"),
      /not on Blob's list of public repositories/,
    );
    await refused(
      () => comment("Hi", step("widget", ["acme/widget"]), "acme/docs"),
      /not one of widget's repositories/,
    );
    await refused(
      () =>
        comment(
          "Hi",
          step("docs", ["acme/docs"], { privateOnly: true }),
          "acme/docs",
        ),
      /only for the instance owner/,
    );
    expect(calls).toEqual([]);
  });
});

describe("closing", () => {
  test("closes an issue with its reason, after checking it is one", async () => {
    answer = (call) =>
      call.method === "GET"
        ? Response.json({ number: 12, state: "open" })
        : Response.json({
            html_url: "https://github.com/acme/widget/issues/12",
          });
    const result = await blobClose(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      pullRequest: false,
      reason: "not_planned",
    });
    expect(result.ok).toBe(true);
    expect(
      calls.map((c) => [c.method, c.url.replace("https://api.github.com", "")]),
    ).toEqual([
      ["GET", "/repos/acme/widget/issues/12"],
      ["PATCH", "/repos/acme/widget/issues/12"],
    ]);
    expect(calls[1]!.body).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
    expect(audits.at(-1)).toMatchObject({ action: "close", number: 12 });
  });

  test("closes a pull request through the pulls endpoint", async () => {
    answer = (call) =>
      call.method === "GET"
        ? Response.json({ number: 12, state: "open", pull_request: {} })
        : Response.json({ html_url: "https://github.com/acme/widget/pull/12" });
    const result = await blobClose(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      pullRequest: true,
    });
    expect(result.ok).toBe(true);
    expect(calls[1]!.url).toBe(
      "https://api.github.com/repos/acme/widget/pulls/12",
    );
    expect(calls[1]!.body).toEqual({ state: "closed" });
  });

  test("an issue that is a pull request is refused; one already closed is done", async () => {
    answer = () =>
      Response.json({ number: 12, state: "open", pull_request: {} });
    const wrong = await blobClose(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      pullRequest: false,
    });
    expect(wrong).toEqual({
      ok: false,
      message: "#12 in acme/widget is a pull request, not an issue.",
    });
    calls = [];
    answer = () => Response.json({ number: 12, state: "closed" });
    const done = await blobClose(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      pullRequest: false,
    });
    expect(done.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("limits", () => {
  test(`${BLOB_WRITES_PER_THREAD_HOUR} writes an hour on one thread`, async () => {
    for (let i = 0; i < BLOB_WRITES_PER_THREAD_HOUR; i++)
      expect((await comment()).ok).toBe(true);
    const capped = await comment();
    expect(capped).toEqual({
      ok: false,
      message: `Blob already wrote ${BLOB_WRITES_PER_THREAD_HOUR} times on acme/widget#12 this hour. Try again later.`,
    });
    // Another thread is fine, and the hour passes.
    expect(
      (
        await blobComment(ADA_POSTS, {
          repo: "acme/widget",
          number: 13,
          body: "x",
        })
      ).ok,
    ).toBe(true);
    now += 60 * 60_000;
    expect((await comment()).ok).toBe(true);
  });

  test(`${BLOB_WRITES_PER_HOUR} writes an hour per owner; refused calls don't count`, async () => {
    answer = () =>
      Response.json({ message: "Validation Failed" }, { status: 422 });
    expect((await comment()).message).toContain("422");
    answer = () => Response.json({}, { status: 201 });
    for (let i = 0; i < BLOB_WRITES_PER_HOUR; i++)
      expect(
        (
          await blobComment(ADA_POSTS, {
            repo: "acme/widget",
            number: 100 + i,
            body: "x",
          })
        ).ok,
      ).toBe(true);
    const capped = await blobComment(ADA_POSTS, {
      repo: "acme/widget",
      number: 1,
      body: "x",
    });
    expect(capped.ok).toBe(false);
    expect(capped.message).toContain(
      `${BLOB_WRITES_PER_HOUR} times on GitHub for you this hour`,
    );
  });
});

describe("token trouble", () => {
  test("a 401 turns posting off and raises one needs-you item", async () => {
    answer = () =>
      Response.json({ message: "Bad credentials" }, { status: 401 });
    const first = await comment();
    expect(first).toEqual({
      ok: false,
      message:
        "GitHub refused Blob's token, so posting is off now. The owner has been asked for a new one.",
    });
    expect(blobConfig().enabled).toBe(false);
    expect(await comment()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/is off/),
    });
    const items = await listSupervisorItems("Ada", { state: "open" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "needs-you",
      source: "blob-github",
      title: "GitHub refused Blob's token",
      urgency: "now",
    });
    // Turned on again, the same token refused again: still one item.
    await setup();
    await comment();
    expect(await listSupervisorItems("Ada", { state: "open" })).toHaveLength(1);
  });

  test("expiry within 14 days raises one needs-you item from the inbox sweep", async () => {
    restores.push(
      __setSupervisorInboxDepsForTest({
        now: () => now,
        notify: async () => null,
        markDone: async () => {},
        supervisorSessionId: async (user) => `os-sup-${user.toLowerCase()}`,
        rotateSupervisor: async () => null,
        ensureWatch: async () => null,
        timeZone: () => "UTC",
      }),
    );
    expect(await checkBlobGithubExpiry()).toBe(false);
    expect(await listSupervisorItems("Ada", { state: "open" })).toEqual([]);
    now = Date.parse("2027-01-30T00:00:00Z");
    await sweepSupervisorInbox();
    await sweepSupervisorInbox();
    const items = await listSupervisorItems("Ada", { state: "open" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "needs-you",
      title: "Blob's GitHub token expires soon",
    });
    expect(items[0]!.body).toContain("2027-02-09");
  });

  test("the token never appears in results, audits or logs", async () => {
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      const results: unknown[] = [];
      answer = () => {
        throw new Error(`connect failed with Authorization: Bearer ${TOKEN}`);
      };
      results.push(await comment());
      answer = () =>
        Response.json({ message: `bad ${TOKEN}` }, { status: 500 });
      results.push(await comment());
      answer = () =>
        Response.json({ message: `bad ${TOKEN}` }, { status: 401 });
      results.push(await comment());
      const seen = JSON.stringify({ results, audits, logged });
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain("secretvalue");
      expect(results[0]).toMatchObject({
        ok: false,
        message: expect.stringMatching(/Couldn't reach GitHub/),
      });
      expect(results[1]).toEqual({
        ok: false,
        message: "GitHub answered 500.",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("review findings", () => {
  async function refused(
    run: () => Promise<{ ok: boolean; message?: string }>,
    pattern: RegExp,
  ) {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
    expect(calls).toEqual([]);
  }

  test("only teammates are mentioned, and no line starts with a slash command", async () => {
    await refused(() => comment("@dependabot rebase"), /@dependabot/);
    await refused(() => comment("Ask @claude to look"), /@claude/);
    await refused(() => comment("Hi @Blob"), /@Blob/);
    await refused(() => comment("cc @acme/core"), /team @acme\/core/);
    await refused(() => comment("cc @ada/core"), /team @ada\/core/);
    await refused(() => comment("/deploy now"), /slash command/);
    await refused(() => comment("Done.\n  /lgtm"), /slash command/);
    await refused(
      () =>
        blobReview(ADA_POSTS, {
          repo: "acme/widget",
          pr: 4,
          body: "fine",
          comments: [{ path: "a", line: 1, body: "@renovate rebase" }],
        }),
      /@renovate/,
    );
    expect(
      blobTextRefusal("Thanks @ada and @BOB, mail ada@example.test."),
    ).toBeNull();
    expect(
      blobTextRefusal("Run it from a/b and see /tmp in the log."),
    ).toBeNull();
    expect((await comment("@ada and @Bob, this is ready.")).ok).toBe(true);
  });

  test("a mention hidden by emphasis, code or an entity is still caught", () => {
    const team = ["ada"];
    const mentions = (text: string) =>
      expect(blobTextRefusal(text, team)).toMatch(/@dependabot/);
    mentions("Please _@dependabot_ rebase");
    mentions("Please *@dependabot* rebase");
    mentions("Please @*dependabot* rebase");
    mentions("Please @_dependabot_ rebase");
    mentions("Please ~~@dependabot~~ rebase");
    mentions("Run `x`@dependabot rebase");
    mentions("Please &#64;dependabot rebase");
    mentions("Please &#064;dependabot rebase");
    mentions("Please &#x40;dependabot rebase");
    mentions("Please &#X40;dependabot rebase");
    mentions("Please &commat;dependabot rebase");
    mentions("Please &Commat;dependabot rebase");
    mentions("Please _&#64;dependabot_ rebase");
    expect(blobTextRefusal("cc &#64;acme/core", team)).toMatch(
      /team @acme\/core/,
    );
    expect(
      blobTextRefusal(
        "Mail ada@example.test, first_last@example.test or a&#64;example.test; _@ada_ and &#64;ada are fine.",
        team,
      ),
    ).toBeNull();
  });

  test("a public repository never gets private terms or internal hosts", async () => {
    await setup(
      {},
      {
        policy: { privateTerms: ["globex"] },
        server: { publicBaseUrl: "https://sessions.example.test" },
      },
    );
    const onDocs = (body: string) => comment(body, ADA_POSTS, "acme/docs");
    await refused(
      () => onDocs("Globex asked for this"),
      /private term "globex"/,
    );
    await refused(
      () => onDocs("See https://sessions.example.test/s/1"),
      /instance's host sessions\.example\.test/,
    );
    await refused(() => onDocs("Logs on db1.internal"), /internal host/);
    await refused(() => onDocs("It answers on 10.0.3.7"), /internal host/);
    await refused(
      () =>
        blobOpenIssue(ADA_POSTS, {
          repo: "acme/docs",
          title: "Globex bug",
          body: "x",
        }),
      /private term/,
    );
    await refused(
      () =>
        blobReview(ADA_POSTS, {
          repo: "acme/docs",
          pr: 4,
          body: "fine",
          comments: [{ path: "a", line: 1, body: "as globex wants" }],
        }),
      /private term/,
    );
    // A private repository may carry them.
    expect((await comment("Globex asked, see db1.internal")).ok).toBe(true);
  });

  test("labels: only the owner's allowlist, off when empty", async () => {
    answer = (call) =>
      call.method === "GET"
        ? Response.json({ name: "x" }, { status: 200 })
        : Response.json([], { status: 200 });
    const label = (add: string[], remove: string[] = []) =>
      blobLabel(ADA_POSTS, { repo: "acme/widget", number: 12, add, remove });
    await refused(() => label(["wontfix"]), /not on the owner's list/);
    await refused(() => label([], ["wontfix"]), /not on the owner's list/);
    expect((await label(["Bug"])).ok).toBe(true);
    await setup({ labels: [] });
    calls = [];
    await refused(() => label(["bug"]), /Labelling is off/);
    // A trigger label slipped onto the list by hand is still refused.
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    raw.integrations.github.blob.labels = ["os-auto-fix"];
    writeFileSync(configPath, JSON.stringify(raw));
    await getConfigAsync();
    await refused(() => label(["os-auto-fix"]), /starts an agent loop/);
  });

  test("the allowlist is validated", () => {
    expect(validateBlobGithubPatch({ labels: ["bug", " triage "] })).toEqual({
      labels: ["bug", "triage"],
    });
    for (const labels of [[1], [""], "bug", ["x".repeat(101)], ["os-review"]])
      expect(validateBlobGithubPatch({ labels })).toHaveProperty("error");
  });

  test("a label change that partly went through still counts", async () => {
    answer = (call) =>
      call.method === "DELETE"
        ? Response.json({}, { status: 500 })
        : Response.json({ name: "bug" }, { status: 200 });
    const partial = await blobLabel(ADA_POSTS, {
      repo: "acme/widget",
      number: 12,
      add: ["bug"],
      remove: ["triage"],
    });
    expect(partial.ok).toBe(false);
    answer = () => Response.json({}, { status: 201 });
    for (let i = 1; i < BLOB_WRITES_PER_THREAD_HOUR; i++)
      expect((await comment()).ok).toBe(true);
    expect((await comment()).ok).toBe(false);
  });

  test("a teammate's supervisor posts on private repositories only", async () => {
    expect(await blobSupervisorPoster("Ada", "os-sup-ada")).toEqual({
      owner: "Ada",
      sessionId: "os-sup-ada",
    });
    const bob = await blobSupervisorPoster("Bob");
    expect(bob).toEqual({ owner: "Bob", privateOnly: true });
    await refused(
      () => comment("Hi", bob, "acme/docs"),
      /only for the instance owner/,
    );
    expect((await comment("Hi", bob)).ok).toBe(true);
    expect((await comment("Hi", ADA_POSTS, "acme/docs")).ok).toBe(true);
  });

  test(`${BLOB_WRITES_PER_INSTANCE_HOUR} writes an hour across owners; reviews count their inline comments`, async () => {
    answer = () => Response.json({}, { status: 201 });
    const many = async (owner: string, count: number) => {
      for (let i = 0; i < count; i++)
        expect(
          (
            await blobComment(
              { owner },
              { repo: "acme/widget", number: 100 + i, body: "x" },
            )
          ).ok,
        ).toBe(true);
    };
    // A review with 10 inline comments counts as 3 writes.
    const review = await blobReview(ADA_POSTS, {
      repo: "acme/widget",
      pr: 4,
      body: "fine",
      comments: Array.from({ length: 10 }, (_, i) => ({
        path: "a",
        line: i + 1,
        body: "note",
      })),
    });
    expect(review.ok).toBe(true);
    await many("Ada", 27);
    expect(
      (
        await blobComment(ADA_POSTS, {
          repo: "acme/widget",
          number: 1,
          body: "x",
        })
      ).message,
    ).toContain("for you this hour");
    await many("Bob", 30);
    const capped = await blobComment(
      { owner: "Cat" },
      { repo: "acme/widget", number: 1, body: "x" },
    );
    expect(capped).toEqual({
      ok: false,
      message: `Blob already wrote ${BLOB_WRITES_PER_INSTANCE_HOUR} times on GitHub for the team this hour. Try again later.`,
    });
  });
});

describe("posting as the owner's account", () => {
  async function refused(
    run: () => Promise<{ ok: boolean; message?: string }>,
    pattern: RegExp,
  ) {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  }

  beforeEach(async () => {
    await setup({ as: "owner" }, { policy: { privateTerms: ["globex"] } });
  });

  test("every post is signed as Blob, the owner's assistant, with the marker", async () => {
    expect(blobConfig()).toMatchObject({ as: "owner", login: "ada" });
    expect((await comment("Thanks!", ADA_POSTS, "acme/docs")).ok).toBe(true);
    expect(calls[0]!.body.body).toBe(
      "Thanks!\n\n<sub>Written by Blob, Ada's assistant</sub><!-- os:blob -->",
    );
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    // A private repository links the session, as with Blob's own account.
    expect((await comment()).ok).toBe(true);
    expect(calls[1]!.body.body).toBe(
      "Looks good to me.\n\n<sub>Written by Blob, Ada's assistant · [session](https://sessions.example.test/session/os-sup-ada)</sub><!-- os:blob -->",
    );
    const review = await blobReview(ADA_POSTS, {
      repo: "acme/docs",
      pr: 4,
      body: "Two notes.",
      comments: [{ path: "src/a.ts", line: 3, body: "Null here?" }],
    });
    expect(review.ok).toBe(true);
    expect(calls[2]!.body.event).toBe("COMMENT");
    expect(calls[2]!.body.comments[0].body).toEndWith(
      "<sub>Written by Blob, Ada's assistant</sub><!-- os:blob -->",
    );
    expect(audits[0]).toMatchObject({ user: "Ada", actor: "Blob" });
  });

  test("only for the owner: never a teammate's supervisor or another owner", async () => {
    const bob = await blobSupervisorPoster("Bob");
    await refused(() => comment("Hi", bob), /posts only for the owner/);
    await refused(
      () => comment("Hi", { owner: "Bob", sessionId: "os-sup-bob" }),
      /posts only for the owner/,
    );
    expect(calls).toEqual([]);
  });

  test("refused once the roster names someone else as the owner", async () => {
    restores.push(
      __setBlobGithubDepsForTest({
        now: () => now,
        fetch: async () => {
          throw new Error("must not reach GitHub");
        },
        repoIsPrivate: async (repo) => visibility[repo] ?? null,
        instanceOwner: async () => ({ name: "Bob Example", github: "bob" }),
      }),
    );
    await refused(() => comment(), /no longer the owner's login/);
  });

  test("the public-repository guards stay: listed repositories, private terms, mentions", async () => {
    await refused(
      () => comment("Hi", ADA_POSTS, "acme/site"),
      /not on Blob's list of public repositories/,
    );
    await refused(
      () => comment("Globex asked for this", ADA_POSTS, "acme/docs"),
      /private term "globex"/,
    );
    await refused(
      () => comment("cc @dependabot", ADA_POSTS, "acme/docs"),
      /isn't a teammate/,
    );
    await refused(
      () => comment("/deploy now", ADA_POSTS, "acme/docs"),
      /slash command/,
    );
    await refused(
      () => comment("Hi", ADA_POSTS, "acme/other"),
      /not one of Blob's repositories/,
    );
    expect(calls).toEqual([]);
  });

  test("nothing closes, approves, edits or merges", () => {
    const repo = "/repos/acme/docs";
    expect(
      blobRequestRefusal("PATCH", `${repo}/issues/4`, { state: "closed" }),
    ).toMatch(/never closes, approves/);
    expect(
      blobRequestRefusal("PATCH", `${repo}/pulls/4`, { state: "closed" }),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/pulls/4/reviews`, {
        event: "APPROVE",
      }),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/pulls/4/reviews`, {
        event: "REQUEST_CHANGES",
      }),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/pulls/4/reviews`, {}),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("PUT", `${repo}/pulls/4/merge`, {}),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("PATCH", `${repo}/issues/comments/9`, { body: "x" }),
    ).not.toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/issues`, {
        title: "x",
        body: "y",
        state: "closed",
      }),
    ).not.toBeNull();
    // What Blob does post.
    expect(
      blobRequestRefusal("POST", `${repo}/issues/4/comments`, { body: "x" }),
    ).toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/pulls/4/reviews`, {
        event: "COMMENT",
      }),
    ).toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/issues`, { title: "x", body: "y" }),
    ).toBeNull();
    expect(blobRequestRefusal("GET", `${repo}/labels/bug`)).toBeNull();
    expect(
      blobRequestRefusal("POST", `${repo}/issues/4/labels`, {
        labels: ["bug"],
      }),
    ).toBeNull();
    expect(
      blobRequestRefusal("DELETE", `${repo}/issues/4/labels/bug`),
    ).toBeNull();
  });
});
