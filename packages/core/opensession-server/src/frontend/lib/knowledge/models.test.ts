import { describe, expect, test } from "bun:test";
import type {
  KnowledgeImportJob,
  KnowledgeItem,
} from "../../../shared/knowledge";
import {
  emptyCopy,
  filterLabel,
  formatDay,
  freshnessLine,
  itemBadges,
  jobLine,
  listLine,
  originLabel,
  runningJobLine,
  sectionCounts,
  knowledgeAlert,
  knowledgeErrorMessage,
} from "./models";
import { ApiError } from "../api/request";

const TODAY = "2026-10-26";

function item(over: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    project: "acme",
    path: "articles/export.md",
    blob: "b".repeat(40),
    commit: "c".repeat(40),
    updatedAt: "2026-10-20T08:00:00Z",
    effective: "active",
    excerpt: "",
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: [],
    sources: [],
    dependsOn: [],
    validAsOf: TODAY,
    ...over,
  };
}

const labels = (i: KnowledgeItem) => itemBadges(i).map((b) => b.label);

describe("itemBadges", () => {
  test("a trusted, active answer carries no badge", () => {
    expect(labels(item())).toEqual([]);
  });

  test("a reference item", () => {
    expect(labels(item({ trust: "reference", origin: "mail" }))).toEqual([
      "Reference",
    ]);
  });

  test("an item past its review date is overdue, one warning badge", () => {
    const overdue = item({ reviewBy: "2026-10-01", effective: "needs-check" });
    expect(itemBadges(overdue)).toEqual([
      { label: "Overdue", tone: "warning" },
    ]);
  });

  test("an item flipped by a change needs a check, not overdue", () => {
    expect(
      labels(
        item({
          status: "needs-check",
          effective: "needs-check",
          check: { reason: "docs/export.md changed", since: TODAY },
        }),
      ),
    ).toEqual(["Needs check"]);
  });

  test("internal and retired", () => {
    expect(
      labels(
        item({ kind: "internal", status: "retired", effective: "retired" }),
      ),
    ).toEqual(["Internal", "Retired"]);
  });
});

test("originLabel: nothing for the team's own articles", () => {
  expect(originLabel("article")).toBeNull();
  expect(originLabel("mail")).toBe("From the mailbox");
  expect(originLabel("repo")).toBe("From the docs");
});

test("listLine adds where an item came from", () => {
  expect(listLine(item(), TODAY)).toBe("Valid as of 26 Oct 2026");
  expect(listLine(item({ origin: "mail" }), TODAY)).toBe(
    "Valid as of 26 Oct 2026 · From the mailbox",
  );
});

describe("freshnessLine", () => {
  test("valid as of", () => {
    expect(freshnessLine(item(), TODAY)).toBe("Valid as of 26 Oct 2026");
  });

  test("needs a check, with the reason", () => {
    expect(
      freshnessLine(
        item({
          status: "needs-check",
          effective: "needs-check",
          check: { reason: "docs/export.md changed in 9c1d2e0", since: TODAY },
        }),
        TODAY,
      ),
    ).toBe("docs/export.md changed in 9c1d2e0");
  });

  test("review by", () => {
    expect(freshnessLine(item({ reviewBy: "2027-01-31" }), TODAY)).toBe(
      "Review by 31 Jan 2027",
    );
  });

  test("a passed review date beside the Overdue badge: the reason alone", () => {
    expect(
      freshnessLine(
        item({ reviewBy: "2026-10-01", effective: "needs-check" }),
        TODAY,
      ),
    ).toBe("Review date passed (1 Oct 2026)");
  });

  test("a passed review date the list hasn't caught up with yet", () => {
    expect(freshnessLine(item({ reviewBy: "2026-10-01" }), TODAY)).toBe(
      "Needs a check: Review date passed (1 Oct 2026)",
    );
  });
});

test("formatDay", () => {
  expect(formatDay("2026-10-26")).toBe("26 Oct 2026");
  expect(formatDay("not a day")).toBe("not a day");
});

test("filterLabel and emptyCopy cover every filter", () => {
  expect(filterLabel("needs-check")).toBe("Needs check");
  expect(filterLabel("answer")).toBe("Answer");
  expect(emptyCopy("needs-check")).toBe("Nothing needs a check");
  // No persona in tests: the agent, not a hard-coded name.
  expect(emptyCopy("suggestions")).toBe(
    "No suggestions. The agent suggests articles from the replies your team sends",
  );
  expect(emptyCopy("suggestions")).toContain("No suggestions");
});

describe("jobLine", () => {
  const job = (over: Partial<KnowledgeImportJob> = {}): KnowledgeImportJob => ({
    id: "j1",
    project: "acme",
    kind: "mailbox",
    state: "running",
    startedAt: "2026-10-26T08:00:00Z",
    done: 120,
    total: 340,
    created: { trusted: 80, reference: 30, suggestions: 6, skipped: 0 },
    options: {},
    ...over,
  });

  test("a running mailbox import", () => {
    expect(jobLine(job())).toBe(
      "Mailbox · 120 of 340 · 80 trusted, 30 reference, 6 suggestions",
    );
  });

  test("an unknown total, nothing created yet", () => {
    expect(
      jobLine(
        job({
          kind: "website",
          done: 4,
          total: null,
          created: { trusted: 0, reference: 0, suggestions: 0, skipped: 0 },
        }),
      ),
    ).toBe("Website · 4 so far");
  });

  test("a running import with a phase leaves the count to the phase line", () => {
    expect(jobLine(job({ phase: { text: "Writing answers 12 of 40" } }))).toBe(
      "Mailbox · 80 trusted, 30 reference, 6 suggestions",
    );
    expect(
      jobLine(
        job({
          phase: { text: "Reading INBOX" },
          created: { trusted: 0, reference: 0, suggestions: 0, skipped: 0 },
        }),
      ),
    ).toBe("Mailbox · Running");
  });

  test("the project page follows a running import's phase", () => {
    expect(
      runningJobLine(job({ phase: { text: "Reading INBOX 120 of 900" } })),
    ).toBe("Mailbox · Reading INBOX 120 of 900");
    expect(runningJobLine(job())).toBe(jobLine(job()));
  });

  test("queued and failed", () => {
    expect(jobLine(job({ state: "queued" }))).toBe(
      "Mailbox · Waiting to start",
    );
    expect(
      jobLine(job({ kind: "files", state: "failed", error: "Bad PDF" })),
    ).toBe("Files · Failed: Bad PDF");
  });

  test("one suggestion, skipped items", () => {
    expect(
      jobLine(
        job({
          kind: "known-problems",
          state: "done",
          done: 3,
          total: 3,
          created: { trusted: 0, reference: 2, suggestions: 1, skipped: 1 },
        }),
      ),
    ).toBe("Known problems · Done · 2 reference, 1 suggestion, 1 skipped");
  });
});

test("sectionCounts", () => {
  expect(
    sectionCounts({
      all: 20,
      answer: 7,
      internal: 2,
      "needs-check": 3,
      reference: 5,
      suggestions: 4,
      retired: 1,
    }),
  ).toEqual({ articles: 9, needsCheck: 3, suggestions: 4, reference: 5 });
});

describe("knowledgeErrorMessage", () => {
  test("the server's own words win", () => {
    const e = new ApiError(
      "The code repository can't be read right now. Try again",
      503,
    );
    expect(knowledgeErrorMessage(e, "Couldn't load")).toBe(e.message);
  });

  test("a bare 503 says knowledge is unavailable", () => {
    expect(
      knowledgeErrorMessage(new ApiError("Couldn't load: 503", 503), "x"),
    ).toBe("Knowledge is unavailable right now. Try again in a minute");
  });

  test("a bare 501 says it isn't set up, as info without Retry", () => {
    const alert = knowledgeAlert(
      new ApiError("Couldn't load: 501", 501),
      "x",
      () => {},
    );
    expect(alert).toEqual({
      variant: "info",
      children: "Knowledge isn't set up on this server",
    });
  });

  test("anything else is an error with Retry, or the fallback", () => {
    const retry = () => {};
    expect(knowledgeAlert(new Error(""), "Couldn't load", retry)).toEqual({
      variant: "error",
      onRetry: retry,
      children: "Couldn't load",
    });
  });
});
