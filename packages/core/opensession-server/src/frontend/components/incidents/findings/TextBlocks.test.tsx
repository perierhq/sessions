import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ClaimRow,
  FINDINGS_COPY,
  type FindingBlock,
  type Provenance,
} from "../../../../shared/findings";
import type { Incident } from "../../../../shared/incidents";
import type { FindingItem } from "../../../lib/incidents/findings";
import {
  FINDINGS_LOG_MARK,
  FINDINGS_SOURCE_QUIET,
} from "../../../lib/incident-classes";
import { BlockFrame } from "./BlockFrame";
import {
  ClaimsBlock,
  HypothesisBlock,
  LogBlock,
  QuestionBlock,
  TimelineBlock,
} from "./TextBlocks";

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

const item = (block: FindingBlock, over: Partial<FindingItem> = {}) =>
  ({
    key: `investigator:${block.id}`,
    role: "investigator",
    block,
    span: "full",
    byline: FINDINGS_COPY.byline("investigator", "14:32"),
    ...over,
  }) satisfies FindingItem;

const hypothesis = (
  over: Partial<Extract<FindingBlock, { kind: "hypothesis" }>> = {},
): FindingBlock => ({
  id: "slow-db",
  kind: "hypothesis",
  size: "full",
  statement: "The acme pool is too small.",
  confidence: "medium",
  evidence: [],
  claims: [],
  ...over,
});

const log = (
  lines: string[],
  highlight: number[],
  dropped: number,
  provenance: Provenance = { kind: "shell" },
) =>
  ({
    id: "errors",
    kind: "log",
    size: "full",
    source: {
      type: "tool",
      sessionId: "os-inv",
      useId: "toolu_1",
      resultId: "tr-toolu_1",
      tool: "Bash",
      at: T("12:04"),
      provenance,
    },
    lines,
    highlight,
    dropped,
  }) satisfies FindingBlock;

test("frame: heading, byline and show source", () => {
  const titled = item(hypothesis({ title: "Pool exhaustion" }));
  const html = renderToStaticMarkup(
    <BlockFrame item={titled} highlight={false} onOpenSource={() => {}}>
      <p>body</p>
    </BlockFrame>,
  );
  expect(html).toContain("<section");
  expect(html).toMatch(/<h3[^>]*>Pool exhaustion<\/h3>/);
  expect(html).toContain("from the investigator, 14:32");
  expect(html).toContain("Show source");
  // The section is named by its heading.
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
  expect(labelledBy).toBeTruthy();
  expect(html).toContain(`id="${labelledBy}"`);
  // "Show source" says which block it opens.
  expect(html).toMatch(
    new RegExp(`<button[^>]*aria-describedby="${labelledBy}"[^>]*>`),
  );

  const plain = renderToStaticMarkup(
    <BlockFrame item={item(hypothesis())} highlight={false} onOpenSource={null}>
      <p>body</p>
    </BlockFrame>,
  );
  expect(plain).not.toContain("Show source");
  // No title: the kind's own name.
  expect(plain).toMatch(/<h3[^>]*>Hypothesis<\/h3>/);
});

test("frame: a changed block carries the highlight", () => {
  const on = renderToStaticMarkup(
    <BlockFrame item={item(hypothesis())} highlight onOpenSource={null}>
      <p>body</p>
    </BlockFrame>,
  );
  const off = renderToStaticMarkup(
    <BlockFrame item={item(hypothesis())} highlight={false} onOpenSource={null}>
      <p>body</p>
    </BlockFrame>,
  );
  expect(on).toContain("data-highlight");
  expect(off).not.toContain("data-highlight");
});

test("agent prose is Markdown, never raw HTML", () => {
  const html = renderToStaticMarkup(
    <HypothesisBlock
      item={item(
        hypothesis({ statement: "**Pool** <img src=x onerror=alert(1)>" }),
        { status: "unchecked" },
      )}
    />,
  );
  expect(html).toContain("<strong>Pool</strong>");
  expect(html).not.toContain("<img src=x");
});

test("agent prose has no headings or embeds of its own", () => {
  const html = renderToStaticMarkup(
    <HypothesisBlock
      item={item(
        hypothesis({
          statement:
            "# Pool\n\n![graph](https://example.test/graph.png)\n\nhttps://www.tella.tv/video/my-demo-3592",
        }),
        { status: "unchecked" },
      )}
    />,
  );
  expect(html).not.toMatch(/<h\d/);
  expect(html).toContain("<p>Pool</p>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<iframe");
});

test("log lines render as text with highlights and the dropped count", () => {
  const html = renderToStaticMarkup(
    <LogBlock item={item(log(["<b>ERROR</b> db timeout"], [0], 2))} />,
  );
  expect(html).toContain("&lt;b&gt;ERROR&lt;/b&gt; db timeout");
  expect(html).not.toContain("<b>ERROR");
  expect(html).toContain(FINDINGS_LOG_MARK);
  expect(html).toContain("2 lines couldn&#x27;t be found in the source");
  expect(html).toContain(
    `class="${FINDINGS_SOURCE_QUIET}">from the agent&#x27;s shell<`,
  );
});

test("a log from a connector says where it came from in the normal voice", () => {
  const block = log(["level=error msg=timeout acme"], [], 0, {
    kind: "connector",
    label: "Datadog",
  });
  const html = renderToStaticMarkup(<LogBlock item={item(block)} />);
  expect(html).toContain("from Datadog");
  expect(html).not.toContain(FINDINGS_SOURCE_QUIET);
  expect(html).not.toContain("couldn&#x27;t be found");
  expect(html).not.toContain(FINDINGS_LOG_MARK);
});

test("hypothesis shows confidence and status", () => {
  const html = renderToStaticMarkup(
    <HypothesisBlock
      item={item(hypothesis({ confidence: "high" }), { status: "refuted" })}
    />,
  );
  expect(html).toContain("High confidence");
  expect(html).toContain("Refuted");
});

test("hypothesis lists the claims it rests on", () => {
  const html = renderToStaticMarkup(
    <HypothesisBlock
      item={item(
        hypothesis({ claims: ["The replica was removed in the release"] }),
        { status: "verified" },
      )}
    />,
  );
  expect(html).toContain("The replica was removed in the release");
  expect(html).toContain("Verified");
});

test("timeline lists anchors and events in order", () => {
  const incident: Pick<Incident, "openedAt" | "response"> = {
    openedAt: T("12:00"),
    response: undefined,
  };
  const block: FindingBlock = {
    id: "when",
    kind: "timeline",
    size: "full",
    events: [
      { at: T("12:10"), text: "Errors peak at acme" },
      { at: T("12:03"), text: "Release v1.2.0 goes out with `replicas: 0`" },
    ],
  };
  const html = renderToStaticMarkup(
    <TimelineBlock item={item(block)} incident={incident} round={1} />,
  );
  expect(html).toContain("<ol");
  expect(html).toContain(`<time dateTime="${T("12:00")}"`);
  const opened = html.indexOf("Incident opened");
  const release = html.indexOf("Release v1.2.0 goes out");
  const peak = html.indexOf("Errors peak at acme");
  expect(opened).toBeGreaterThan(-1);
  expect(opened).toBeLessThan(release);
  expect(release).toBeLessThan(peak);
  // Agent event text is Markdown; the page's own anchors are plain text.
  expect(html).toContain("<code>replicas: 0</code>");
});

test("question says what would answer it", () => {
  const block: FindingBlock = {
    id: "unknown",
    kind: "question",
    size: "half",
    text: "Why did acme stop retrying?",
    wouldAnswer: "The retry config at example.test.",
  };
  const html = renderToStaticMarkup(<QuestionBlock item={item(block)} />);
  expect(html).toContain("Why did acme stop retrying?");
  expect(html).toContain("What would answer it");
  expect(html).toContain("The retry config at example.test.");

  const bare = renderToStaticMarkup(
    <QuestionBlock item={item({ ...block, wouldAnswer: "" })} />,
  );
  expect(bare).not.toContain("What would answer it");
});

test("claims rows say each status in words", () => {
  const claims: ClaimRow[] = [
    { text: "The pool is too small", status: "verified", evidence: "saw it" },
    { text: "The release removed the replica", status: "unverifiable" },
    { text: "Retries are off", status: "unchecked" },
  ];
  const html = renderToStaticMarkup(
    <ClaimsBlock
      item={item({ id: "claims", kind: "claims", size: "full" }, { claims })}
    />,
  );
  expect(html).toContain("Verified");
  expect(html).toContain("Can&#x27;t tell");
  expect(html).toContain("Not checked yet");
  expect(html).toContain("saw it");
  expect(html.indexOf("The pool is too small")).toBeLessThan(
    html.indexOf("Retries are off"),
  );
});

test("claim rows render their text and evidence as Markdown", () => {
  const claims: ClaimRow[] = [
    {
      text: "The acme release set `search.replicas` to 0",
      status: "verified",
      evidence: "The diff sets `search.replicas` from 0 back to 2",
    },
  ];
  const html = renderToStaticMarkup(
    <ClaimsBlock
      item={item({ id: "claims", kind: "claims", size: "full" }, { claims })}
    />,
  );
  expect(html).toContain("set <code>search.replicas</code> to 0");
  expect(html).toContain("sets <code>search.replicas</code> from 0");
  expect(html).not.toContain("`");
});

test("a hypothesis lists the claims it rests on as Markdown", () => {
  const html = renderToStaticMarkup(
    <HypothesisBlock
      item={item(
        hypothesis({ claims: ["The acme release set `search.replicas` to 0"] }),
      )}
    />,
  );
  expect(html).toContain("set <code>search.replicas</code> to 0");
  expect(html).not.toContain("`");
});

test("a claims block with no rows yet says so", () => {
  const html = renderToStaticMarkup(
    <ClaimsBlock
      item={item(
        { id: "claims", kind: "claims", size: "full" },
        { claims: [] },
      )}
    />,
  );
  expect(html).toContain("No claims yet");
});
