import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import type { ResolvedEgress } from "../../../shared/incident-access";
import type { execOnRunner } from "../../runner-ws";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { egressFetch } from "./egress";
import type { IncidentToolContext } from "./tool-context";

const kit = useIncidentTestKernel();
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
test("runner route: curl argv, parsed marker, offline Runner", async () => {
  let command = "";
  let opts: unknown;
  const exec = (async (_id: string, cmd: string, o: unknown) => {
    command = cmd;
    opts = o;
    return {
      code: 0,
      stdout: "<html>blocked</html>\n__EGRESS__ 403 0.251 text/html",
      stderr: "",
    };
  }) as typeof execOnRunner;
  const ctx = withEgress({
    route: "runner",
    runner: "rn-prod",
    runnerName: "prod-1",
    hosts: ["search.example.test"],
  });
  const out = await egressFetch(
    ctx,
    {
      url: "https://search.example.test/q",
      headers: { "User-Agent": "acme-app/4.2" },
    },
    { exec, connected: () => true },
  );
  expect(out).toMatchObject({
    ok: true,
    route: "runner",
    status: 403,
    latencyMs: 251,
    contentType: "text/html",
    body: "<html>blocked</html>",
  });
  expect(opts).toEqual({ timeoutMs: 20_000, sessionId: "os-1", aws: false });
  expect(command).toContain("--max-redirs 0");
  expect(command).toContain("--noproxy '*'");
  expect(command).toContain("--header 'User-Agent: acme-app/4.2'");
  expect(command.endsWith("--url https://search.example.test/q")).toBe(true);
  expect(kit.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_egress_fetch",
      route: "runner",
      runner_id: "rn-prod",
      status: 403,
    }),
  );
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      { exec, connected: () => false },
    ),
  ).toEqual({ ok: false, error: "prod-1 is offline" });
});
test("runner route: curl ignores config files, globbing and @ in the body", async () => {
  let command = "";
  const exec = (async (_id: string, cmd: string) => {
    command = cmd;
    return { code: 0, stdout: "\n__EGRESS__ 200 0.001 text/plain", stderr: "" };
  }) as typeof execOnRunner;
  const ctx = withEgress({
    route: "runner",
    runner: "rn-prod",
    runnerName: "prod-1",
    hosts: ["search.example.test"],
  });
  await egressFetch(
    ctx,
    {
      url: "https://search.example.test/q?a=[1-2]&b={x,y}",
      method: "POST",
      body: "@/etc/passwd",
    },
    { exec, connected: () => true },
  );
  // -q must be curl's very first argument to skip ~/.curlrc.
  expect(command.startsWith("curl -q ")).toBe(true);
  expect(command).toContain(" --globoff ");
  expect(command).toContain(" --data-raw @/etc/passwd ");
  expect(command).not.toContain("--data-binary");
});
test.skipIf(!Bun.which("curl"))(
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
      const exec = (async (_id: string, cmd: string) => {
        const proc = Bun.spawn(["bash", "-c", cmd], {
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
      const ctx = withEgress({
        route: "runner",
        runner: "rn-prod",
        runnerName: "prod-1",
        hosts: ["127.0.0.1"],
      });
      const url = `http://127.0.0.1:${echo.port}/q?a=[1-2]&b={x,y}`;
      const out = await egressFetch(
        ctx,
        { url, method: "POST", body: "@/etc/hosts" },
        { exec, connected: () => true },
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
test("runner route: a redirect location and a failed curl", async () => {
  const ctx = withEgress({
    route: "runner",
    runner: "rn-prod",
    runnerName: "prod-1",
    hosts: ["search.example.test"],
  });
  const moved = (async () => ({
    code: 0,
    stdout:
      "\n__EGRESS__ 302 0.010 text/html; charset=utf-8\n__EGRESS_LOCATION__ https://search.example.test/next",
    stderr: "",
  })) as unknown as typeof execOnRunner;
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      { exec: moved, connected: () => true },
    ),
  ).toMatchObject({
    ok: true,
    status: 302,
    contentType: "text/html; charset=utf-8",
    location: "https://search.example.test/next",
    body: "",
  });
  const failed = (async () => ({
    code: 6,
    stdout: "",
    stderr: "curl: (6) Could not resolve host",
  })) as unknown as typeof execOnRunner;
  expect(
    await egressFetch(
      ctx,
      { url: "https://search.example.test/q" },
      { exec: failed, connected: () => true },
    ),
  ).toEqual({
    ok: false,
    error: "curl on prod-1 failed (exit 6): curl: (6) Could not resolve host",
  });
});
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
