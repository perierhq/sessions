import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  INCIDENT_DECLARED_FROM,
  createIncidentDeclarationScanner,
  declaringSessionFor,
  incidentKey,
  incidentsInEvent,
  recordIncidentDeclaration,
  stampIncidentDeclaration,
} from "./incident-declarations";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";

const ULID = "01M3SBWM38AS5GGECBX13SZBS7";
const LINK = "https://os.example.test/session/os-1";

describe("stampIncidentDeclaration", () => {
  test("appends the session link to an incident_create summary", () => {
    expect(
      stampIncidentDeclaration(
        "incident_create",
        { name: "Down", summary: "It broke." },
        LINK,
      ),
    ).toEqual({
      name: "Down",
      summary: `It broke.\n\n${INCIDENT_DECLARED_FROM} ${LINK}`,
    });
    expect(
      stampIncidentDeclaration("incident_create", { name: "Down" }, LINK),
    ).toEqual({ name: "Down", summary: `${INCIDENT_DECLARED_FROM} ${LINK}` });
  });

  test("leaves other tools, a missing link and an already-stamped summary alone", () => {
    const args = { name: "Down", summary: `See ${LINK}` };
    expect(stampIncidentDeclaration("incident_update", args, LINK)).toBe(args);
    expect(stampIncidentDeclaration("incident_create", args, undefined)).toBe(
      args,
    );
    expect(stampIncidentDeclaration("incident_create", args, LINK)).toBe(args);
  });
});

describe("incidentKey / incidentsInEvent", () => {
  test("normalizes ULIDs and references", () => {
    expect(incidentKey(ULID)).toBe(ULID);
    expect(incidentKey("#INC-105")).toBe("INC-105");
    expect(incidentKey("inc-7")).toBe("INC-7");
    expect(incidentKey("105")).toBeUndefined();
    expect(incidentKey("os-1")).toBeUndefined();
  });

  test("reads the incident fields of a webhook payload only", () => {
    expect(
      incidentsInEvent(
        JSON.stringify({
          incident_id: ULID,
          reference: "#INC-105",
          id: "01M3SBWM38AS5GGECBX13SZBS8",
        }),
      ),
    ).toEqual([ULID, "INC-105"]);
    expect(incidentsInEvent("not json")).toEqual([]);
    expect(incidentsInEvent(undefined)).toEqual([]);
  });
});

describe("createIncidentDeclarationScanner", () => {
  const created = `{"created_at":"2026-09-30T14:35:53Z","external_id":105,"id":"${ULID}","mode":"standard","name":"x","reference":"INC-105"}`;

  // tool_call is pi's dispatcher; mcp_call is what older transcripts store.
  test.each(["tool_call", "mcp_call"])(
    "records a create made through the %s dispatcher",
    (toolName) => {
      const scan = createIncidentDeclarationScanner();
      scan({
        type: "tool_use",
        toolUseId: "t1",
        toolName,
        toolInput: { name: "incident_incident_create", arguments: {} },
      });
      expect(
        scan({ type: "tool_result", toolUseId: "t1", content: created }),
      ).toEqual({ incidentId: ULID, reference: "INC-105" });
    },
  );

  test("records a direct call too", () => {
    const scan = createIncidentDeclarationScanner();
    scan({ type: "tool_use", toolUseId: "t2", toolName: "incident_create" });
    expect(
      scan({ type: "tool_result", toolUseId: "t2", content: created }),
    ).toEqual({ incidentId: ULID, reference: "INC-105" });
  });

  test("ignores reads, retries of an existing incident and failures", () => {
    const scan = createIncidentDeclarationScanner();
    scan({
      type: "tool_use",
      toolUseId: "r",
      toolName: "tool_call",
      toolInput: { name: "incident_incident_show" },
    });
    expect(
      scan({ type: "tool_result", toolUseId: "r", content: created }),
    ).toBeUndefined();
    scan({ type: "tool_use", toolUseId: "e", toolName: "incident_create" });
    expect(
      scan({
        type: "tool_result",
        toolUseId: "e",
        content: created.replace("{", '{"already_existed":true,'),
      }),
    ).toBeUndefined();
    scan({ type: "tool_use", toolUseId: "f", toolName: "incident_create" });
    expect(
      scan({
        type: "tool_result",
        toolUseId: "f",
        content: "validation_error: missing severity",
      }),
    ).toBeUndefined();
  });
});

describe("recordIncidentDeclaration", () => {
  const root = mkdtempSync(`${tmpdir()}/incident-declarations-test-`);
  const previousRoot = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = root;
  let store: SessionKernelStore;
  let previousStore: SessionKernelStore | undefined;
  beforeEach(() => {
    store = new SessionKernelStore(":memory:");
    previousStore = __setSessionKernelStoreForTest(store);
  });
  afterEach(() => {
    __setSessionKernelStoreForTest(previousStore);
    store.close();
  });
  afterAll(() => {
    if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  test("looks up by id or reference, and the first declarer wins", async () => {
    await recordIncidentDeclaration("os-first", {
      incidentId: ULID,
      reference: "INC-105",
    });
    await recordIncidentDeclaration("os-second", {
      incidentId: ULID,
      reference: "INC-105",
    });
    expect((await declaringSessionFor(ULID))?.sessionId).toBe("os-first");
    expect((await declaringSessionFor("#INC-105"))?.sessionId).toBe("os-first");
    expect(await declaringSessionFor("INC-999")).toBeNull();
    expect(await declaringSessionFor("nonsense")).toBeNull();
  });
});
