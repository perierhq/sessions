import { expect, test } from "bun:test";
import type {
  AgentRun,
  DeadlineWindow,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { clockTime } from "../time";
import {
  DOT_BG,
  SIGNAL_RANK,
  agentsWorking,
  incidentDot,
  incidentStateWord,
  signalDotTone,
  signalStateWord,
} from "./tone";

interface ResponseFixture {
  agents: Array<Pick<AgentRun, "status">>;
  round?: number;
  veto?: DeadlineWindow;
}
// SAFETY: tone reads response.agents[].status, response.round and
// response.veto only; the rest of the response is irrelevant here.
const response = (r: ResponseFixture) =>
  ({ response: r as never }) satisfies Pick<Incident, "response">;
const working = response({ agents: [{ status: "running" }], round: 3 });

test("dots", () => {
  expect(incidentDot({ state: "investigating" }, "failing")).toEqual({
    tone: "red",
    pulse: false,
  });
  expect(
    incidentDot({ state: "investigating", ...working }, "failing"),
  ).toEqual({ tone: "yellow", pulse: true });
  expect(incidentDot({ state: "waiting-on-provider" }, "failing")).toEqual({
    tone: "faint",
    pulse: false,
  });
  expect(incidentDot({ state: "resolved", ...working }, "failing")).toEqual({
    tone: "green",
    pulse: false,
  });
  expect(incidentDot({ state: "closed-without-action" }, "failing")).toEqual({
    tone: "faint",
    pulse: false,
  });
  expect(incidentDot({ state: "veto" }, "failing").tone).toBe("red");
  expect(incidentDot({ state: "heads-up" }, null)).toEqual({
    tone: "faint",
    pulse: false,
  });
  expect(signalDotTone("flaky")).toBe("yellow");
  expect(signalDotTone("upcoming")).toBe("yellow");
  expect(signalDotTone("external")).toBe("faint");
  expect(signalDotTone("unknown")).toBe("faint");
  expect(signalDotTone("ok")).toBe("green");
  expect(DOT_BG.faint).toBe("bg-faint");
  expect(DOT_BG.red).toBe("bg-red");
});

test("agents are working only while one runs", () => {
  expect(agentsWorking(undefined)).toBe(false);
  expect(agentsWorking(working.response)).toBe(true);
  expect(
    agentsWorking(response({ agents: [{ status: "done" }] }).response),
  ).toBe(false);
});

test("sidebar words", () => {
  const veto = response({
    agents: [],
    veto: {
      startedAt: "2026-10-20T12:27:00Z",
      deadline: "2026-10-20T12:37:00Z",
    },
  });
  expect(incidentStateWord({ state: "veto", ...veto }).text).toBe(
    `deploys ${clockTime("2026-10-20T12:37:00Z")}`,
  );
  expect(incidentStateWord({ state: "veto" }).text).toBe("veto");
  expect(incidentStateWord({ state: "investigating", ...working }).text).toBe(
    "round 3",
  );
  expect(incidentStateWord({ state: "investigating" }).text).toBe(
    "investigating",
  );
  expect(incidentStateWord({ state: "needs-you" })).toEqual({
    text: "needs you",
    tone: "info",
  });
  expect(incidentStateWord({ state: "resolved" })).toEqual({
    text: "fixed",
    tone: "faint",
  });
  expect(incidentStateWord({ state: "waiting-on-provider" }).text).toBe(
    "not us",
  );
  expect(incidentStateWord({ state: "watching" }).text).toBe("watching");
  expect(incidentStateWord({ state: "closed-without-action" }).text).toBe(
    "closed",
  );
});

test("signal words and rank", () => {
  expect(signalStateWord("upcoming")).toBe("due soon");
  expect(signalStateWord("external")).toBe("provider");
  expect(signalStateWord("unknown")).toBe("no data");
  expect(SIGNAL_RANK.failing).toBeLessThan(SIGNAL_RANK.slow);
  expect(SIGNAL_RANK.slow).toBeLessThan(SIGNAL_RANK.external);
  expect(SIGNAL_RANK.external).toBeLessThan(SIGNAL_RANK.flaky);
  expect(SIGNAL_RANK.flaky).toBeLessThan(SIGNAL_RANK.upcoming);
  expect(SIGNAL_RANK.upcoming).toBeLessThan(SIGNAL_RANK.unknown);
  expect(SIGNAL_RANK.unknown).toBeLessThan(SIGNAL_RANK.ok);
});
