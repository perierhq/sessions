/**
 * A tiny OAuth-protected MCP server for tests: one origin serves an MCP
 * endpoint that answers only a current bearer token, and a token endpoint
 * that refreshes it, rotating the refresh token each time. Nothing starts at
 * import; call startOauthMcpFixture().
 *
 * Run it on its own (`bun oauth-mcp-fixture.ts`) to point a test instance at
 * it: it prints its URL and a grant to seed, then serves until killed.
 * OAUTH_FIXTURE_PORT picks the port, OAUTH_FIXTURE_TTL_SECONDS the token
 * lifetime.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export interface OauthMcpFixture {
  url: string;
  mcpUrl: string;
  tokenUrl: string;
  /** Token endpoint requests, in order, as their form fields. */
  tokenRequests: Array<Record<string, string>>;
  /** Issue a fresh pair without the token endpoint (a completed sign-in). */
  issue(): { accessToken: string; refreshToken: string; expiresIn: number };
  /** Make every refresh fail with this OAuth error (e.g. invalid_grant). */
  failRefreshWith(error: string | undefined): void;
  stop(): void;
}

function mcpServer(): McpServer {
  const server = new McpServer({ name: "oauth-fixture", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "Answers pong when the caller is signed in" },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  return server;
}

export function startOauthMcpFixture(
  opts: { port?: number; ttlSeconds?: number; delayMs?: number } = {},
): OauthMcpFixture {
  const ttl = opts.ttlSeconds ?? 3600;
  const access = new Set<string>();
  const refresh = new Set<string>();
  const tokenRequests: Array<Record<string, string>> = [];
  let failure: string | undefined;
  let n = 0;
  const issue = () => {
    n += 1;
    const pair = {
      accessToken: `fixture-access-${n}-${crypto.randomUUID()}`,
      refreshToken: `fixture-refresh-${n}-${crypto.randomUUID()}`,
      expiresIn: ttl,
    };
    access.add(pair.accessToken);
    refresh.add(pair.refreshToken);
    setTimeout(() => access.delete(pair.accessToken), ttl * 1000).unref?.();
    return pair;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        tokenRequests.push(form);
        if (opts.delayMs) await Bun.sleep(opts.delayMs);
        if (failure)
          return Response.json(
            { error: failure, error_description: "Refresh refused" },
            { status: 400 },
          );
        if (
          form.grant_type !== "refresh_token" ||
          !refresh.delete(form.refresh_token ?? "")
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const pair = issue();
        return Response.json({
          access_token: pair.accessToken,
          refresh_token: pair.refreshToken,
          expires_in: pair.expiresIn,
          token_type: "Bearer",
        });
      }
      if (path === "/mcp") {
        const bearer = req.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "");
        if (!bearer || !access.has(bearer))
          return Response.json(
            { error: "invalid_token", error_description: "Sign in first" },
            { status: 401 },
          );
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcpServer().connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    tokenUrl: `${url}/token`,
    tokenRequests,
    issue,
    failRefreshWith: (error) => {
      failure = error;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const fixture = startOauthMcpFixture({
    port: Number(process.env.OAUTH_FIXTURE_PORT) || 0,
    ttlSeconds: Number(process.env.OAUTH_FIXTURE_TTL_SECONDS) || 120,
  });
  const pair = fixture.issue();
  console.log(
    JSON.stringify({
      mcpUrl: fixture.mcpUrl,
      tokenUrl: fixture.tokenUrl,
      refreshToken: pair.refreshToken,
    }),
  );
}
