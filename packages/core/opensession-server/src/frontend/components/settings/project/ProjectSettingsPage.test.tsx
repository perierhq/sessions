// The project page as markup, from the contract fixtures: the checklist's
// order and its one ink button, and the access table's cells. The settings
// hooks are mocked; nothing fetches during a static render.
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import {
  BLOCKED_NO_SANDBOX,
  DEFAULTS_VIEW,
  READY_4_OF_6,
} from "../../../../shared/project-settings-fixtures";

let current: ProjectSettingsView = READY_4_OF_6;
const revalidations: Array<readonly unknown[] | undefined> = [];
mock.module("../../../hooks/useProjects", () => ({
  projectSWRKey: {
    projects: () => ["api", "projects"],
    projectSettings: (project: string) => ["api", "project-settings", project],
    projectDefaults: () => ["api", "project-defaults"],
  },
  revalidateProjects: (except?: readonly unknown[]) => {
    revalidations.push(except);
  },
  useProjectSettings: () => ({
    data: current,
    error: undefined,
    mutate: async () => current,
  }),
  useProjectDefaults: () => ({
    data: DEFAULTS_VIEW,
    error: undefined,
    mutate: async () => DEFAULTS_VIEW,
  }),
}));

const { ProjectSettingsPage } = await import("./ProjectSettingsPage");

function render(view: ProjectSettingsView): string {
  current = view;
  return renderToStaticMarkup(
    <ProjectSettingsPage project="acme-web" onOpenSection={() => {}} />,
  );
}

/** The ink button's own class (`Button` variant `primary`). */
const PRIMARY = /<button[^>]*class="[^"]*\bbg-accent\b[^"]*"[^>]*>/g;

/** The access table's markup, from its role to the end of its card. */
function accessTable(html: string): string {
  const start = html.indexOf('role="table"');
  const end = html.indexOf('id="project-incidents"');
  return html.slice(start, end);
}

describe("readiness checklist", () => {
  test("to-dos come first, then the folded ready steps", () => {
    const html = render(READY_4_OF_6);
    const rollback = html.indexOf(">Rollback<");
    const logs = html.indexOf(">Logs for agents<");
    const ready = html.indexOf(">4 ready<");
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(logs);
    expect(logs).toBeLessThan(ready);
    expect(html).toContain("Incidents for acme-web: 4 of 6 ready");
  });

  test("4 of 6: Add rollback is the one ink button on the page", () => {
    const html = render(READY_4_OF_6);
    const primaries = html.match(PRIMARY) ?? [];
    expect(primaries.length).toBe(1);
    const at = html.search(PRIMARY);
    expect(html.slice(at, at + 1200)).toContain("Add rollback");
  });

  test("blocked: Connect Daytona is the only ink button, the rest fold", () => {
    const html = render(BLOCKED_NO_SANDBOX);
    const primaries = html.match(PRIMARY) ?? [];
    expect(primaries.length).toBe(1);
    const at = html.search(PRIMARY);
    expect(html.slice(at, at + 600)).toContain("Connect Daytona");
    expect(html).toContain("Agents can&#x27;t start: no sandbox");
    expect(html).toContain(">2 more to do<");
    expect(html).toContain(">3 ready<");
    // The other to-dos are folded, so their fixes aren't on screen.
    expect(html).not.toContain(">Logs for agents<");
  });

  test("the region is a select, pre-filled", () => {
    const html = render(BLOCKED_NO_SANDBOX);
    expect(html).toContain('aria-label="Region"');
  });
});

describe("access table in the page", () => {
  test("the verifier search cell is not a button", () => {
    const table = accessTable(render(READY_4_OF_6));
    const name = "Search the web for Verifier: Not allowed";
    expect(table).toContain(name);
    const at = table.indexOf(name);
    const open = table.lastIndexOf("<", at);
    expect(table.slice(open, open + 7)).not.toBe("<button");
  });

  test("every button in the table has a 44px target", () => {
    const table = accessTable(render(READY_4_OF_6));
    const buttons = table.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) expect(button).toMatch(/min-h-11|before:/);
  });

  test("the key under the table is exact", () => {
    expect(render(READY_4_OF_6)).toContain(
      "A dash means no. Ask once: lent for one request, then asked again. Click a cell to change it",
    );
  });

  test("the Grafana row carries one warning and Allow agents", () => {
    const table = accessTable(render(READY_4_OF_6));
    const warning = "Limited to 2 people, so agents can&#x27;t open it";
    expect(table.split(warning).length - 1).toBe(1);
    expect(table).toContain(">Allow agents<");
  });
});

describe("where agents run", () => {
  test("role grid uses the role labels and the note is plain text", () => {
    const html = render(READY_4_OF_6);
    for (const label of ["You", "Reviews", "Automations", "Incident agents"])
      expect(html).toContain(`>${label}<`);
    expect(html).toContain(
      "Sessions, reviews and incident agents run here. Automations use the global default",
    );
    expect(html).toContain("Set here");
  });

  test("blocked roles read Can't start", () => {
    expect(render(BLOCKED_NO_SANDBOX)).toContain("Can&#x27;t start");
  });
});

describe("where agents run", () => {
  /** The section's markup, from its anchor to the next one. */
  const where = (html: string) =>
    html.slice(
      html.indexOf('id="project-where"'),
      html.indexOf('id="project-models"'),
    );
  const onDefault: ProjectSettingsView = {
    ...READY_4_OF_6,
    document: { ...READY_4_OF_6.document, sandbox: "default" },
    effective: {
      ...READY_4_OF_6.effective,
      sandbox: {
        ...READY_4_OF_6.effective.sandbox,
        you: {
          state: "ok",
          provider: null,
          label: "This machine",
          source: "default",
        },
      },
    },
  };

  test("a sandbox on the default says so once, in its select", () => {
    const html = where(render(onDefault));
    expect(html).not.toContain(">Default<");
  });

  test("every place that can run reads one mark, the check", () => {
    const html = where(render(onDefault));
    // IconReturn draws the old fallback arrow; it said nothing the check
    // and the screen-reader note don't.
    expect(html).not.toContain("M17.25 8.25V10.5");
    expect(html).toContain(", from the global default");
  });
});

describe("where agents run on a provider that isn't set up", () => {
  const where = (html: string) =>
    html.slice(
      html.indexOf('id="project-where"'),
      html.indexOf('id="project-models"'),
    );
  const modal = {
    state: "not-ready",
    provider: "modal",
    label: "Modal",
    source: "project",
    reason: "Modal isn't connected",
  } as const;
  const unconnected: ProjectSettingsView = {
    ...READY_4_OF_6,
    document: { ...READY_4_OF_6.document, sandbox: "modal:T4" },
    effective: {
      ...READY_4_OF_6.effective,
      sandbox: {
        ...READY_4_OF_6.effective.sandbox,
        you: { ...modal, label: "Modal · T4 GPU" },
        incidentAgents: modal,
        support: modal,
        note: "Modal isn't connected, so sessions, incident agents and Support can't start",
      },
    },
  };

  test("each role on it reads the reason, never a check", () => {
    const html = where(render(unconnected));
    expect(html.split("Modal isn&#x27;t connected<").length - 1).toBe(3);
    // Reviews and automations stay on this machine: two checks, no more.
    expect(html.split('d="M5.75 12.75L9.5 16.25L18.25 7.75"').length - 1).toBe(
      2,
    );
  });

  test("one button opens the sandbox settings, with a 44px target on a phone", () => {
    const html = where(render(unconnected));
    const button = html.match(
      /<button[^>]*>(?:(?!<\/button>).)*Open sandbox settings(?:(?!<\/button>).)*<\/button>/s,
    );
    expect(button?.[0]).toContain("phone:min-h-11");
    expect(html.split("Open sandbox settings").length - 1).toBe(1);
  });

  test("a project whose places are ready shows no such button", () => {
    expect(where(render(READY_4_OF_6))).not.toContain("Open sandbox settings");
  });
});

describe("git access", () => {
  test("a project whose fetches can't sign in says so at the top", () => {
    const html = render({
      ...READY_4_OF_6,
      gitAccess: {
        kind: "auth",
        since: "2026-10-25T21:39:00.000Z",
        lastError: "remote: Invalid username or token.",
        failures: 4,
        nextAttemptAt: "2026-10-25T22:59:00.000Z",
      },
    });
    const notice = html.indexOf("Git can&#x27;t sign in to GitHub");
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf("Incidents for acme-web"));
    expect(html).toContain("remote: Invalid username or token.");
  });

  test("a project the server has no token for names the missing App", () => {
    const html = render({
      ...READY_4_OF_6,
      gitAccess: {
        kind: "not-installed",
        ghRepo: "acme/app",
        since: "2026-10-25T21:39:00.000Z",
        lastError:
          "fatal: could not read Username for 'https://github.com': No such device or address",
        failures: 1,
        nextAttemptAt: "2026-10-25T21:44:00.000Z",
      },
    });
    expect(html).toContain("The GitHub App isn&#x27;t installed for acme/app");
    expect(html).toContain("Install the GitHub App on acme");
    expect(html).not.toContain("refused the project&#x27;s credential");
  });

  test("a healthy project shows no notice", () => {
    expect(render(READY_4_OF_6)).not.toContain("sign in to GitHub");
  });
});
