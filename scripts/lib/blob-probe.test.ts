/**
 * The probe's parsing and checks against fixtures shaped like the server's
 * answers (routes/supervisor.ts, supervisor-brief.ts, transcript-watch.ts).
 * No network: scripts/blob-probe.ts is the only part that talks to a server.
 */
import { describe, expect, test } from "bun:test";
import {
  answerOutcome,
  assertReadOnlyMethod,
  briefDecisions,
  briefSummary,
  checkAnswer,
  checkBriefAfterDone,
  checkHistory,
  checkOpen,
  checkTalk,
  deliveryOutcome,
  errorMessage,
  exchanges,
  glossaryCount,
  historyFoundEarlier,
  OUTBOX_MISSING_WINDOW_MS,
  outboxBackoffMs,
  outboxNext,
  ownerFromStatus,
  parseAuthStatus,
  parseBriefResponse,
  parseEnsure,
  parseHistoryPage,
  parseItem,
  parseProbeArgs,
  planRun,
  prependPage,
  probeToken,
  promptBody,
  renderBrief,
  serverBase,
  SessionStream,
  socketUrl,
  splitReply,
  staleRevision,
  TalkTurn,
  talkResult,
  timezoneToSet,
  type HistoryRead,
  type PastExchange,
  type ProbeOptions,
} from "./blob-probe";

const SESSION = "sess-1";

/** A brief as GET /api/supervisor/brief answers it, with the variations
 *  the tests need. */
function briefFixture(
  variant: {
    seenAt?: number;
    reopen?: string;
    briefReopen?: { line: string };
    noDecisions?: boolean;
    noRevision?: boolean;
  } = {},
) {
  return {
    state: "ready",
    reopen: variant.reopen,
    brief: {
      day: "2026-11-12",
      asOf: 1_700_000_000_123.4,
      say: "Morning. One thing needs you.",
      seenAt: variant.seenAt ?? null,
      reopen: variant.briefReopen,
      handled: [{ line: "Closed the flaky test alert" }, { line: "  " }],
      decisions: variant.noDecisions
        ? []
        : [
            {
              itemId: "a",
              recommended: "Keep it",
              item: {
                id: "a",
                kind: "needs-you",
                title: "Raise the alert threshold?",
                body: "It fired six times.",
                options: ["Raise to 8", "Keep it", null, " "],
                state: "open",
                updatedAt: variant.noRevision ? undefined : 1_700_000_000_000,
                act: {
                  steps: ["Change the check", 4],
                  runsWhen: "PR #5 merges",
                },
              },
            },
            { itemId: "b", item: { id: "b" } },
          ],
      later: { count: 3, itemIds: [] },
    },
    newSince: { count: 1, itemIds: ["c"] },
    preparingSince: null,
    refreshAt: 0,
    fallback: null,
  };
}

/** Parsed options, or the test fails on the parse error. */
function options(argv: string[]): ProbeOptions {
  const parsed = parseProbeArgs(argv);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("options", () => {
  test("defaults to every scenario, or the read-only ones for the owner", () => {
    const all = options([]);
    expect(all.scenarios).toEqual([
      "open",
      "talk",
      "history",
      "brief-lifecycle",
      "answer",
    ]);
    const owner = options(["--owner-read-only"]);
    expect(owner.scenarios).toEqual(["open", "history"]);
  });

  test("takes named scenarios, comma lists and flags", () => {
    const parsed = options([
      "talk,history",
      "talk",
      "--message",
      "hi",
      "--item",
      "x1",
      "--reply-timeout",
      "30",
    ]);
    expect(parsed.scenarios).toEqual(["talk", "history"]);
    expect(parsed.message).toBe("hi");
    expect(parsed.item).toBe("x1");
    expect(parsed.replyTimeoutMs).toBe(30_000);
    expect(parsed.allowAnswer).toBe(false);
    expect(options(["answer", "--allow-answer"]).allowAnswer).toBe(true);
  });

  test("--allow-answer never goes with --owner-read-only", () => {
    expect(
      "error" in parseProbeArgs(["--owner-read-only", "--allow-answer"]),
    ).toBe(true);
  });

  test("rejects unknown scenarios, options and bad values", () => {
    expect(parseProbeArgs(["chat"])).toEqual({
      error: "unknown scenario chat",
    });
    expect(parseProbeArgs(["--force"])).toEqual({
      error: "unknown option --force",
    });
    expect("error" in parseProbeArgs(["--brief-timeout", "soon"])).toBe(true);
    expect("error" in parseProbeArgs(["--message"])).toBe(true);
  });
});

describe("server and token", () => {
  test("base URL and socket URL", () => {
    expect(serverBase("https://sessions.example.test/")).toBe(
      "https://sessions.example.test",
    );
    expect(serverBase("")).toEqual({ error: "OPENSESSION_URL is not set" });
    expect(serverBase("ftp://example.test")).toEqual({
      error: "OPENSESSION_URL must be http or https",
    });
    expect(socketUrl("https://sessions.example.test")).toBe(
      "wss://sessions.example.test/ws",
    );
    expect(socketUrl("http://127.0.0.1:3850")).toBe("ws://127.0.0.1:3850/ws");
  });

  test("token from a bare value, a Bearer header or a cookie", () => {
    expect(probeToken("abc123")).toBe("abc123");
    expect(probeToken("Bearer abc123")).toBe("abc123");
    expect(probeToken("theme=dark; opensession_auth=abc123; x=1")).toBe(
      "abc123",
    );
    expect(probeToken(" ")).toBeNull();
    expect(probeToken("two words")).toBeNull();
  });

  test("auth status", () => {
    expect(
      parseAuthStatus({
        required: true,
        authenticated: true,
        login: "blob-probe",
        name: "Blob Probe",
      }),
    ).toEqual({ login: "blob-probe", name: "Blob Probe" });
    expect("error" in parseAuthStatus({ required: false })).toBe(true);
    expect(parseAuthStatus({ required: true, authenticated: false })).toEqual({
      error: "the token does not sign in (expired or revoked)",
    });
  });
});

describe("responses", () => {
  test("ensure: session and earlier sessions", () => {
    expect(
      parseEnsure({
        sessionId: "s2",
        previousSessionIds: ["s1", 3, ""],
        session: { effort: "high", speed: "" },
      }),
    ).toEqual({ sessionId: "s2", previousSessionIds: ["s1"] });
    expect(parseEnsure({ sessionId: "s2" })?.previousSessionIds).toEqual([]);
    expect(parseEnsure({ error: "missing user" })).toBeNull();
  });

  test("glossary and error bodies", () => {
    expect(glossaryCount({ terms: ["Acme", "BetterBahn"] })).toBe(2);
    expect(glossaryCount({ terms: "x" })).toBeNull();
    expect(errorMessage({ error: "changed" })).toBe("changed");
    expect(errorMessage(null)).toBe("");
  });
});

describe("owner gate", () => {
  test("reads the owner-only route's status", () => {
    expect(ownerFromStatus(200)).toBe("owner");
    expect(ownerFromStatus(403)).toBe("member");
    expect(ownerFromStatus(404)).toBe("unknown");
  });

  test("refuses the owner, and anyone unknown, without --owner-read-only", () => {
    const asked = options(["open"]);
    expect("refuse" in planRun("owner", asked)).toBe(true);
    expect("refuse" in planRun("unknown", asked)).toBe(true);
    expect(planRun("member", asked)).toEqual({ run: ["open"], skipped: [] });
  });

  test("read-only allows GET and throws on anything else", () => {
    expect(() => assertReadOnlyMethod("GET", true)).not.toThrow();
    expect(() => assertReadOnlyMethod("get", true)).not.toThrow();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"])
      expect(() => assertReadOnlyMethod(method, true)).toThrow(
        `read-only: refusing ${method.toUpperCase()}`,
      );
    expect(() => assertReadOnlyMethod("POST", false)).not.toThrow();
  });

  test("with --owner-read-only, runs only open and history", () => {
    const plan = planRun("owner", {
      scenarios: ["open", "talk", "history", "answer"],
      ownerReadOnly: true,
    });
    expect(plan).toEqual({
      run: ["open", "history"],
      skipped: ["talk", "answer"],
    });
  });
});

describe("items and the brief", () => {
  test("items decode tolerantly, like OS1API.SupervisorItem", () => {
    expect(parseItem({ id: "x" })).toBeNull();
    const item = parseItem({ id: "x", title: "T", revision: 5, updatedAt: 9 });
    expect(item?.revision).toBe(5);
    expect(item?.kind).toBe("fyi");
    expect(parseItem({ id: "x", title: "T", revision: -1 })?.revision).toBe(
      null,
    );
    expect(parseItem({ id: "x", title: "T", updatedAt: 1.5 })?.revision).toBe(
      null,
    );
  });

  test("the brief: decisions with an item only, options cleaned, recommended first", () => {
    const response = parseBriefResponse(briefFixture());
    expect(response.state).toBe("ready");
    expect(response.brief?.decisions).toHaveLength(1);
    expect(response.brief?.handled).toEqual(["Closed the flaky test alert"]);
    expect(response.brief?.laterCount).toBe(3);
    expect(response.newSince).toEqual(["c"]);
    const [decision] = briefDecisions(response.brief!);
    expect(decision!.options).toEqual(["Keep it", "Raise to 8"]);
    expect(decision!.steps).toEqual(["Change the check"]);
    expect(decision!.revision).toBe(1_700_000_000_000);
    expect(briefSummary(response.brief!)).toBe(
      "Handled 1 thing \u00B7 3 can wait",
    );
  });

  test("an unknown state reads as none; the reopen line is read where it is", () => {
    expect(parseBriefResponse({ state: "odd" }).state).toBe("none");
    expect(
      parseBriefResponse(briefFixture({ reopen: "Your brief" })).reopen,
    ).toBe("Your brief");
    expect(
      parseBriefResponse(briefFixture({ briefReopen: { line: "Open brief" } }))
        .reopen,
    ).toBe("Open brief");
  });

  test("renders what Blob shows", () => {
    const lines = renderBrief(
      parseBriefResponse(briefFixture({ reopen: "Back to the brief" })),
    );
    expect(lines).toContain("Blob says: Morning. One thing needs you.");
    expect(lines).toContain(
      "decision 1: Raise the alert threshold? [a rev 1700000000000]",
    );
    expect(lines).toContain("    \u25B8 Keep it");
    expect(lines).toContain("reopen: Back to the brief");
    expect(renderBrief(parseBriefResponse({ state: "preparing" }))).toEqual([
      "Blob thinks: Putting your brief together.",
    ]);
  });
});

describe("open check", () => {
  test("passes a ready brief", () => {
    const verdict = checkOpen(parseBriefResponse(briefFixture()), false);
    expect(verdict.status).toBe("PASS");
    expect(verdict.reason).toContain("1 open decision");
  });

  test("fails a brief still preparing, none, or a decision without a revision", () => {
    expect(
      checkOpen(parseBriefResponse({ state: "preparing" }), true).reason,
    ).toContain("wait ran out");
    expect(checkOpen(parseBriefResponse({ state: "none" }), false).status).toBe(
      "FAIL",
    );
    expect(
      checkOpen(parseBriefResponse(briefFixture({ noRevision: true })), false)
        .reason,
    ).toContain("no revision");
  });
});

describe("brief lifecycle check", () => {
  const before = parseBriefResponse(briefFixture());
  const seen = (reopen?: string) =>
    parseBriefResponse(briefFixture({ seenAt: 1, reopen }));

  test("fails when open decisions have no way back", () => {
    const verdict = checkBriefAfterDone(before, seen());
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reason).toContain("no reopen line");
  });

  test("passes with a reopen line, or with nothing left open", () => {
    expect(checkBriefAfterDone(before, seen("Brief")).status).toBe("PASS");
    const done = briefFixture({ seenAt: 1, noDecisions: true });
    expect(checkBriefAfterDone(before, parseBriefResponse(done)).status).toBe(
      "PASS",
    );
  });

  test("fails a brief that is gone or still unseen", () => {
    expect(
      checkBriefAfterDone(before, parseBriefResponse({ state: "none" })).status,
    ).toBe("FAIL");
    expect(checkBriefAfterDone(before, before).reason).toContain("unseen");
  });
});

describe("answer check", () => {
  const open = parseItem({ id: "a", title: "T", state: "open", revision: 7 });

  test("stale revision, outcomes", () => {
    expect(staleRevision(7)).toBe(6);
    expect(staleRevision(0)).toBe(1);
    expect(answerOutcome(409, { error: "changed" })).toBe("changed");
    expect(answerOutcome(409, { error: "already closed" })).toBe("closed");
    expect(answerOutcome(200, {})).toBe("ok");
  });

  test("passes 409 changed then answered", () => {
    expect(
      checkAnswer({ status: 409, body: { error: "changed" } }, open, {
        status: 200,
        body: { item: { id: "a", title: "T", state: "answered" } },
      }).status,
    ).toBe("PASS");
  });

  test("fails a second changed: the loop Blob would be stuck in", () => {
    const verdict = checkAnswer(
      { status: 409, body: { error: "changed" } },
      open,
      {
        status: 409,
        body: { error: "changed" },
      },
    );
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reason).toContain("This changed");
  });

  test("fails a stale answer the server took", () => {
    expect(checkAnswer({ status: 200, body: {} }, open, null).reason).toContain(
      "expected 409 changed",
    );
  });
});

describe("sending", () => {
  test("the first send carries no effort or speed override", () => {
    expect(
      promptBody({ content: "hi", clientId: "ID-1", user: "Probe" }),
    ).toEqual({
      content: "hi",
      clientId: "ID-1",
      busy: "steer",
      user: "Probe",
      fastMode: false,
      speed: "standard",
      surface: { app: "blob", panes: 1, width: "compact" },
    });
  });

  test("the outbox tries a 404 again for 120 s on its backoff", () => {
    expect(outboxBackoffMs(1)).toBe(2000);
    expect(outboxBackoffMs(3, 0.5)).toBe(8500);
    expect(outboxBackoffMs(9)).toBe(60_000);
    const missing = deliveryOutcome(404, { error: "Session not found" });
    expect(missing).toEqual({ kind: "missing", reason: "Session not found" });
    expect(outboxNext(missing, 1, 0)).toEqual({ waitMs: 2000 });
    expect(outboxNext(missing, 2, OUTBOX_MISSING_WINDOW_MS)).toEqual({
      waitMs: 4000,
    });
    const late = outboxNext(missing, 7, OUTBOX_MISSING_WINDOW_MS + 1);
    expect(late).toEqual({
      done: {
        kind: "rejected",
        reason: "still 404 after 120 s: Session not found",
      },
    });
    expect(outboxNext({ kind: "retry", reason: "HTTP 503" }, 1, 0)).toEqual({
      waitMs: 2000,
    });
    const rejected = { kind: "rejected", reason: "bad" } as const;
    expect(outboxNext(rejected, 1, 0)).toEqual({ done: rejected });
    const delivered = { kind: "delivered", status: "started" } as const;
    expect(outboxNext(delivered, 1, 0)).toEqual({ done: delivered });
  });

  test("the launch timezone: set only when the prefs have none", () => {
    const prefs = (timezone?: string, effectiveTimezone?: string) => ({
      prefs: { timezone, effectiveTimezone },
    });
    expect(timezoneToSet(prefs("", "UTC"), "Europe/Warsaw")).toBe(
      "Europe/Warsaw",
    );
    expect(timezoneToSet(prefs(""), "Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(timezoneToSet(prefs("", "Europe/Berlin"), "Europe/Warsaw")).toBe(
      null,
    );
    expect(timezoneToSet(prefs("Europe/Berlin"), "Europe/Warsaw")).toBe(null);
    // A missing timezone decodes as nil in the app, which is not "".
    expect(timezoneToSet(prefs(), "Europe/Warsaw")).toBe(null);
    expect(timezoneToSet({}, "Europe/Warsaw")).toBe(null);
  });

  test("delivery outcomes follow OS1API.deliverPrompt", () => {
    expect(deliveryOutcome(200, { status: "steered" })).toEqual({
      kind: "delivered",
      status: "steered",
    });
    expect(deliveryOutcome(503, null).kind).toBe("retry");
    expect(deliveryOutcome(404, null).kind).toBe("missing");
    expect(deliveryOutcome(401, null).kind).toBe("retry");
    expect(deliveryOutcome(400, { error: "content required" })).toEqual({
      kind: "rejected",
      reason: "content required",
    });
  });
});

describe("reply split", () => {
  test("a closed say fence", () => {
    expect(
      splitReply(
        "```say\n[warm] Two things. {#pr-12} One **shipped**.\n```\n\n- [PR](u){#pr-12}",
      ),
    ).toEqual({
      scripted: true,
      closed: true,
      say: "Two things. One shipped.",
      show: "- [PR](u){#pr-12}",
    });
  });

  test("an unclosed fence, and one cut by another block", () => {
    expect(splitReply("```say\nStill writ").closed).toBe(false);
    const cut = splitReply("```say\nHi.\n```metrics\nA: 1\n```");
    expect(cut.closed).toBe(false);
    expect(cut.show).toBe("```metrics\nA: 1\n```");
  });

  test("no fence: the first paragraph", () => {
    expect(splitReply("Two things:\n- one\n- two")).toEqual({
      scripted: false,
      closed: false,
      say: "Two things:",
      show: "- one\n- two",
    });
  });
});

describe("talk", () => {
  const user = (id: string, sourceMessageIds?: string[]) => ({
    id,
    type: "user",
    content: "hi",
    sourceMessageIds,
  });
  const assistant = (id: string, content: string) => ({
    id,
    type: "assistant",
    content,
  });

  function run(frames: unknown[]) {
    const stream = new SessionStream(SESSION);
    const turn = new TalkTurn("OUT-1", 0);
    frames.forEach((frame, i) => {
      stream.apply(frame);
      turn.observe(stream, (i + 1) * 100);
    });
    return { stream, turn };
  }

  const init = {
    type: "transcript_init",
    sessionId: SESSION,
    entries: [user("u0"), assistant("a0", "old answer")],
    truncated: false,
    firstSeq: 1,
  };

  test("accepted, first token and settled, from frames", () => {
    const { stream, turn } = run([
      init,
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [user("u1", ["OUT-1"])],
      },
      { type: "session_status", sessionId: SESSION, isRunning: true },
      { type: "stream_start", sessionId: SESSION },
      {
        type: "stream_text",
        sessionId: SESSION,
        text: "thinking",
        kind: "reasoning",
      },
      { type: "stream_text", sessionId: SESSION, text: "```say\nHi.\n```" },
      { type: "stream_done", sessionId: SESSION },
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [assistant("a1", "```say\nHi.\n```")],
      },
      { type: "session_status", sessionId: SESSION, isRunning: false },
    ]);
    expect(turn.acceptedAt).toBe(200);
    expect(turn.firstTokenAt).toBe(600);
    expect(turn.settledAt).toBe(900);
    const result = talkResult(
      turn,
      stream,
      { kind: "delivered", status: "started" },
      0,
    );
    expect(result).toMatchObject({
      acceptedMs: 200,
      firstTokenMs: 400,
      settleMs: 700,
      reply: "```say\nHi.\n```",
      errors: [],
    });
    expect(checkTalk(result).status).toBe("PASS");
  });

  test("never takes the earlier answer, or another turn's stream, for the reply", () => {
    const { turn } = run([
      init,
      { type: "stream_text", sessionId: SESSION, text: "worker report" },
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [user("OUT-1")],
      },
      { type: "stream_text", sessionId: SESSION, text: " more" },
      { type: "stream_done", sessionId: SESSION },
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [assistant("a1", "worker report more")],
      },
    ]);
    expect(turn.acceptedAt).toBe(300);
    expect(turn.firstTokenAt).toBeNull();
    expect(turn.settledAt).toBeNull();
  });

  test("error events and error entries fail the turn; other sessions' don't count", () => {
    const { stream, turn } = run([
      init,
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [user("OUT-1")],
      },
      { type: "error", sessionId: "other", message: "not ours" },
      { type: "error", sessionId: SESSION, message: "run failed" },
      {
        type: "transcript_append",
        sessionId: SESSION,
        entries: [{ ...assistant("e1", "Rate limited"), isError: true }],
      },
    ]);
    const result = talkResult(
      turn,
      stream,
      { kind: "delivered", status: "started" },
      0,
    );
    expect(result.errors).toEqual([
      "error event: run failed",
      "error entry: Rate limited",
    ]);
    expect(checkTalk(result).status).toBe("FAIL");
  });

  test("a reply without a say block fails", () => {
    const verdict = checkTalk({
      delivery: { kind: "delivered", status: "started" },
      acceptedMs: 10,
      firstTokenMs: 10,
      settleMs: 20,
      reply: "Hello there.",
      errors: [],
    });
    expect(verdict.reason).toContain("no ```say block");
  });
});

describe("history", () => {
  test("pages back by seq, then offset, then whole", () => {
    const stream = new SessionStream(SESSION);
    expect(stream.historyRequest()).toBeNull();
    stream.apply({
      type: "transcript_init",
      sessionId: SESSION,
      entries: [],
      truncated: true,
      firstSeq: 40,
    });
    expect(stream.historyRequest(200)).toEqual({
      type: "load_history",
      sessionId: SESSION,
      beforeSeq: 40,
      limit: 200,
    });
    stream.apply({
      type: "transcript_history",
      sessionId: SESSION,
      entries: [],
      truncated: true,
      startOffset: 512,
      rev: "r1",
    });
    expect(stream.historyRequest()).toMatchObject({
      beforeOffset: 512,
      beforeRev: "r1",
    });
  });

  test("exchanges pair your messages with their last reply", () => {
    const stream = new SessionStream(SESSION);
    stream.apply({
      type: "transcript_init",
      sessionId: SESSION,
      entries: [
        { id: "1", type: "user", content: "first", timestamp: "t1" },
        { id: "2", type: "assistant", content: "preamble" },
        { id: "3", type: "tool_use", content: "" },
        { id: "4", type: "assistant", content: "answer" },
        {
          id: "5",
          type: "user",
          content: "report",
          notice: { kind: "worker" },
        },
        { id: "6", type: "user", content: "unanswered" },
        { id: "7", type: "assistant", content: "x", isReasoning: true },
      ],
    });
    expect(exchanges(stream.entries)).toEqual([
      { at: "t1", said: "first", reply: "answer" },
    ]);
  });

  const ex = (id: string, sessionId: string): PastExchange => ({
    id,
    sessionId,
    said: id,
    reply: null,
    at: null,
  });
  const read = (over: Partial<HistoryRead>): HistoryRead => ({
    missingRoute: false,
    error: null,
    exchanges: [],
    pages: 1,
    complete: true,
    currentSessionId: "now",
    previousSessionIds: ["old"],
    earlierInTranscripts: null,
    ...over,
  });

  test("history pages decode as strictly as the app's Codable", () => {
    expect(
      parseHistoryPage({
        exchanges: [{ id: "x", sessionId: "s", said: "hi", at: 5 }],
        before: "c",
      }),
    ).toEqual({
      exchanges: [{ id: "x", sessionId: "s", said: "hi", reply: null, at: 5 }],
      before: "c",
    });
    expect(parseHistoryPage({ exchanges: [], before: null })?.before).toBe(
      null,
    );
    expect(parseHistoryPage({ exchanges: [{ id: "x", said: "hi" }] })).toBe(
      null,
    );
    expect(parseHistoryPage({ before: "c" })).toBe(null);
  });

  test("an older page goes above, without repeats", () => {
    const held = [ex("b", "now")];
    expect(
      prependPage(held, {
        exchanges: [ex("a", "old"), ex("b", "now")],
        before: null,
      }).map((e) => e.id),
    ).toEqual(["a", "b"]);
    expect(historyFoundEarlier([ex("a", "now")], "now")).toBe(false);
    expect(historyFoundEarlier([ex("a", "old")], "now")).toBe(true);
    expect(historyFoundEarlier([ex("a", "old")], null)).toBe(false);
    expect(historyFoundEarlier([ex("a", "old"), ex("b", "now")], null)).toBe(
      true,
    );
  });

  test("passes when exchanges from before the latest rotation come back", () => {
    const verdict = checkHistory(
      read({ exchanges: [ex("a", "old"), ex("b", "now")] }),
    );
    expect(verdict.status).toBe("PASS");
    expect(verdict.reason).toContain("before the latest rotation (old)");
    expect(
      checkHistory(
        read({ previousSessionIds: [], exchanges: [ex("b", "now")] }),
      ).reason,
    ).toContain("no rotation yet");
  });

  test("fails a 404, an error, and history that stops at the current session", () => {
    expect(checkHistory(read({ missingRoute: true })).reason).toContain(
      "history stops at the current session",
    );
    expect(checkHistory(read({ error: "HTTP 500" })).status).toBe("FAIL");
    const stopped = checkHistory(
      read({ exchanges: [ex("b", "now")], earlierInTranscripts: 4 }),
    );
    expect(stopped.status).toBe("FAIL");
    expect(stopped.reason).toContain("history stops at the current session");
    expect(
      checkHistory(read({ exchanges: [ex("b", "now")], complete: false }))
        .status,
    ).toBe("FAIL");
    expect(
      checkHistory(
        read({ exchanges: [ex("b", "now")], earlierInTranscripts: 0 }),
      ).status,
    ).toBe("SKIP");
  });

  test("read-only, two sessions prove a rotation; one can't tell", () => {
    const readOnly = { currentSessionId: null, previousSessionIds: null };
    expect(
      checkHistory(
        read({ ...readOnly, exchanges: [ex("a", "old"), ex("b", "now")] }),
      ).status,
    ).toBe("PASS");
    expect(
      checkHistory(read({ ...readOnly, exchanges: [ex("b", "now")] })).status,
    ).toBe("SKIP");
    expect(checkHistory(read({ ...readOnly, missingRoute: true })).status).toBe(
      "FAIL",
    );
  });
});
