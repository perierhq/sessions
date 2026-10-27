import { expect, test } from "bun:test";
import {
  agentAccessFixture,
  staticAccessEnvironment,
  useAccessTestEnv,
} from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { accessWarnings, localToolsFor, previewTools } from "./preview";

useIncidentTestKernel();
const t = useAccessTestEnv();

test("local tools follow the mode", () => {
  expect(localToolsFor("ask")).toEqual(["read", "grep", "glob", "bash"]);
  expect(localToolsFor("code")).toEqual([
    "read",
    "grep",
    "glob",
    "bash",
    "write",
    "edit",
    "patch",
  ]);
});
test("tools: mode, denials, granted access tools, connections", () => {
  expect(
    previewTools(
      agentAccessFixture({
        mode: "ask",
        connections: ["sentry"],
        deniedTools: { bash: "off" },
      }),
    ),
  ).toEqual([
    "read",
    "grep",
    "glob",
    "mcp__opensession-incident-access__describe_access",
    "mcp__opensession-incident-access__show_findings",
    "mcp__sentry__*",
  ]);
  expect(
    previewTools(
      agentAccessFixture({
        mode: "code",
        egress: { route: "server", hosts: ["search.example.test"] },
      }),
    ),
  ).toEqual([
    "read",
    "grep",
    "glob",
    "bash",
    "write",
    "edit",
    "patch",
    "mcp__opensession-incident-access__describe_access",
    "mcp__opensession-incident-access__show_findings",
    "mcp__opensession-incident-access__egress_fetch",
  ]);
});
test("warnings", () => {
  t.spec.runners.find((r) => r.id === "rn-prod")!.connected = false;
  const verifier = agentAccessFixture({
    role: "verifier",
    model: "pi/openai/gpt-6.1",
    repos: [],
    runners: ["rn-prod"],
    hosts: [{ runner: "rn-prod", runnerName: "prod-1", access: "read-only" }],
    narrowed: [
      {
        field: "connections",
        item: "logs",
        reason: "Connection is no longer available to incident agents",
      },
    ],
  });
  expect(
    accessWarnings(
      verifier,
      staticAccessEnvironment(t.spec),
      agentAccessFixture({ model: "pi/openai/gpt-6.1" }),
    ),
  ).toEqual([
    "This agent has no repo to work in",
    "Runner prod-1 is offline",
    "The verifier uses the same model as the investigator",
    "Connection is no longer available to incident agents: logs",
  ]);
  expect(
    accessWarnings(agentAccessFixture(), staticAccessEnvironment(t.spec)),
  ).toEqual([]);
});
