import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Tokens without a GitHub App: both modules are only imported lazily.
mock.module("./github-app", () => ({
  githubAppRepositoryToken: async () => "app-token",
  githubToken: async () => "bot-token",
}));
mock.module("./github-limit", () => ({
  botGhToken: async () => "bot-token",
}));

const { createRepoIssue, repoIsPublic, stripEmailAddresses } =
  await import("./github-issues");

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let answer: (url: string) => Response;

beforeEach(() => {
  calls = [];
  answer = () => new Response("{}", { status: 500 });
  globalThis.fetch = (async (input: string | URL | Request, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return answer(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("repoIsPublic", () => {
  test("a repository GitHub reports as not private is public", async () => {
    answer = () => Response.json({ private: false });
    expect(await repoIsPublic("acme/app")).toBe(true);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/app");
  });

  test("a private repository is not public", async () => {
    answer = () => Response.json({ private: true });
    expect(await repoIsPublic("acme/secret")).toBe(false);
  });

  test("a repository GitHub can't show is unknown", async () => {
    answer = () => new Response("Not Found", { status: 404 });
    expect(await repoIsPublic("acme/missing")).toBeNull();
  });

  test("a name that is not owner/name is unknown", async () => {
    expect(await repoIsPublic("")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("createRepoIssue", () => {
  test("posts to the repository's issues and returns number and URL", async () => {
    answer = () =>
      Response.json(
        { number: 42, html_url: "https://github.com/acme/app/issues/42" },
        { status: 201 },
      );
    const issue = await createRepoIssue("acme/app", {
      title: "Export fails",
      body: "Steps",
      labels: ["bug"],
    });
    expect(issue).toEqual({
      number: 42,
      url: "https://github.com/acme/app/issues/42",
      repo: "acme/app",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/app/issues");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: "Export fails",
      body: "Steps",
      labels: ["bug"],
    });
    expect(
      (calls[0]?.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer app-token");
  });

  test("a refused request is null", async () => {
    answer = () => new Response("Forbidden", { status: 403 });
    expect(
      await createRepoIssue("acme/app", { title: "T", body: "B" }),
    ).toBeNull();
  });

  test("no repository is null without a request", async () => {
    expect(await createRepoIssue("", { title: "T", body: "B" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("stripEmailAddresses", () => {
  test("replaces every address", () => {
    expect(stripEmailAddresses("write to ada@example.test now")).toBe(
      "write to [email removed] now",
    );
    expect(
      stripEmailAddresses("<Bo.B+x@Mail.Example.test>, carol@example.test."),
    ).toBe("<[email removed]>, [email removed].");
  });

  test("leaves text without an address alone", () => {
    expect(stripEmailAddresses("@mention and a@ b")).toBe("@mention and a@ b");
  });
});
