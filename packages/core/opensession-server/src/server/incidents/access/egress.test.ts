import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import type { ResolvedEgress } from "../../../shared/incident-access";
import type {
  RunnerExecOptions,
  RunnerExecResult,
  execOnRunner,
} from "../../runner-ws";
import { __resetCurlVersionsForTest } from "../sources/runner-fetch";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { egressFetch } from "./egress";
import type { IncidentToolContext } from "./tool-context";

const kit = useIncidentTestKernel();
beforeEach(() => __resetCurlVersionsForTest());
let target: Server<undefined>;
let proxy: Server<undefined>;
let proxySawAuth: string | null = null;
let targetSaw: Headers | null = null;
beforeAll(() => {
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      targetSaw = req.headers;
      const p = new URL(req.url).pathname;
      if (p === "/moved")
        return Response.redirect("http://10.0.0.1/admin", 302);
      if (p === "/big") return new Response("y".repeat(200_000));
      return new Response("<html>blocked</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    },
  });
  proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      proxySawAuth = req.headers.get("proxy-authorization");
      return new Response("via proxy", { status: 200 });
    },
  });
});
afterAll(() => {
  target.stop(true);
  proxy.stop(true);
});
const allow = {
  assertUrl: async (raw: string) => new URL(raw),
  net: { isBlocked: () => false },
};
const host = () => "127.0.0.1";
const withEgress = (egress: ResolvedEgress | null): IncidentToolContext => ({
  sessionId: "os-1",
  binding: {
    incidentId: "inc-1",
    role: "verifier",
    signalId: null,
    accessRevision: "r",
    spawn: { hosts: [], credentials: [], egress: null },
  },
  access: agentAccessFixture({ role: "verifier", egress }),
});

test("server route: status, body, no redirect following, no query in the audit", async () => {
  const ctx = withEgress({ route: "server", hosts: [host()] });
  const out = await egressFetch(
    ctx,
    {
      url: `${target.url}q?token=abc`,
      headers: { "User-Agent": "acme-app/4.2", Cookie: "sid=1" },
    },
    allow,
  );
  expect(out).toMatchObject({
    ok: true,
    route: "server",
    status: 403,
    contentType: "text/html",
    body: "<html>blocked</html>",
    truncated: false,
    droppedHeaders: ["Cookie"],
  });
  expect(targetSaw?.get("user-agent")).toBe("acme-app/4.2");
  expect(targetSaw?.get("cookie")).toBeNull();
  const moved = await egressFetch(ctx, { url: `${target.url}moved` }, allow);
  expect(moved).toMatchObject({
    ok: true,
    status: 302,
    location: "http://10.0.0.1/admin",
  });
  const line = kit.audits.find((e) => e.kind === "incident_egress_fetch")!;
  expect(line).toMatchObject({
    route: "server",
    method: "GET",
    host: host(),
    path: "/q",
    status: 403,
    incident_id: "inc-1",
    incident_role: "verifier",
    session_id: "os-1",
  });
  expect(JSON.stringify(kit.audits)).not.toContain("abc");
  expect(JSON.stringify(kit.audits)).not.toContain("acme-app");
});
test("server route caps the returned body", async () => {
  const out = await egressFetch(
    withEgress({ route: "server", hosts: [host()] }),
    { url: `${target.url}big` },
    allow,
  );
  expect(out).toMatchObject({ ok: true, status: 200, truncated: true });
  expect(out.ok && out.body.length).toBe(65_536);
});
test("the real guard refuses private addresses on the server route", async () => {
  expect(
    await egressFetch(withEgress({ route: "server", hosts: [host()] }), {
      url: `${target.url}q`,
    }),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/^Refused: /) });
});
test.each([
  [
    { url: "https://other.example.test/" },
    "other.example.test is not on this agent's egress list",
  ],
  [
    { url: "https://u:p@search.example.test/" },
    "Credentials do not go in the URL",
  ],
  [{ url: "ftp://search.example.test/" }, "Only http and https URLs"],
  [{ url: "not a url" }, "Not a URL"],
  [{ url: "https://search.example.test/", body: "x" }, "A body needs POST"],
  [
    {
      url: "https://search.example.test/",
      method: "POST" as const,
      body: "x".repeat(16_385),
    },
    "Body too long",
  ],
  [
    {
      url: "https://search.example.test/",
      headers: { Accept: "a\r\nX-Evil: 1" },
    },
    "Header values cannot contain line breaks",
  ],
])("refuses %j", async (input, error) => {
  expect(
    await egressFetch(
      withEgress({ route: "server", hosts: ["search.example.test"] }),
      input,
      allow,
    ),
  ).toEqual({ ok: false, error });
  expect(kit.audits).toContainEqual(
    expect.objectContaining({ kind: "incident_egress_denied", reason: error }),
  );
});
test("no route, no requests", async () => {
  expect(
    await egressFetch(
      withEgress(null),
      { url: "https://search.example.test/" },
      allow,
    ),
  ).toEqual({ ok: false, error: "This agent has no egress route" });
});
type ExecCall = { runner: string; command: string; opts: RunnerExecOptions };
const RESOLVE = "getent ahosts";
const VERSION = "command curl --version";
/** A Runner that resolves names to `addresses`, has curl 8.5 and answers
 *  curl with `curl`. */
function fakeRunner(
  curl: (call: ExecCall) => RunnerExecResult,
  addresses = ["93.184.216.34"],
) {
  const calls: ExecCall[] = [];
  const exec = (async (
    runner: string,
    command: string,
    opts: RunnerExecOptions = {},
  ) => {
    const call = { runner, command, opts };
    calls.push(call);
    if (command.includes(RESOLVE))
      return {
        code: 0,
        stdout: addresses.map((a) => `${a} STREAM x`).join("\n"),
        stderr: "",
      };
    if (command === VERSION)
      return {
        code: 0,
        stdout: "curl 8.5.0 (x86_64-pc-linux-gnu)\n",
        stderr: "",
      };
    return curl(call);
  }) as typeof execOnRunner;
  return {
    calls,
    deps: {
      exec,
      connected: () => true,
      runner: () => ({ name: "prod-1", platform: "linux" }),
    },
  };
}
const curlAnswer = (
  status: number,
  head: string,
  body = "",
  code = 0,
  stderr = "",
): RunnerExecResult => ({
  code,
  stdout: `HTTP/1.1 ${status} X\r\n${head}\r\n\r\n${body}`,
  stderr: `${stderr}\n__SESSIONS_CURL__${status}\n`,
});
const runnerEgress = (hosts = ["search.example.test"]) =>
  withEgress({
    route: "runner",
    runner: "rn-prod",
    runnerName: "prod-1",
    hosts,
  });

test("runner route: the request goes on stdin, the logs get a label", async () => {
  const r = fakeRunner(() =>
    curlAnswer(403, "content-type: text/html", "<html>blocked</html>"),
  );
  const ctx = runnerEgress();
  const out = await egressFetch(
    ctx,
    {
      url: "https://search.example.test/q?token=abc",
      headers: { "User-Agent": "acme-app/4.2" },
    },
    r.deps,
  );
  expect(out).toMatchObject({
    ok: true,
    route: "runner",
    status: 403,
    contentType: "text/html",
    body: "<html>blocked</html>",
  });
  const curl = r.calls.at(-1)!;
  expect(curl.command).toStartWith("command curl --disable --config - ");
  expect(curl.opts.stdin).toContain(
    'url = "https://search.example.test/q?token=abc"',
  );
  expect(curl.opts.stdin).toContain('header = "User-Agent: acme-app/4.2"');
  expect(curl.opts.stdin).toContain("globoff");
  expect(curl.opts.stdin).toContain("max-redirs = 0");
  for (const call of r.calls) {
    expect(call.runner).toBe("rn-prod");
    expect(call.command).not.toContain("search.example.test");
    expect(call.command).not.toContain("token");
    expect(call.opts).toMatchObject({
      repo: "acme",
      sessionId: "os-1",
      auditCommand: "incident egress GET search.example.test/q",
      caller: {
        kind: "incident-agent-readonly",
        use: "egress",
        incidentId: "inc-1",
      },
    });
    expect(call.opts.aws).toBeUndefined();
  }
  expect(kit.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_egress_fetch",
      route: "runner",
      runner_id: "rn-prod",
      host: "search.example.test",
      path: "/q",
      status: 403,
    }),
  );
  expect(JSON.stringify(kit.audits)).not.toContain("token=abc");
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      { ...r.deps, connected: () => false },
    ),
  ).toEqual({ ok: false, error: "prod-1 is offline" });
});
test("runner route: a body starting with @ is data, and the label keeps no ids", async () => {
  const r = fakeRunner(() => curlAnswer(200, "content-type: text/plain", "ok"));
  await egressFetch(
    runnerEgress(),
    {
      url: "https://search.example.test/users/12345/orders/abcdef0123456789?a=[1-2]",
      method: "POST",
      body: "@/etc/passwd",
    },
    r.deps,
  );
  const curl = r.calls.at(-1)!;
  expect(curl.opts.stdin).toContain('data-raw = "@/etc/passwd"');
  expect(curl.opts.stdin).toContain('request = "POST"');
  expect(curl.opts.auditCommand).toBe(
    "incident egress POST search.example.test/users/:id/orders/:id",
  );
});
test("runner route: a redirect location, a failed curl, metadata and an old curl", async () => {
  const ctx = runnerEgress();
  const moved = fakeRunner(() =>
    curlAnswer(
      302,
      "location: https://search.example.test/next\r\ncontent-type: text/html; charset=utf-8",
    ),
  );
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      moved.deps,
    ),
  ).toMatchObject({
    ok: true,
    status: 302,
    contentType: "text/html; charset=utf-8",
    location: "https://search.example.test/next",
    body: "",
  });
  const failed = fakeRunner(() => ({
    code: 7,
    stdout: "",
    stderr: "curl: (7) Failed to connect",
  }));
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      failed.deps,
    ),
  ).toEqual({
    ok: false,
    error: "Request failed: curl: (7) Failed to connect",
  });
  const metadata = fakeRunner(
    () => curlAnswer(200, "content-type: text/plain", "creds"),
    ["169.254.169.254"],
  );
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      metadata.deps,
    ),
  ).toEqual({
    ok: false,
    error:
      "Refused: search.example.test resolves to the private address 169.254.169.254",
  });
  expect(metadata.calls.some((c) => c.command.includes("--config"))).toBe(
    false,
  );
  __resetCurlVersionsForTest();
  const old = fakeRunner(() => curlAnswer(200, "", ""));
  const oldExec = old.deps.exec;
  old.deps.exec = (async (
    runner: string,
    command: string,
    opts?: RunnerExecOptions,
  ) =>
    command === VERSION
      ? { code: 0, stdout: "curl 7.58.0 (x)\n", stderr: "" }
      : oldExec(runner, command, opts)) as typeof execOnRunner;
  expect(
    await egressFetch(ctx, { url: "https://search.example.test/q" }, old.deps),
  ).toEqual({
    ok: false,
    error:
      "Could not run on prod-1: Runner prod-1 has curl 7.58.0; incident checks need 7.63 or newer. Update curl on the Runner",
  });
});
test.skipIf(!Bun.which("curl") || !Bun.which("bash"))(
  "runner route: a real curl sends an @ body literally and does not expand the query",
  async () => {
    const seen: { url: string; body: string }[] = [];
    const echo = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ url: req.url, body: await req.text() });
        return new Response("ok", {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    try {
      // The Runner runs `bash -lc <command>` with the input on stdin.
      const exec = (async (
        _id: string,
        cmd: string,
        o: RunnerExecOptions = {},
      ) => {
        const proc = Bun.spawn(["bash", "-c", cmd], {
          stdin: new TextEncoder().encode(o.stdin ?? ""),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, stdout, stderr };
      }) as typeof execOnRunner;
      const url = `http://127.0.0.1:${echo.port}/q?a=[1-2]&b={x,y}`;
      const out = await egressFetch(
        runnerEgress(["127.0.0.1"]),
        { url, method: "POST", body: "@/etc/hosts" },
        {
          exec,
          connected: () => true,
          runner: () => ({ name: "local", platform: process.platform }),
        },
      );
      expect(out).toMatchObject({ ok: true, status: 200, body: "ok" });
      // One request, with the brackets and braces as given.
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0].url).search).toBe("?a=[1-2]&b={x,y}");
      expect(seen[0].body).toBe("@/etc/hosts");
    } finally {
      echo.stop(true);
    }
  },
);
test("proxy route injects the borrowed proxy header and nothing else", async () => {
  const ctx = withEgress({
    route: "proxy",
    proxyUrl: String(proxy.url),
    proxyCredential: "kc-fwd",
    hosts: ["search.example.test"],
  });
  let asked: unknown;
  const out = await egressFetch(
    ctx,
    { url: "http://search.example.test/q" },
    {
      ...allow,
      proxyHeaders: (input) => {
        asked = input;
        return { "Proxy-Authorization": "Basic dXNlcjpwYXNz" };
      },
    },
  );
  expect(out).toMatchObject({
    ok: true,
    route: "proxy",
    status: 200,
    body: "via proxy",
  });
  expect(proxySawAuth).toBe("Basic dXNlcjpwYXNz");
  expect(asked).toMatchObject({
    sessionId: "os-1",
    incidentId: "inc-1",
    credentialId: "kc-fwd",
    host: "127.0.0.1",
  });
  expect(JSON.stringify(kit.audits)).not.toContain("dXNlcjpwYXNz");
  expect(
    await egressFetch(
      ctx,
      { url: "http://search.example.test/q" },
      {
        ...allow,
        proxyHeaders: () => ({
          error: "This agent holds no grant for fwd-proxy",
        }),
      },
    ),
  ).toEqual({ ok: false, error: "This agent holds no grant for fwd-proxy" });
});
test("a proxy credential that injects anything but Proxy-Authorization is refused", async () => {
  const ctx = withEgress({
    route: "proxy",
    proxyUrl: String(proxy.url),
    proxyCredential: "kc-proxy",
    hosts: ["search.example.test"],
  });
  proxySawAuth = null;
  expect(
    await egressFetch(
      ctx,
      { url: "http://search.example.test/q" },
      { ...allow, proxyHeaders: () => ({ Authorization: "Bearer zzz" }) },
    ),
  ).toEqual({
    ok: false,
    error: "The proxy credential must inject Proxy-Authorization",
  });
  expect(proxySawAuth).toBeNull();
});
test("proxy route keeps the address guard on the proxy and the target", async () => {
  const ctx = withEgress({
    route: "proxy",
    proxyUrl: String(proxy.url),
    hosts: ["search.example.test"],
  });
  expect(
    await egressFetch(
      ctx,
      { url: "http://search.example.test/q" },
      {
        assertUrl: async (raw) => {
          if (raw.includes("127.0.0.1"))
            throw new Error("Refusing to fetch 127.0.0.1");
          return new URL(raw);
        },
      },
    ),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/^Refused: /) });
});
