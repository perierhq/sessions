// An automation's project is its `repo`: the create and edit dialog both send
// it, and an edit that leaves it out keeps the one already stored.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  createAutomation,
  getAutomation,
  updateAutomation,
} from "./automations";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";

const savedConfig = process.env.OPENSESSION_CONFIG;
let root: string;
let store: SessionKernelStore;
let previousStore: ReturnType<typeof __setSessionKernelStoreForTest>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-automation-repo-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        "acme-web": {
          repo: join(root, "acme-web"),
          wtPrefix: "web",
          defaultBranch: "main",
          default: true,
        },
        "acme-api": {
          repo: join(root, "acme-api"),
          wtPrefix: "api",
          defaultBranch: "main",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  await getConfigAsync();
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});

afterAll(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  rmSync(root, { recursive: true, force: true });
});

async function created(repo?: string) {
  const result = await createAutomation({
    name: "Nightly sweep",
    prompt: "Check the open pull requests",
    schedule: "",
    mode: "ask",
    createdBy: "kent",
    repo,
  });
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("an automation's project", () => {
  test("create stores the project it was given", async () => {
    expect((await created("acme-api")).repo).toBe("acme-api");
  });

  test("an edit that leaves the project out keeps it", async () => {
    const automation = await created("acme-api");
    const result = await updateAutomation(automation.id, {
      name: "Nightly sweep, renamed",
    });
    expect(result).toMatchObject({ repo: "acme-api" });
    expect((await getAutomation(automation.id))?.repo).toBe("acme-api");
  });

  test("an edit that names another project moves it there", async () => {
    const automation = await created("acme-api");
    expect(
      await updateAutomation(automation.id, { repo: "acme-web" }),
    ).toMatchObject({ repo: "acme-web" });
    expect((await getAutomation(automation.id))?.repo).toBe("acme-web");
  });

  test("one with no project can be given one", async () => {
    const automation = await created();
    expect(automation.repo).toBeUndefined();
    expect(
      await updateAutomation(automation.id, { repo: "acme-api" }),
    ).toMatchObject({ repo: "acme-api" });
  });

  test("a project that isn't registered is refused and nothing changes", async () => {
    const automation = await created("acme-api");
    const result = await updateAutomation(automation.id, {
      repo: "acme-missing",
    });
    expect(result).toEqual({
      error: 'Unknown repo "acme-missing" — registered: acme-web, acme-api',
    });
    expect((await getAutomation(automation.id))?.repo).toBe("acme-api");
  });
});
