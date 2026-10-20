import { beforeEach, expect, test } from "bun:test";
import type { FetchTarget, PinnedRequestInit } from "../../shared/pinned-fetch";
import type { RunnerExecResult } from "../../runner-ws";
import {
  RUNNER_BODY_CAP_BYTES,
  type RunnerFetchDeps,
  runnerCheckBlocked,
  runnerNet,
  shellQuote,
} from "./runner-fetch";

const calls: string[] = [];
const execOpts: Array<{ timeoutMs: number }> = [];
const out = (stdout: string, code = 0): RunnerExecResult => ({
  code,
  stdout,
  stderr: code ? "curl: (7) Failed to connect" : "",
});
const deps = (
  result: RunnerExecResult,
  over: Partial<RunnerFetchDeps> = {},
): Partial<RunnerFetchDeps> => ({
  exec: async (_id, command, opts) => {
    calls.push(command);
    execOpts.push(opts);
    return result;
  },
  runner: () => ({ name: "prod-1", platform: "linux" }),
  connected: () => true,
  ...over,
});
const target = (raw: string): FetchTarget => {
  const url = new URL(raw);
  return { url, host: url.hostname, addresses: [url.hostname] };
};
const init = (over: Partial<PinnedRequestInit> = {}): PinnedRequestInit => ({
  method: "GET",
  headers: {},
  signal: AbortSignal.timeout(10_000),
  maxBodyBytes: 1_048_576,
  ...over,
});
beforeEach(() => {
  calls.length = 0;
  execOpts.length = 0;
});

test("one request per hop, quoted, never following redirects", async () => {
  const net = runnerNet(
    "runner-prod",
    deps(
      out(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"status":"ok"}\n__SESSIONS_CURL__200',
      ),
    ),
  );
  const res = await net.send(
    target("https://acme.example.test/q?a=1"),
    init({ headers: { "User-Agent": "acme-app/4.2", "X-Q": "it's" } }),
    net.isBlocked,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({
    status: "ok",
  });
  expect(calls[0]).toStartWith(
    "curl --silent --show-error --include --proto =http,https --max-redirs 0 --max-time ",
  );
  expect(calls[0]).toContain("--max-redirs 0");
  expect(calls[0]).toContain("--max-filesize 150000");
  expect(calls[0]).toContain("--request 'GET'");
  expect(calls[0]).toContain(`--header 'X-Q: it'\\''s'`);
  expect(calls[0]).toEndWith(`-- 'https://acme.example.test/q?a=1'`);
  expect(execOpts[0].timeoutMs).toBeGreaterThan(5_000);
  expect(await net.resolve("acme.example.test")).toEqual(["acme.example.test"]);
});
test("a POST body is sent as is", async () => {
  const net = runnerNet(
    "runner-prod",
    deps(out("HTTP/1.1 204 No Content\r\n\r\n\n__SESSIONS_CURL__204")),
  );
  const res = await net.send(
    target("https://acme.example.test/q"),
    init({ method: "POST", body: '{"q":"x"}' }),
    net.isBlocked,
  );
  expect(res.status).toBe(204);
  expect(calls[0]).toContain(`--data-binary '{"q":"x"}'`);
});
test("redirects come back unfollowed; bodies are cut to the caller's cap", async () => {
  const net = runnerNet(
    "runner-prod",
    deps(
      out(
        "HTTP/1.1 302 Found\r\nLocation: https://acme.example.test/b\r\n\r\n\n__SESSIONS_CURL__302",
      ),
    ),
  );
  const res = await net.send(
    target("https://acme.example.test/a"),
    init(),
    net.isBlocked,
  );
  expect([res.status, res.headers.get("location")]).toEqual([
    302,
    "https://acme.example.test/b",
  ]);
  const big = runnerNet(
    "runner-prod",
    deps(
      out(`HTTP/1.1 200 OK\r\n\r\n${"x".repeat(20_000)}\n__SESSIONS_CURL__200`),
    ),
  );
  const cut = await big.send(
    target("https://acme.example.test/"),
    init({ maxBodyBytes: 16_384 }),
    big.isBlocked,
  );
  expect(cut).toMatchObject({ truncated: true });
  expect(cut.body.length).toBe(16_384);
  expect(RUNNER_BODY_CAP_BYTES).toBe(150_000);
});
test("errors map to timeouts, size, offline, platform", async () => {
  const send = (r: RunnerExecResult, over: Partial<RunnerFetchDeps> = {}) => {
    const n = runnerNet("r", deps(r, over));
    return n.send(target("https://acme.example.test"), init(), n.isBlocked);
  };
  await expect(send(out("", 28))).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await expect(
    send({ code: -1, stdout: "", stderr: "", timedOut: true }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await expect(send(out("", 63))).rejects.toMatchObject({
    code: "BODY_TOO_LARGE",
    limitKb: 150,
  });
  await expect(send(out("", 7))).rejects.toThrow("curl: (7) Failed to connect");
  await expect(send({ code: 6, stdout: "", stderr: "" })).rejects.toThrow(
    "curl exited 6",
  );
  await expect(send(out(""), { connected: () => false })).rejects.toMatchObject(
    { code: "RUNNER_OFFLINE", runnerName: "prod-1" },
  );
  await expect(
    send(out(""), { runner: () => undefined }),
  ).rejects.toMatchObject({ code: "RUNNER_OFFLINE", runnerName: "r" });
  await expect(
    send(out(""), { runner: () => ({ name: "win", platform: "win32" }) }),
  ).rejects.toThrow("Runner-targeted checks need a macOS or Linux Runner");
  expect(calls).toHaveLength(5);
});
test("the Runner guard allows the host itself, refuses metadata", () => {
  expect(runnerCheckBlocked("127.0.0.1")).toBe(false);
  expect(runnerCheckBlocked("10.0.0.5")).toBe(false);
  expect(runnerCheckBlocked("acme.example.test")).toBe(false);
  expect(runnerCheckBlocked("169.254.169.254")).toBe(true);
  expect(runnerCheckBlocked("fd00:ec2::254")).toBe(true);
  expect(runnerCheckBlocked("100.100.100.200")).toBe(true);
  expect(runnerCheckBlocked("Metadata.Google.Internal.")).toBe(true);
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});
