/**
 * The supervisor's get-or-create: one session per person, kept in the
 * `supervisors` catalog namespace, never two under concurrent ensures, and a
 * fresh one when the mapped session is gone. Runs on the in-memory kernel
 * store with every state path under a scratch root.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import type { NativeSessionFile } from "./types";

const root = mkdtempSync(join(tmpdir(), "supervisor-test-"));
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Supervisor = typeof import("./supervisor");
type Catalog = typeof import("./catalog-documents");
let supervisor: Supervisor;
let catalog: Catalog;
let priorSessionsDir: string | undefined;

beforeAll(async () => {
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  const { __setSessionListStoreForTest, SessionListStore } =
    await import("./session-list-store");
  __setSessionListStoreForTest(new SessionListStore(":memory:"));
  supervisor = await import("./supervisor");
  catalog = await import("./catalog-documents");
});

afterAll(async () => {
  (await import("./session-list-store")).__setSessionListStoreForTest(
    undefined,
  );
  if (priorSessionsDir !== undefined)
    (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  rmSync(join(root, ".opensession-supervisors"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

async function sessionDoc(id: string): Promise<NativeSessionFile | undefined> {
  const { sessionMetadata } = await import("./session-kernel");
  const stored = await sessionMetadata({ op: "catalog_get", sessionId: id });
  return stored ? (JSON.parse(stored.doc) as NativeSessionFile) : undefined;
}

describe("ensureSupervisorSession", () => {
  test("creates a repo-less ask-mode supervisor on the instance default model", async () => {
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    const doc = await sessionDoc(sessionId);
    expect(doc).toMatchObject({
      id: sessionId,
      title: "Supervisor",
      mode: "ask",
      supervisor: true,
      repoLess: true,
      createdBy: "Ada",
      branch: "",
      worktreeDir: "",
    });
    expect(doc?.desk).toBeUndefined();
    expect(doc?.model).toBeUndefined();
    expect(doc?.effort).toBeUndefined();
    expect(doc?.repo).toBeUndefined();
  });

  test("is idempotent per person", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.ensureSupervisorSession("Ada")).toEqual(first);
    const other = await supervisor.ensureSupervisorSession("Grace");
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  test("concurrent ensures for one person create one session", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        supervisor.ensureSupervisorSession("Ada"),
      ),
    );
    const ids = new Set(results.map((r) => r.sessionId));
    expect(ids.size).toBe(1);
    // One session file was written, not five with four archived losers.
    const { sessionMetadata } = await import("./session-kernel");
    const sessions = await sessionMetadata({
      op: "catalog_page",
      afterSessionId: "",
      limit: 50,
    });
    expect(sessions.map((row) => row.sessionId)).toEqual([...ids]);
    const page = await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .list();
    expect(page).toHaveLength(1);
  });

  test("keeps the map in the supervisors catalog namespace and its export", async () => {
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    const key = supervisor.supervisorKey("Ada");
    expect(
      await catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE).get(key),
    ).toMatchObject({ sessionId });
    const exported = JSON.parse(
      await readFile(
        join(root, ".opensession-supervisors", `${key}.json`),
        "utf8",
      ),
    );
    expect(exported.sessionId).toBe(sessionId);
  });

  test("replaces a mapping whose session is gone", async () => {
    const key = supervisor.supervisorKey("Ada");
    await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .set(key, { sessionId: "os-missing", createdAt: "" });
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    expect(sessionId).not.toBe("os-missing");
    expect((await sessionDoc(sessionId))?.supervisor).toBe(true);
    expect(
      await catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE).get(key),
    ).toMatchObject({ sessionId });
  });
});

describe("standing sessions", () => {
  test("only an explicit supervisor request leaves the Desk", () => {
    expect(supervisor.parseStanding("supervisor")).toBe("supervisor");
    expect(supervisor.parseStanding("desk")).toBe("desk");
    expect(supervisor.parseStanding(undefined)).toBe("desk");
    expect(supervisor.parseStanding("anything")).toBe("desk");
  });

  test("standingSessionFor resolves the supervisor through the catalog", async () => {
    const ensured = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.standingSessionFor("Ada", "supervisor")).toEqual(
      ensured,
    );
  });

  test("the charter is plain and short", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).not.toContain("\u2014");
    expect(note).toContain("refunds");
    expect(note).toContain("create_session");
  });

  test("the charter says how Blob speaks", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain("## How Blob speaks");
    expect(note).toContain("warm, but not pretending to be human");
    expect(note).toContain('("I\'d raise it")');
    expect(note).toContain('no filler ("Great question")');
    expect(note).toContain('Never say "as an AI"');
    expect(note).toContain("Never claim something you didn't do");
    expect(note).toContain('say "I don\'t know" plainly');
    expect(note).toContain("One or two sentences, then stop.");
    expect(note).toContain("never cute. No em dashes.");
  });

  test("Blob names the persona when delegating and never posts publicly", () => {
    const note = supervisor.supervisorNote("Robin");
    expect(note).toContain('("I\'ve asked Robin to review it")');
    expect(note).toContain("ask_pat hands Robin GitHub work");
    expect(note).toContain(
      "You never sign or post anything public yourself, and nothing public is ever signed Blob. Anything public goes out as Robin",
    );
    expect(note).not.toContain("Pat ");
  });
});

describe("POST /api/supervisor/ensure", () => {
  async function post(
    body: unknown,
    authUser?: { login: string; name: string },
  ) {
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    const url = new URL("http://localhost/api/supervisor/ensure");
    return handleSupervisorRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser,
    });
  }

  test("answers the claimed user's supervisor without sign-in", async () => {
    const res = await post({ user: "Ada" });
    expect(res?.status).toBe(200);
    const json = (await res!.json()) as {
      sessionId: string;
      session: { supervisor?: boolean } | null;
    };
    expect(json.sessionId).toBe(
      (await supervisor.ensureSupervisorSession("Ada")).sessionId,
    );
    expect(json.session?.supervisor).toBe(true);
  });

  test("a signed-in person gets their own, whatever the body claims", async () => {
    const res = await post(
      { user: "Grace" },
      { login: "ada", name: "Ada Lovelace" },
    );
    const json = (await res!.json()) as { sessionId: string };
    expect(json.sessionId).toBe(
      (await supervisor.ensureSupervisorSession("Ada")).sessionId,
    );
  });

  test("refuses a request with no user, and is in the route chain", async () => {
    expect((await post({}))?.status).toBe(400);
    const { routeHandlers } = await import("./routes/index");
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    expect(routeHandlers).toContain(handleSupervisorRoutes);
  });
});
