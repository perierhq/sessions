import { beforeEach, expect, test } from "bun:test";
import type { FetchTarget, PinnedRequestInit } from "../../shared/pinned-fetch";
import { RunnerUnavailableError, type RunnerExecResult } from "../../runner-ws";
import { runHttpSource } from "./http";
import {
  RUNNER_BODY_CAP_BYTES,
  type RunnerFetchDeps,
  __resetCurlVersionsForTest,
  runnerCheckBlocked,
  runnerNet,
  shellQuote,
} from "./runner-fetch";

interface Call {
  command: string;
  stdin: string;
  auditCommand: string;
  timeoutMs: number;
}
const calls: Call[] = [];
/** What `curl --version` answers on the Runner; asked once per Runner. */
let curlVersion: RunnerExecResult;
let versionChecks = 0;
const CURL_VERSION = "command curl --version";
const MARK = "\n__SESSIONS_CURL__";
/** curl's answer: the response on stdout, the status marker on stderr. */
const out = (
  stdout: string,
  status: number | null,
  code = 0,
  stderr = "",
): RunnerExecResult => ({
  code,
  stdout,
  stderr: `${stderr}${status === null ? "" : `${MARK}${status}\n`}`,
});
const deps = (
  result: RunnerExecResult | ((call: Call) => RunnerExecResult),
  over: Partial<RunnerFetchDeps> = {},
): Partial<RunnerFetchDeps> => ({
  exec: async (_id, command, opts) => {
    if (command === CURL_VERSION) {
      versionChecks++;
      return curlVersion;
    }
    const call = { command, ...opts };
    calls.push(call);
    return typeof result === "function" ? result(call) : result;
  },
  runner: () => ({ name: "prod-1", platform: "linux" }),
  connected: () => true,
  gate: async () => null,
  ...over,
});
const opts = { repo: "acme", signalId: "sig-1", host: "acme.example.test" };
const target = (raw: string, addresses?: string[]): FetchTarget => {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return { url, host, addresses: addresses ?? [host] };
};
const init = (over: Partial<PinnedRequestInit> = {}): PinnedRequestInit => ({
  method: "GET",
  headers: {},
  signal: AbortSignal.timeout(10_000),
  maxBodyBytes: 1_048_576,
  ...over,
});
const send = (
  result: Parameters<typeof deps>[0],
  raw = "https://acme.example.test/q",
  i: Partial<PinnedRequestInit> = {},
  over: Partial<RunnerFetchDeps> = {},
  addresses?: string[],
) => {
  const net = runnerNet("runner-prod", deps(result, over), opts);
  return net.send(target(raw, addresses), init(i), net.isBlocked);
};
beforeEach(() => {
  calls.length = 0;
  versionChecks = 0;
  curlVersion = {
    code: 0,
    stdout: "curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13\n",
    stderr: "",
  };
  __resetCurlVersionsForTest();
});

test("every option goes to curl on stdin; argv carries nothing of the request", async () => {
  const res = await send(
    out(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"status":"ok"}',
      200,
    ),
    "https://acme.example.test/q?a=1",
    {
      headers: {
        Authorization: "Bearer s3cret",
        "X-Q": 'it\'s "quoted" \\ here',
        "Accept-Encoding": "gzip, br",
      },
    },
    {},
    ["203.0.113.7", "2001:db8::7"],
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({
    status: "ok",
  });
  const { command, stdin, auditCommand, timeoutMs } = calls[0]!;
  expect(command).toStartWith("command curl --disable --config - ");
  expect(command).not.toContain("acme.example.test");
  expect(command).not.toContain("s3cret");
  expect(auditCommand).toBe("incident http check sig-1");
  expect(timeoutMs).toBeGreaterThan(5_000);
  const lines = stdin.split("\n");
  for (const line of [
    "globoff",
    "silent",
    "show-error",
    "include",
    "suppress-connect-headers",
    "compressed",
    'proto = "=http,https"',
    'proto-redir = "=http,https"',
    "max-redirs = 0",
    'noproxy = "*"',
    'request = "GET"',
    'url = "https://acme.example.test/q?a=1"',
    'header = "Authorization: Bearer s3cret"',
    'header = "X-Q: it\'s \\"quoted\\" \\\\ here"',
    'resolve = "acme.example.test:443:203.0.113.7,[2001:db8::7]"',
    'write-out = "%{stderr}\\n__SESSIONS_CURL__%{http_code}\\n"',
  ])
    expect(lines).toContain(line);
  expect(stdin.toLowerCase()).not.toContain("accept-encoding");
  expect(stdin).not.toContain("max-filesize");
});

test("a body never names a file: '@/etc/passwd' is sent as text", async () => {
  await send(
    out("HTTP/1.1 204 No Content\r\n\r\n", 204),
    "https://acme.example.test/q",
    { method: "POST", body: "@/etc/passwd" },
  );
  const { command, stdin } = calls[0]!;
  expect(stdin.split("\n")).toContain('data-raw = "@/etc/passwd"');
  expect(stdin).not.toContain("data-binary");
  expect(command).not.toContain("passwd");
});

test("brackets in a URL are not globbed, braces in a host are refused", async () => {
  await send(
    out("HTTP/1.1 200 OK\r\n\r\nok", 200),
    "https://acme.example.test/search?q=[1-100000]",
  );
  expect(calls[0]!.stdin.split("\n")).toContain(
    'url = "https://acme.example.test/search?q=[1-100000]"',
  );
  expect(calls[0]!.stdin.split("\n")).toContain("globoff");
  calls.length = 0;
  const glob = "https://{169.254.169.254,acme.example.test}/";
  const net = runnerNet("runner-prod", deps(out("", 200)), opts);
  await expect(
    net.send(
      {
        url: new URL(glob),
        host: "{169.254.169.254,acme.example.test}",
        addresses: ["203.0.113.7"],
      },
      init(),
      net.isBlocked,
    ),
  ).rejects.toThrow("Refusing to fetch a host name with glob characters");
  await expect(
    net.resolve("{169.254.169.254,acme.example.test}"),
  ).rejects.toThrow("Refusing to fetch a host name with glob characters");
  const run = await runHttpSource(
    { kind: "http", url: glob },
    { net: runnerNet("runner-prod", deps(out("", 200)), opts) },
  );
  expect(run.observations[0]).toMatchObject({ result: "unknown" });
  expect(calls).toEqual([]);
});

test("HEAD asks with --head, so curl does not wait for a body", async () => {
  const res = await send(
    out("HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n", 200),
    "https://acme.example.test/",
    { method: "HEAD" },
  );
  expect(res.status).toBe(200);
  expect(calls[0]!.stdin.split("\n")).toContain("head");
  expect(calls[0]!.stdin).not.toContain("request =");
});

test("a body cannot fake the status: the marker comes from stderr", async () => {
  const res = await send(out(`HTTP/1.1 500 Oops\r\n\r\nfine${MARK}200`, 500));
  expect(res.status).toBe(500);
  expect(new TextDecoder().decode(res.body)).toBe(`fine${MARK}200`);
  // Without a marker (an old curl) the status line decides.
  expect((await send(out("HTTP/1.1 503 Down\r\n\r\n", null))).status).toBe(503);
});

test("output is capped on the Runner; the status survives a cut body", async () => {
  expect(RUNNER_BODY_CAP_BYTES).toBe(150_000);
  const { command } =
    (await send(out("HTTP/1.1 200 OK\r\n\r\n", 200)), calls[0]!);
  expect(command).toBe(
    `command curl --disable --config - | command head -c ${RUNNER_BODY_CAP_BYTES + 1}; exit "\${PIPESTATUS[0]}"`,
  );
  const long =
    `HTTP/1.1 200 OK\r\n\r\n${"x".repeat(RUNNER_BODY_CAP_BYTES)}`.slice(
      0,
      RUNNER_BODY_CAP_BYTES + 1,
    );
  // head stopped reading: curl failed to write (23) or died of SIGPIPE.
  for (const code of [23, 141]) {
    const preview = await send(out(long, 200, code), undefined, {
      maxBodyBytes: 16_384,
    });
    expect(preview).toMatchObject({ status: 200, truncated: true });
    expect(preview.body.length).toBe(16_384);
    await expect(send(out(long, 200, code))).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
      limitKb: 150,
    });
  }
  const cut = await send(
    out(`HTTP/1.1 200 OK\r\n\r\n${"x".repeat(20_000)}`, 200),
    undefined,
    { maxBodyBytes: 16_384 },
  );
  expect(cut).toMatchObject({ truncated: true });
});

test("redirects come back unfollowed", async () => {
  const res = await send(
    out(
      "HTTP/1.1 302 Found\r\nLocation: https://acme.example.test/b\r\n\r\n",
      302,
    ),
  );
  expect([res.status, res.headers.get("location")]).toEqual([
    302,
    "https://acme.example.test/b",
  ]);
});

test("curl's own failures are failures of the service", async () => {
  await expect(send(out("", null, 28))).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await expect(
    send(out("", null, 7, "curl: (7) Failed to connect")),
  ).rejects.toThrow("curl: (7) Failed to connect");
  await expect(send(out("", null, 6))).rejects.toThrow("curl exited 6");
});

test("curl that cannot make the request is a Runner problem", async () => {
  for (const [code, stderr, detail] of [
    [
      1,
      'curl: (1) Protocol "https" not supported',
      'curl on Runner prod-1 cannot make this request: curl: (1) Protocol "https" not supported',
    ],
    [2, "", "curl on Runner prod-1 cannot make this request (exit 2)"],
    [
      4,
      "curl: (4) A requested feature was not built in",
      "curl on Runner prod-1 cannot make this request: curl: (4) A requested feature was not built in",
    ],
  ] as const)
    await expect(send(out("", null, code, stderr))).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
      message: detail,
    });
});

test("curl must be 7.63 or newer, checked once per Runner", async () => {
  const ok = out("HTTP/1.1 200 OK\r\n\r\n", 200);
  await send(ok);
  await send(ok);
  expect(versionChecks).toBe(1);
  expect(calls).toHaveLength(2);

  __resetCurlVersionsForTest();
  calls.length = 0;
  curlVersion = {
    code: 0,
    stdout: "curl 7.58.0 (x86_64-pc-linux-gnu) libcurl/7.58.0\n",
    stderr: "",
  };
  await expect(send(ok)).rejects.toMatchObject({
    code: "RUNNER_UNAVAILABLE",
    message:
      "Runner prod-1 has curl 7.58.0; incident checks need 7.63 or newer. Update curl on the Runner",
  });
  expect(calls).toEqual([]);
  // A refusal is not remembered: once curl is updated the check runs.
  curlVersion = { code: 0, stdout: "curl 7.63.0 (x)\n", stderr: "" };
  expect((await send(ok)).status).toBe(200);
  expect(versionChecks).toBe(3);

  __resetCurlVersionsForTest();
  for (const [answer, detail] of [
    [
      { code: 127, stdout: "", stderr: "" },
      "curl is not installed on Runner prod-1",
    ],
    [
      { code: 0, stdout: "something else\n", stderr: "" },
      "Runner prod-1 did not report a curl version. Update curl on the Runner",
    ],
  ] as const) {
    curlVersion = answer;
    await expect(send(ok)).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
      message: detail,
    });
  }
});

test("resolving takes no longer than the check has left", async () => {
  const answer = { code: 0, stdout: "203.0.113.7 STREAM\n", stderr: "" };
  await runnerNet("runner-prod", deps(answer, { now: () => 0 }), {
    ...opts,
    timeoutMs: 3_000,
  }).resolve("acme.example.test");
  await runnerNet("runner-prod", deps(answer, { now: () => 0 }), {
    ...opts,
    timeoutMs: 60_000,
  }).resolve("acme.example.test");
  expect(calls.map((c) => c.timeoutMs)).toEqual([3_000, 10_000]);
});

test("Runner problems are Runner problems, never failures", async () => {
  const problem = (
    result: Parameters<typeof deps>[0],
    over: Partial<RunnerFetchDeps> = {},
  ) => send(result, undefined, {}, over);
  await expect(
    problem(out("", null), { connected: () => false }),
  ).rejects.toMatchObject({ code: "RUNNER_OFFLINE", runnerName: "prod-1" });
  await expect(
    problem(out("", null), { runner: () => undefined }),
  ).rejects.toMatchObject({
    code: "RUNNER_OFFLINE",
    runnerName: "runner-prod",
  });
  const cases: Array<
    [Parameters<typeof deps>[0], Partial<RunnerFetchDeps>, string]
  > = [
    [
      out("", null),
      { runner: () => ({ name: "win", platform: "win32" }) },
      "Runner-targeted checks need a macOS or Linux Runner",
    ],
    [
      out("", null),
      { gate: async () => "Runner prod-1 is not a production Runner for acme" },
      "Runner prod-1 is not a production Runner for acme",
    ],
    [
      () => {
        throw new RunnerUnavailableError("Runner prod-1 is in maintenance");
      },
      {},
      "Runner prod-1 is in maintenance",
    ],
    [
      () => {
        throw new RunnerUnavailableError(
          "Update Runner prod-1: it is too old to run incident checks and actions",
        );
      },
      {},
      "Update Runner prod-1: it is too old to run incident checks and actions",
    ],
    [
      () => {
        throw new Error("socket closed");
      },
      {},
      "Runner prod-1: socket closed",
    ],
    [
      out("", null, -1, "\n[Runner disconnected]"),
      {},
      "Runner prod-1 disconnected during the check",
    ],
    [
      { code: -1, stdout: "", stderr: "", timedOut: true },
      {},
      "Runner prod-1 did not answer in time",
    ],
    [out("", null, 127), {}, "curl is not installed on Runner prod-1"],
  ];
  for (const [result, over, detail] of cases)
    await expect(problem(result, over)).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
      message: detail,
    });
});

test("names resolve on the Runner and the answer is checked there", async () => {
  const net = runnerNet(
    "runner-prod",
    deps((call) =>
      call.stdin === "acme.example.test\n"
        ? {
            code: 0,
            stdout:
              "203.0.113.7     STREAM acme.example.test\n203.0.113.7     DGRAM\n2001:db8::7 STREAM\n",
            stderr: "",
          }
        : call.stdin === "mac.example.test\n"
          ? {
              code: 0,
              stdout:
                "name: mac.example.test\nip_address: 198.51.100.4\n\nname: mac.example.test\nipv6_address: 2001:db8::4\n",
              stderr: "",
            }
          : call.stdin === "gone.example.test\n"
            ? { code: 2, stdout: "", stderr: "" }
            : { code: 127, stdout: "", stderr: "" },
    ),
    opts,
  );
  expect(await net.resolve("acme.example.test")).toEqual([
    "203.0.113.7",
    "2001:db8::7",
  ]);
  expect(calls[0]!.command).toContain("getent ahosts");
  expect(calls[0]!.command).not.toContain("acme.example.test");
  expect(calls[0]!.auditCommand).toBe("incident http check sig-1");
  expect(await net.resolve("mac.example.test")).toEqual([
    "198.51.100.4",
    "2001:db8::4",
  ]);
  await expect(net.resolve("gone.example.test")).rejects.toThrow(
    "Could not resolve gone.example.test",
  );
  await expect(net.resolve("odd.example.test")).rejects.toMatchObject({
    code: "RUNNER_UNAVAILABLE",
    message: "Runner prod-1 cannot resolve names (no getent or dscacheutil)",
  });
  await expect(net.resolve("metadata")).rejects.toThrow(
    "Refusing to fetch a private name: metadata",
  );
});

test("a redirect may reach a private address only on the configured host", async () => {
  const ok = out("HTTP/1.1 200 OK\r\n\r\n", 200);
  await send(ok, "https://acme.example.test/", {}, {}, ["10.0.0.5"]);
  const local = runnerNet("runner-prod", deps(ok), {
    ...opts,
    host: "127.0.0.1",
  });
  await local.send(
    target("http://127.0.0.1:8080/health"),
    init(),
    local.isBlocked,
  );
  expect(calls).toHaveLength(2);
  await expect(
    send(ok, "https://other.example.test/", {}, {}, ["10.0.0.9"]),
  ).rejects.toThrow(
    "Refusing to fetch other.example.test: it resolves to the private address 10.0.0.9",
  );
  await expect(
    send(ok, "http://192.168.1.1/", {}, {}, ["192.168.1.1"]),
  ).rejects.toThrow("private address 192.168.1.1");
  expect(calls).toHaveLength(2);
  // Through runHttpSource: the configured host may be private, a redirect
  // off it may not.
  const hops = runnerNet(
    "runner-prod",
    deps((call) =>
      call.stdin.includes('url = "https://acme.example.test/a"')
        ? out(
            "HTTP/1.1 302 Found\r\nLocation: http://10.1.2.3/admin\r\n\r\n",
            302,
          )
        : out("HTTP/1.1 200 OK\r\n\r\nadmin", 200),
    ),
    opts,
  );
  const run = await runHttpSource(
    { kind: "http", url: "https://acme.example.test/a" },
    { net: { ...hops, resolve: async () => ["10.0.0.5"] } },
  );
  expect(run.observations[0]).toMatchObject({
    result: "unknown",
    detail: "Refused: 10.1.2.3 is a private address",
  });
});

test("the Runner guard allows the host itself, refuses metadata in every form", () => {
  for (const allowed of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "acme.example.test",
    "2001:db8::1",
    "fd00:ec3::254",
  ])
    expect(runnerCheckBlocked(allowed)).toBe(false);
  for (const blocked of [
    "169.254.169.254",
    "169.254.170.2",
    "169.254.0.1",
    "168.63.129.16",
    "192.0.0.192",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:ec2::23",
    "[fd00:ec2:0:0:ffff::1]",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "fe80::1",
    "metadata",
    "Metadata.",
    "Metadata.Google.Internal.",
  ])
    expect([blocked, runnerCheckBlocked(blocked)]).toEqual([blocked, true]);
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});
