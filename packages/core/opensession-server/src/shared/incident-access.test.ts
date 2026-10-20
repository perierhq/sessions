import { describe, expect, test } from "bun:test";
import {
  defaultIncidentAccessSettings,
  defaultRoleProfile,
  egressRouteKey,
  grantModeWithin,
  hostGrantKey,
  isIncidentAgentRole,
  modeWithin,
} from "./incident-access";

describe("incident access wire types", () => {
  test("roles and orderings", () => {
    expect(isIncidentAgentRole("verifier")).toBe(true);
    expect(isIncidentAgentRole("responder")).toBe(false);
    expect(modeWithin("ask", "code")).toBe(true);
    expect(modeWithin("code", "ask")).toBe(false);
    expect(grantModeWithin("once", "standing")).toBe(true);
    expect(grantModeWithin("standing", "once")).toBe(false);
  });
  test("keys", () => {
    expect(hostGrantKey({ runner: "rn-prod" })).toBe("rn-prod");
    expect(hostGrantKey({ runner: "rn-prod", ssh: "db-1" })).toBe(
      "rn-prod>db-1",
    );
    expect(egressRouteKey({ route: "server" })).toBe("server");
    expect(egressRouteKey({ route: "runner", runner: "rn-prod" })).toBe(
      "runner:rn-prod",
    );
    expect(
      egressRouteKey({ route: "proxy", url: "http://proxy.example.test:8080" }),
    ).toBe("proxy:http://proxy.example.test:8080");
  });
  test("defaults: investigator codes in the project repo, verifier reads, server egress only", () => {
    const s = defaultIncidentAccessSettings("acme", "2026-10-20T10:00:00.000Z");
    expect(s).toMatchObject({
      project: "acme",
      revision: 0,
      overrides: [],
      updatedBy: "sessions",
      grants: {
        connections: [],
        repos: ["acme"],
        runners: [],
        hosts: [],
        credentials: [],
        egress: [{ route: "server" }],
        maxMode: "code",
      },
    });
    expect(s.profiles.investigator).toEqual(
      defaultRoleProfile("investigator", "acme"),
    );
    expect(s.profiles.investigator.mode).toBe("code");
    expect(s.profiles.verifier).toEqual({
      ...defaultRoleProfile("investigator", "acme"),
      mode: "ask",
    });
  });
});
