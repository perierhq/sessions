import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FindingBlock, FindingsSet } from "../../../shared/findings";
import type { IncidentResponse } from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type { IncidentCauseView } from "../../lib/incidents/cause";
import { FindingsSection } from "./FindingsSection";
import { IncidentCause } from "./IncidentCause";

// MarkdownBody reads the theme preference on its first render; a stored
// "dark" answers it without a window.
if (!globalThis.localStorage)
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => "dark",
      setItem: () => {},
      removeItem: () => {},
    },
  });

const T = (hm: string) => `2026-10-27T${hm}:00.000Z`;

const cause: IncidentCauseView = {
  text: "The acme pool is too small",
  status: "unverified",
};

const block = (
  id: string,
  title: string,
  size: "full" | "half" = "full",
): FindingBlock => ({ id, kind: "timeline", title, size, events: [] });

const question = (id: string, text: string): FindingBlock => ({
  id,
  kind: "question",
  size: "full",
  text,
  wouldAnswer: "",
});

const set = (
  round: number,
  blocks: FindingBlock[],
  role: FindingsSet["role"] = "investigator",
): FindingsSet => ({
  role,
  round,
  attempt: 1,
  sessionId: role === "investigator" ? "os-inv" : "os-ver",
  source: "tool",
  updatedAt: T("12:15"),
  calls: 1,
  blocks,
  notes: [],
});

const response = (over: Partial<IncidentResponse> = {}): IncidentResponse => ({
  phase: "investigating",
  round: 1,
  maxRounds: 3,
  agents: [],
  actionRuns: [],
  costUsd: 0,
  ownerTouched: false,
  next: { kind: "working", detail: "" },
  ledger: [],
  droppedLedger: 0,
  startedAt: T("12:00"),
  updatedAt: T("12:00"),
  ...over,
});

const incident = (r: IncidentResponse | undefined): Incident => {
  const value: Incident = {
    id: "inc-1",
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: T("12:00"),
    updatedAt: T("12:15"),
    lastProblemAt: T("12:15"),
    findings: [],
    events: [],
    droppedEvents: 0,
  };
  if (r) value.response = r;
  return value;
};

const render = (inc: Incident) =>
  renderToStaticMarkup(
    <FindingsSection
      incident={inc}
      cause={cause}
      waiting
      meta={() => ({ kind: "passfail", label: "", format: String })}
      signalName={(id) => id}
      onOpenSession={() => {}}
      onOpenPr={() => {}}
    />,
  );

test("no findings shows the Cause view exactly as today", () => {
  const today = renderToStaticMarkup(<IncidentCause cause={cause} waiting />);
  expect(render(incident(undefined))).toBe(today);
  expect(render(incident(response()))).toBe(today);
  expect(render(incident(response({ findingSets: [set(1, [])] })))).toBe(today);
});

test("findings take Cause's place", () => {
  const html = render(
    incident(
      response({
        findingSets: [
          set(1, [block("a", "First block"), block("b", "Second block")]),
          set(1, [block("c", "Verifier block")], "verifier"),
        ],
      }),
    ),
  );
  expect(html).toContain(">Findings</h2>");
  expect(html).not.toContain(">Cause<");
  const first = html.indexOf("First block");
  const second = html.indexOf("Second block");
  const third = html.indexOf("Verifier block");
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  expect(third).toBeGreaterThan(second);
  expect(html).toContain("from the verifier, ");
});

test("the round under way is said quietly", () => {
  const html = render(
    incident(
      response({
        round: 2,
        findingSets: [set(1, [block("a", "First block")])],
      }),
    ),
  );
  expect(html).toContain("Round 2 under way");
  expect(html).toContain("First block");
});

test("half blocks pair on desktop, everything stacks on phone", () => {
  const html = render(
    incident(
      response({
        findingSets: [
          set(1, [
            block("a", "Half one", "half"),
            block("b", "Half two", "half"),
            block("c", "Full", "full"),
            block("d", "Lone half", "half"),
          ]),
        ],
      }),
    ),
  );
  // One column below the desktop width; the grid's two columns are
  // desktop-only, and no CSS order moves a block away from its DOM place.
  expect(html).toContain("grid-cols-1");
  expect(html).toContain("desktop:grid-cols-2");
  expect(html).not.toMatch(/\border-/);
  const spans = [...html.matchAll(/desktop:col-span-(\d)/g)].map((m) => m[1]);
  expect(spans).toEqual(["1", "1", "2", "2"]);
  const order = ["Half one", "Half two", "Full", "Lone half"].map((t) =>
    html.indexOf(t),
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("an open incident's questions go to the Next card, a closed one's stay", () => {
  const r = response({
    findingSets: [
      set(1, [
        block("a", "Timeline"),
        question("q", "Who restores billing for acme?"),
      ]),
    ],
  });
  const open = render(incident(r));
  expect(open).toContain("Timeline");
  expect(open).not.toContain("Who restores billing for acme?");
  const closed = render({ ...incident(r), state: "closed-without-action" });
  expect(closed).toContain("Who restores billing for acme?");
});
