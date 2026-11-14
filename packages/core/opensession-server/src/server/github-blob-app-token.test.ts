// The App token an approved lead step posts with (github-blob.ts
// `blobAppToken`): one repository, and only the permissions Blob's writes use.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "./config";
import { __setGithubAppKeyPathForTest } from "./github-app";
import { BLOB_APP_PERMISSIONS, blobAppToken } from "./github-blob";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClientId = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = savedConfig;
    await getConfigAsync();
  }
  if (savedClientId === undefined)
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClientId;
  globalThis.fetch = originalFetch;
  __setGithubAppKeyPathForTest(undefined);
  const cache = globalThis as any;
  cache.__ghAppTokenCache = undefined;
  cache.__ghAppTokenWarned = undefined;
  cache.__ghAppInstallationsCache = null;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function configureApp(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "opensession-blob-app-token-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  const keyPath = join(dir, "github-app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(
    config,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "Iv-blob-test",
          appSlug: "open-session-blob-test",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  __setGithubAppKeyPathForTest(keyPath);
}

test("mints a token for the one repository with only issues, pull requests and metadata", async () => {
  await configureApp();
  const mints: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/app/installations?"))
      return Response.json([
        { id: 7, account: { login: "acme", type: "Organization" } },
      ]);
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
      mints.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({
        token: "ghs_blob",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  expect(await blobAppToken("acme/widgets")).toBe("ghs_blob");
  expect(mints).toEqual([
    {
      url: "https://api.github.com/app/installations/7/access_tokens",
      body: {
        repositories: ["widgets"],
        permissions: {
          issues: "write",
          pull_requests: "write",
          metadata: "read",
        },
      },
    },
  ]);
  expect(mints[0]!.body.permissions).toEqual({ ...BLOB_APP_PERMISSIONS });
});

test("an owner the App is not installed on mints nothing", async () => {
  await configureApp();
  let minted = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/app/installations?"))
      return Response.json([
        { id: 7, account: { login: "acme", type: "Organization" } },
      ]);
    if (/access_tokens$/.test(url)) minted = true;
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;

  expect(await blobAppToken("stranger/widgets")).toBeNull();
  expect(minted).toBe(false);
});
