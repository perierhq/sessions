import { getConfigAsync } from "./config";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleCsWebhook } from "./codestorage/webhook";
import { handlePrWebhookEvent } from "./pr-webhook";
import { GITHUB_APP_MANIFEST_EVENTS } from "./routes/setup-github-manifest";
import { askCheckoutInvalidationGeneration } from "./worktree";

/**
 * A push to a repository's default branch, on GitHub or code.storage, makes
 * the next Ask session wait for its shared checkout to catch up, instead of
 * starting on the state of the last refresh.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_PR_WEBHOOKS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const SECRET = "test-webhook-secret";
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bks-ask-webhooks-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      integrations: {
        codeStorage: {
          org: "acme",
          privateKeyPath: join(root, "missing.pem"),
          webhookSecret: SECRET,
        },
      },
      repos: {
        gh: {
          repo: join(root, "gh"),
          wtPrefix: "gh",
          defaultBranch: "main",
          ghRepo: "acme/widget",
        },
        cs: {
          repo: join(root, "cs"),
          wtPrefix: "cs",
          defaultBranch: "trunk",
          host: "codestorage",
          csRepo: "acme/gadget",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  delete process.env.OPENSESSION_PR_WEBHOOKS;
  await getConfigAsync();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function csDelivery(event: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return new Request("http://localhost/codestorage/webhook", {
    method: "POST",
    body,
    headers: {
      "x-pierre-event": event,
      "x-pierre-signature": `t=${t},sha256=${sig}`,
    },
  });
}

describe("GitHub deliveries", () => {
  test("new GitHub Apps subscribe to pushes", () => {
    expect(GITHUB_APP_MANIFEST_EVENTS).toContain("push");
  });

  test("a push to the default branch invalidates the Ask checkout", () => {
    const before = askCheckoutInvalidationGeneration("gh");
    handlePrWebhookEvent("push", {
      ref: "refs/heads/main",
      repository: { full_name: "acme/widget" },
    });
    expect(askCheckoutInvalidationGeneration("gh")).toBe(before + 1);
  });

  test("a pull request merged into the default branch does too", () => {
    const before = askCheckoutInvalidationGeneration("gh");
    handlePrWebhookEvent("pull_request", {
      action: "closed",
      repository: { full_name: "acme/widget" },
      pull_request: {
        merged: true,
        number: 7,
        base: { ref: "main" },
        head: { ref: "main" },
      },
    });
    expect(askCheckoutInvalidationGeneration("gh")).toBe(before + 1);
  });

  test("other repositories are untouched", () => {
    const before = askCheckoutInvalidationGeneration("gh");
    handlePrWebhookEvent("push", {
      ref: "refs/heads/main",
      repository: { full_name: "acme/elsewhere" },
    });
    expect(askCheckoutInvalidationGeneration("gh")).toBe(before);
  });
});

describe("code.storage deliveries", () => {
  test("a push to the default branch invalidates the Ask checkout", async () => {
    const before = askCheckoutInvalidationGeneration("cs");
    const response = await handleCsWebhook(
      csDelivery("push", {
        ref: "refs/heads/trunk",
        repository: { url: "acme/gadget" },
      }),
    );
    expect(response.status).toBe(200);
    expect(askCheckoutInvalidationGeneration("cs")).toBe(before + 1);
  });

  test("a push to another branch does not", async () => {
    const before = askCheckoutInvalidationGeneration("cs");
    await handleCsWebhook(
      csDelivery("push", {
        ref: "refs/heads/feature",
        repository: { url: "acme/gadget" },
      }),
    );
    expect(askCheckoutInvalidationGeneration("cs")).toBe(before);
  });
});
