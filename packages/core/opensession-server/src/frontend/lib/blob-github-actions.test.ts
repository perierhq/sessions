// The GitHub account section's handlers against a fake server: the token
// field empties after a save, Remove token asks first and then sends the
// DELETE, and each toggle sends the PUT body the route expects.
import { afterEach, describe, expect, test } from "bun:test";
import type { ConfirmRequest } from "../ui/confirm";
import type { BlobGithub } from "./blob-github";
import { blobGithubActions } from "./blob-github-actions";

const settings: BlobGithub = {
  login: "acme-blob",
  expiresAt: "2027-02-09T12:00:00.000Z",
  repos: ["acme/widget", "acme/docs"],
  publicRepos: ["acme/docs"],
  enabled: true,
  tokenSet: true,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A server that answers every request with `answer`, and the calls it got. */
function fakeServer(answer: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return calls;
}

interface HarnessState {
  saved: BlobGithub | null;
  token: string;
  tokenError: string | null;
  error: string | null;
  confirms: ConfirmRequest[];
}

function harness(token = "") {
  const state: HarnessState = {
    saved: null,
    token,
    tokenError: null,
    error: null,
    confirms: [],
  };
  const act = blobGithubActions({
    settings,
    token,
    setSaved: (next) => (state.saved = next),
    setToken: (value) => (state.token = value),
    setTokenError: (message) => (state.tokenError = message),
    setError: (message) => (state.error = message),
    setBusy: () => {},
    confirm: (request) => state.confirms.push(request),
  });
  return { act, state };
}

describe("blobGithubActions", () => {
  test("a saved token empties the field; a refused one stays", async () => {
    const calls = fakeServer({ status: 200, body: { blob: settings } });
    const ok = harness("  github_pat_abc  ");
    await ok.act.saveToken();
    expect(calls).toEqual([
      {
        method: "PUT",
        url: "/api/blob/github",
        body: { token: "github_pat_abc" },
      },
    ]);
    expect(ok.state.token).toBe("");
    expect(ok.state.saved).toEqual(settings);

    fakeServer({ status: 400, body: { error: "token: not a GitHub token" } });
    const refused = harness("nope");
    await refused.act.saveToken();
    expect(refused.state.token).toBe("nope");
    expect(refused.state.tokenError).toBe(
      "That isn't a GitHub token. Copy it again, whole.",
    );
  });

  test("an empty token is not sent", async () => {
    const calls = fakeServer({ status: 200, body: { blob: settings } });
    const { act, state } = harness("   ");
    await act.saveToken();
    expect(calls).toEqual([]);
    expect(state.tokenError).toBe("Paste a token.");
  });

  test("Remove token asks first, then sends the DELETE", async () => {
    const removed = { ...settings, tokenSet: false, enabled: false };
    const calls = fakeServer({ status: 200, body: { blob: removed } });
    const { act, state } = harness();
    act.removeToken();
    expect(calls).toEqual([]);
    expect(state.confirms).toHaveLength(1);
    const [request] = state.confirms;
    expect(request!.destructive).toBe(true);
    expect(request!.confirmLabel).toBe("Remove");
    request!.onConfirm();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls).toEqual([
      { method: "DELETE", url: "/api/blob/github/token", body: undefined },
    ]);
    expect(state.saved).toEqual(removed);
  });

  test("each toggle sends its PUT body", async () => {
    const calls = fakeServer({ status: 200, body: { blob: settings } });
    const { act } = harness();
    await act.setRepo("acme/docs", false);
    await act.setRepo("acme/site", true);
    await act.setPublicRepo("acme/widget", true);
    await act.setEnabled(false);
    await act.setLabels(["bug", "needs-info"]);
    expect(calls.map((c) => [c.method, c.url])).toEqual(
      Array(5).fill(["PUT", "/api/blob/github"]),
    );
    expect(calls.map((c) => c.body)).toEqual([
      { repos: ["acme/widget"], publicRepos: [] },
      {
        repos: ["acme/widget", "acme/docs", "acme/site"],
        publicRepos: ["acme/docs"],
      },
      { publicRepos: ["acme/docs", "acme/widget"] },
      { enabled: false },
      { labels: ["bug", "needs-info"] },
    ]);
  });

  test("an unexpected answer is said plainly", async () => {
    fakeServer({ status: 200, body: { ok: true } });
    const { act, state } = harness();
    await act.setEnabled(false);
    expect(state.error).toBe("The server sent an unexpected answer.");
    expect(state.saved).toBeNull();
  });
});
