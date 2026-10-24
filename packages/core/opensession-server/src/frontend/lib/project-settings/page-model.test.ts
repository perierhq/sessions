import { describe, expect, test } from "bun:test";
import {
  ALL_READY,
  BLOCKED_NO_SANDBOX,
  READY_4_OF_6,
} from "../../../shared/project-settings-fixtures";
import type { AccessCellView } from "../../../shared/project-settings";
import {
  applyIncidentsPatch,
  PROJECT_SECTIONS,
  applyCellChange,
  rowSummary,
  cellLabel,
  cellSpokenLabel,
  checklistModel,
  joinDots,
  modelChip,
  monthSpendCopy,
  nextCellValue,
  sandboxRowCopy,
  stepSummary,
} from "./page-model";

const cell = (value: AccessCellView["value"], editable = true) => ({
  value,
  editable,
});

describe("checklistModel", () => {
  test("4 of 6: to-dos first, ready steps collapsed, rollback is the primary", () => {
    const m = checklistModel(READY_4_OF_6.readiness, "acme-web");
    expect(m.title).toBe("Incidents for acme-web: 4 of 6 ready");
    expect(m.rows.length).toBe(2);
    expect(m.rows[0]!.title).toBe("Rollback");
    expect(m.rows[1]!.title).toBe("Logs for agents");
    expect(m.collapsedReady.length).toBe(4);
    expect(m.collapsedTodo.length).toBe(0);
    expect(m.primary?.id).toBe("deploy");
    expect(m.segments).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "todo",
      "todo",
    ]);
  });

  test("blocked: only the blocking step shows, the other to-dos collapse", () => {
    const m = checklistModel(BLOCKED_NO_SANDBOX.readiness, "acme-web");
    expect(m.title).toBe("Agents can't start: no sandbox");
    expect(m.subtitle).toBe("Incidents for acme-web: 3 of 6 ready");
    expect(m.rows.length).toBe(1);
    expect(m.rows[0]!.id).toBe("where");
    expect(m.collapsedTodo.length).toBe(2);
    expect(m.collapsedReady.length).toBe(3);
    expect(m.primary?.id).toBe("where");
    // The red segment sits in the step's own position (fable #20).
    expect(m.segments[1]).toBe("blocked");
    expect(m.segments.filter((s) => s === "blocked").length).toBe(1);
  });

  test("all ready is one line", () => {
    const m = checklistModel(ALL_READY.readiness, "acme-web");
    expect(m.title).toBe("Incidents for acme-web: ready");
    expect(m.rows).toEqual([]);
    expect(m.primary).toBeNull();
    expect(m.collapsedReady.length).toBe(6);
    expect(m.segments.every((s) => s === "ready")).toBe(true);
  });

  test("paused blocks without being a segment", () => {
    const paused = {
      id: "paused" as const,
      state: "blocked" as const,
      title: "Agents are paused",
      detail: "Pause all agents is on",
      fix: { kind: "unpause" as const },
    };
    const m = checklistModel(
      {
        ...READY_4_OF_6.readiness,
        steps: [paused, ...READY_4_OF_6.readiness.steps],
        blocking: paused,
      },
      "acme-web",
    );
    expect(m.title).toBe("Agents are paused");
    expect(m.rows).toEqual([paused]);
    expect(m.collapsedTodo.length).toBe(2);
    expect(m.segments.length).toBe(6);
    expect(m.segments.includes("blocked")).toBe(false);
  });
});

describe("stepSummary", () => {
  test("joins titles in sentence case", () => {
    const m = checklistModel(READY_4_OF_6.readiness, "acme-web");
    expect(stepSummary(m.collapsedReady)).toBe(
      "Models, where agents run, production, signals",
    );
    const b = checklistModel(BLOCKED_NO_SANDBOX.readiness, "acme-web");
    expect(stepSummary(b.collapsedTodo)).toBe("Rollback, logs for agents");
  });
});

describe("cell labels", () => {
  test("visual labels", () => {
    expect(cellLabel("yes")).toBe("✓");
    expect(cellLabel("no")).toBe("–");
    expect(cellLabel("blocked")).toBe("–");
    expect(cellLabel("branch")).toBe("Branch");
    expect(cellLabel("read")).toBe("Read only");
    expect(cellLabel("ask-once")).toBe("Ask once");
    expect(cellLabel("ask-each")).toBe("Ask each time");
    expect(cellLabel("standing")).toBe("Always");
  });

  test("spoken labels never use symbols", () => {
    expect(cellSpokenLabel("yes")).toBe("Yes");
    expect(cellSpokenLabel("no")).toBe("No");
    expect(cellSpokenLabel("locked")).toBe("Not allowed");
    expect(cellSpokenLabel("blocked")).toBe("Blocked");
    expect(cellSpokenLabel("ask-once")).toBe("Ask once");
    expect(cellSpokenLabel("elsewhere", "Set per automation")).toBe(
      "Set per automation",
    );
    expect(cellLabel("elsewhere", "Set per automation")).toBe(
      "Set per automation",
    );
  });
});

describe("nextCellValue", () => {
  const cred = { kind: "credential" as const, credential: "cred-cloudflare" };

  test("verifier credential cycles no → ask once → always → no", () => {
    const a = nextCellValue(cred, "verifier", cell("no"));
    expect(a).toEqual({ row: cred, role: "verifier", value: "once" });
    const b = nextCellValue(cred, "verifier", cell("ask-once"));
    expect(b?.value).toBe("standing");
    const c = nextCellValue(cred, "verifier", cell("standing"));
    expect(c?.value).toBeNull();
  });

  test("credentials never cycle for automations or reviews", () => {
    expect(nextCellValue(cred, "automations", cell("no"))).toBeNull();
    expect(nextCellValue(cred, "reviews", cell("no"))).toBeNull();
  });

  test("verifier web search returns null", () => {
    expect(
      nextCellValue({ kind: "webSearch" }, "verifier", cell("no")),
    ).toBeNull();
    expect(
      nextCellValue({ kind: "webSearch" }, "verifier", cell("locked", false)),
    ).toBeNull();
  });

  test("booleans toggle, a blocked tick unticks", () => {
    const linear = { kind: "connection" as const, server: "linear" };
    expect(nextCellValue(linear, "reviews", cell("yes"))?.value).toBe(false);
    expect(nextCellValue(linear, "verifier", cell("no"))?.value).toBe(true);
    expect(nextCellValue(linear, "verifier", cell("blocked"))?.value).toBe(
      false,
    );
    expect(
      nextCellValue({ kind: "webSearch" }, "reviews", cell("no"))?.value,
    ).toBe(true);
  });

  test("mode switches between code and read only", () => {
    const mode = { kind: "mode" as const };
    expect(nextCellValue(mode, "verifier", cell("read"))?.value).toBe("code");
    expect(nextCellValue(mode, "investigator", cell("branch"))?.value).toBe(
      "ask",
    );
    expect(nextCellValue(mode, "automations", cell("yes"))?.value).toBe("ask");
  });

  test("hosts are incident-only", () => {
    const host = { kind: "host" as const, runner: "rn-prod-eu-1" };
    expect(nextCellValue(host, "automations", cell("no"))).toBeNull();
    expect(nextCellValue(host, "verifier", cell("yes"))?.value).toBe(false);
  });

  test("a non-editable cell returns null", () => {
    expect(
      nextCellValue(
        { kind: "website", host: "*" },
        "automations",
        cell("locked", false),
      ),
    ).toBeNull();
  });
});

describe("chips and copy", () => {
  test("modelChip", () => {
    expect(modelChip("default")).toBe("Default");
    expect(modelChip("project")).toBe("Set here");
  });

  test("sandboxRowCopy for the podman project", () => {
    const c = sandboxRowCopy(READY_4_OF_6.effective.sandbox);
    expect(c.chip).toBe("Set here");
    expect(c.description).toBe(
      "Every run uses this when it can. Global default is Daytona eu",
    );
  });

  test("sandboxRowCopy with nothing to fall back to", () => {
    const c = sandboxRowCopy(BLOCKED_NO_SANDBOX.effective.sandbox);
    expect(c.chip).toBe("Set here");
    expect(c.description).toBe(
      "Every run uses this when it can. No global default is set",
    );
  });

  test("sandboxRowCopy on the default", () => {
    const e = {
      ...ALL_READY.effective.sandbox,
      you: { ...ALL_READY.effective.sandbox.you, source: "default" as const },
    };
    const c = sandboxRowCopy(e);
    expect(c.chip).toBe("Default");
    expect(c.description).toBe("Uses the global default, Daytona eu");
  });

  test("sections in page order", () => {
    expect(PROJECT_SECTIONS.map(([id]) => id)).toEqual([
      "where",
      "models",
      "production",
      "access",
      "incidents",
    ]);
  });
});

describe("optimistic cells", () => {
  const find = (view: typeof READY_4_OF_6, title: string) =>
    view.access.groups.flatMap((g) => g.rows).find((r) => r.title === title)!;

  test("unticking Linear for reviews reads – before the server answers", () => {
    const next = applyCellChange(READY_4_OF_6, {
      row: { kind: "connection", server: "linear" },
      role: "reviews",
      value: false,
    });
    expect(find(next, "Linear").cells.reviews.value).toBe("no");
    expect(find(READY_4_OF_6, "Linear").cells.reviews.value).toBe("yes");
    expect(find(next, "Sentry").cells.reviews.value).toBe("yes");
  });

  test("ticking a blocked connector stays blocked", () => {
    const off = applyCellChange(READY_4_OF_6, {
      row: { kind: "connection", server: "grafana" },
      role: "reviews",
      value: false,
    });
    const on = applyCellChange(off, {
      row: { kind: "connection", server: "grafana" },
      role: "reviews",
      value: true,
    });
    expect(find(on, "Grafana").cells.reviews.value).toBe("blocked");
  });

  test("mode and credential values map to their cells", () => {
    const code = applyCellChange(READY_4_OF_6, {
      row: { kind: "mode" },
      role: "verifier",
      value: "code",
    });
    expect(find(code, "Changes code in acme-web").cells.verifier.value).toBe(
      "branch",
    );
    const always = applyCellChange(READY_4_OF_6, {
      row: { kind: "credential", credential: "cred-cloudflare" },
      role: "investigator",
      value: "standing",
    });
    expect(find(always, "Cloudflare token").cells.investigator.value).toBe(
      "standing",
    );
  });

  test("rowSummary counts the roles a row is on for", () => {
    expect(rowSummary(find(READY_4_OF_6, "Linear"))).toBe("4 of 5 roles");
    expect(rowSummary(find(READY_4_OF_6, "Sentry"))).toBe("Every role");
    expect(rowSummary(find(READY_4_OF_6, "Grafana"))).toBe("1 of 5 roles");
  });

  test("rowSummary counts only the roles that change code on the mode row", () => {
    // You and the investigator (Branch); the verifier's Read only doesn't.
    const mode = find(READY_4_OF_6, "Changes code in acme-web");
    expect(rowSummary(mode)).toBe("2 of 5 roles");
  });
});

describe("applyIncidentsPatch", () => {
  test("lays scalar fields over the stored policy and clears the night rule", () => {
    const night = { start: "23:00", end: "07:00", timeZone: "UTC" };
    const base = {
      ...READY_4_OF_6,
      document: {
        ...READY_4_OF_6.document,
        incidents: { ...READY_4_OF_6.document.incidents, night },
      },
    };
    const paused = applyIncidentsPatch(base, { agentsPaused: true });
    expect(paused.document.incidents.agentsPaused).toBe(true);
    expect(paused.document.incidents.night).toEqual(night);
    const cleared = applyIncidentsPatch(base, { night: null });
    expect(cleared.document.incidents.night).toBeUndefined();
    expect(base.document.incidents.night).toEqual(night);
  });
});

describe("joinDots", () => {
  test("a middle dot never starts or ends a line", () => {
    expect(joinDots("This machine · container")).toBe(
      "This machine\u00a0·\u00a0container",
    );
    expect(joinDots("Daytona")).toBe("Daytona");
  });
});

describe("monthSpendCopy", () => {
  test("groups thousands", () => {
    expect(monthSpendCopy(1234.5, new Date(2026, 9, 3))).toBe(
      "$1,234.50 spent in October",
    );
  });
});
