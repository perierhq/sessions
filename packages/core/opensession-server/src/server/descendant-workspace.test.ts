// Where an automation descendant may work: a sandbox or an isolated Runner,
// or, for an incident agent only, a host worktree whose shell runs as the
// incident agent user once that user is ready.
import { describe, expect, test } from "bun:test";
import {
  HOST_WORKTREE_MISUSE,
  PODMAN_DESCENDANT_REFUSED,
  descendantBashRunAs,
} from "./descendant-workspace";
import { assertHostAgentReady } from "./incidents/response/host-agents";
import type { AutomationDescendantPolicy } from "./types";

const ISOLATION =
  "Automation descendants require an explicit sandbox or isolation-approved Runner";
const descendant: AutomationDescendantPolicy = {
  automationId: "auto-1",
  automationName: "Incidents · acme",
  mcpServers: [],
  repo: "acme",
  publicationRepo: "acme/web",
  baseBranch: "main",
  allowedRunners: [],
  publication: "branch-pr-only",
};
const incident = {
  incidentId: "inc-1",
  role: "investigator" as const,
  signalId: null,
  accessRevision: "r1",
  spawn: { hosts: [], credentials: [], egress: null },
};
const hostAgent = {
  ...descendant,
  incident,
  hostAgentUser: "opensession-incident",
};

describe("descendant workspace", () => {
  test("an incident agent may use a host worktree as the agent user", () => {
    expect(descendantBashRunAs(hostAgent, {}, ISOLATION)).toBe(
      "opensession-incident",
    );
  });

  test("everything else still needs a sandbox or Runner", () => {
    expect(() => descendantBashRunAs(descendant, {}, ISOLATION)).toThrow(
      ISOLATION,
    );
    expect(
      descendantBashRunAs(descendant, { sandbox: "daytona" }, ISOLATION),
    ).toBeUndefined();
    expect(
      descendantBashRunAs(descendant, { runner: "mac-studio" }, ISOLATION),
    ).toBeUndefined();
    expect(() =>
      descendantBashRunAs(
        { ...descendant, hostAgentUser: "opensession-incident" },
        {},
        ISOLATION,
      ),
    ).toThrow(HOST_WORKTREE_MISUSE);
    expect(() =>
      descendantBashRunAs(hostAgent, { sandbox: "daytona" }, ISOLATION),
    ).toThrow(HOST_WORKTREE_MISUSE);
    expect(() =>
      descendantBashRunAs(hostAgent, { runner: "mac-studio" }, ISOLATION),
    ).toThrow(HOST_WORKTREE_MISUSE);
    expect(descendantBashRunAs(undefined, {}, ISOLATION)).toBeUndefined();
  });

  test("only an incident agent may run in This machine (container)", () => {
    // Checked at create before anything is written, before the opening turn
    // and before every later turn, so a podman sandbox is never ensured for
    // any other descendant.
    expect(() =>
      descendantBashRunAs(descendant, { sandbox: "podman" }, ISOLATION),
    ).toThrow(PODMAN_DESCENDANT_REFUSED);
    expect(() =>
      descendantBashRunAs(
        descendant,
        { sandbox: "podman", runner: "mac-studio" },
        ISOLATION,
      ),
    ).toThrow(PODMAN_DESCENDANT_REFUSED);
    // An incident agent works there with its bash in the container.
    expect(
      descendantBashRunAs(
        { ...descendant, incident },
        { sandbox: "podman" },
        ISOLATION,
      ),
    ).toBeUndefined();
    expect(
      descendantBashRunAs(
        { ...descendant, incident: { ...incident, role: "verifier" } },
        { sandbox: "podman" },
        ISOLATION,
      ),
    ).toBeUndefined();
    // ...but never with a host user as well.
    expect(() =>
      descendantBashRunAs(hostAgent, { sandbox: "podman" }, ISOLATION),
    ).toThrow(HOST_WORKTREE_MISUSE);
    expect(
      descendantBashRunAs(descendant, { sandbox: "daytona" }, ISOLATION),
    ).toBeUndefined();
    // A person's own session is not a descendant.
    expect(
      descendantBashRunAs(undefined, { sandbox: "podman" }, ISOLATION),
    ).toBeUndefined();
  });

  test("a binding without an incident and role is not an incident agent", () => {
    for (const forged of [
      {},
      { incidentId: "", role: "investigator" },
      { incidentId: "inc-1", role: "coordinator" },
      { incidentId: 7, role: "investigator" },
    ])
      expect(() =>
        descendantBashRunAs(
          {
            ...descendant,
            incident:
              forged as unknown as AutomationDescendantPolicy["incident"],
          },
          { sandbox: "podman" },
          ISOLATION,
        ),
      ).toThrow(PODMAN_DESCENDANT_REFUSED);
  });

  test("the host path needs the configured user, ready right now", async () => {
    await expect(
      assertHostAgentReady("opensession-incident", ISOLATION, async () => null),
    ).resolves.toBeUndefined();
    await expect(
      assertHostAgentReady(
        "opensession-incident",
        ISOLATION,
        async () => "create the system user opensession-incident",
      ),
    ).rejects.toThrow(ISOLATION);
    // A user name other than the configured one is never used.
    await expect(
      assertHostAgentReady("root", ISOLATION, async () => null),
    ).rejects.toThrow(ISOLATION);
  });
});
