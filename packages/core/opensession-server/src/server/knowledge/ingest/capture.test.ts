import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupportActor } from "../../../shared/support";
import { catalogDocuments } from "../../catalog-documents";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import type {
  RouteClassification,
  RouteClassifierInput,
} from "../../route-classifier";
import { onReplySent, proposeDraft, replyAsPerson } from "../../support/reply";
import { getConversation, updateConversation } from "../../support/store";
import {
  CITED,
  CUSTOMER,
  useReplyTestbed,
} from "../../support/testing/reply-testbed";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import type { RepoChangeDeps } from "../freshness/repo-changes";
import { mailItemPath } from "../layout";
import { KnowledgeService } from "../service";
import {
  __waitForCapturesForTest,
  type CaptureDeps,
  captureReply,
  installKnowledgeCapture,
  rememberRejectedSources,
  retryPendingCaptures,
  suggestFromRepeats,
} from "./capture";

const tb = useReplyTestbed();

const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = new Date().toISOString().slice(0, 10);
const AGENT: SupportActor = { kind: "agent", sessionId: "os-1" };

const QUESTION = `Hello,

I'm ${CUSTOMER.name}, my address is ${CUSTOMER.address} and my phone is +48 600 100 200. How do I export a project as CSV?

Thanks,
${CUSTOMER.name}`;

const ANSWER = `Hi ${CUSTOMER.name},

Open the project, press Export and pick CSV. The file downloads right away.

Best,
Ada`;

// ── The code repository: docs changed two months ago ───────────────────

let repoBase: string;
let checkout: string;

async function run(dir: string, args: string[], date?: string) {
  return (
    await git(args, {
      cwd: dir,
      env: isolatedGitEnv(
        date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {},
      ),
    })
  ).stdout.trim();
}

beforeAll(async () => {
  repoBase = await mkdtemp(join(tmpdir(), "kn-capture-repo-"));
  const origin = join(repoBase, "origin.git");
  const work = join(repoBase, "work");
  checkout = join(repoBase, "checkout");
  await run(repoBase, ["init", "-q", "--bare", "-b", "main", origin]);
  await run(repoBase, ["clone", "-q", origin, work]);
  await run(work, ["checkout", "-q", "-b", "main"]);
  const commit = async (file: string, text: string, ago: number) => {
    await mkdir(join(work, file, ".."), { recursive: true });
    await writeFile(join(work, file), text);
    await run(work, ["add", "--", file]);
    const date = new Date(Date.now() - ago * DAY_MS).toISOString();
    await run(work, ["commit", "-q", "-m", `edit ${file}`], date);
    await run(work, ["push", "-q", "origin", "main"]);
  };
  await commit("README.md", "Acme\n", 90);
  await commit("docs/export.md", "Export as CSV\n", 60);
  await run(repoBase, ["clone", "-q", origin, checkout]);
});

afterAll(async () => {
  await rm(repoBase, { recursive: true, force: true });
});

// ── The small model ────────────────────────────────────────────────────

let labels: string[];
let contents: string[];
let repeatVerdict: (content: string) => "same" | "different";

const classify = (async <R extends string>(
  input: RouteClassifierInput<R>,
): Promise<RouteClassification<R> | null> => {
  labels.push(input.label);
  contents.push(input.content);
  if (input.label === "knowledge-extract") {
    const answer = /<our_answer_[0-9a-f]+>\n([\s\S]*?)\n<\/our_answer_/.exec(
      input.content,
    )?.[1];
    const raw = {
      route: "pair",
      reason: "reusable",
      title: "Exporting a project as CSV",
      question: "How do I export a project as CSV?",
      answer: answer?.trim() ?? "",
      topics: ["export", "csv"],
      touched_paths: [],
      generic: true,
    };
    return { route: "pair" as R, reason: "reusable", raw };
  }
  if (input.label === "knowledge-repeat") {
    const route = repeatVerdict(input.content);
    return { route: route as R, reason: "", raw: { route } };
  }
  if (input.label === "knowledge-suggest") {
    const raw = {
      route: "article",
      title: "Export a project as CSV",
      answer: "Open the project, press Export and pick CSV.",
    };
    return { route: "article" as R, reason: "", raw };
  }
  return null;
}) as CaptureDeps["classify"];

function deps(): Partial<CaptureDeps> {
  const repoChanges: Partial<RepoChangeDeps> = {
    repo: (project) =>
      project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
  };
  return {
    classify,
    repoChanges,
    github: { ghRepo: () => null },
    supportHosts: async () => ["docs.acme.example.test"],
  };
}

beforeEach(() => {
  labels = [];
  contents = [];
  repeatVerdict = () => "same";
  __setKnowledgeServiceForTest(
    new KnowledgeService({ base: join(tb.kernel.root(), "memory") }),
  );
  installKnowledgeCapture(deps());
});

afterEach(async () => {
  await __waitForCapturesForTest();
  onReplySent(null);
  __setKnowledgeServiceForTest(null);
});

/** A conversation with the customer's question, answered by Ada by hand. */
async function answeredByHand(text = ANSWER) {
  const c = await tb.conversation({ text: QUESTION });
  const sent = await replyAsPerson(c.id, text, "Ada");
  if (!sent.ok) throw new Error(sent.error);
  await __waitForCapturesForTest();
  return { c, message: sent.message };
}

function itemPath(message: { keys: { messageId: string | null }; at: string }) {
  return mailItemPath(message.keys.messageId!, message.at);
}

async function listed(filter: "all" | "suggestions") {
  if (!(await knowledgeRepo.call("hasRepo", "acme"))) return [];
  return (
    await knowledgeRepo.call("index.list", "acme", filter, {
      today: TODAY,
      limit: 200,
    })
  ).items;
}

const pendingKeys = async () =>
  (await catalogDocuments("knowledge-pending").list())
    .map((row) => row.key)
    .filter((key) => key.startsWith("capture:"));

test("a person's reply becomes one trusted mail item without the customer", async () => {
  const { c, message } = await answeredByHand();
  const path = itemPath(message);
  expect(path.startsWith("sources/mail/")).toBe(true);
  const read = await knowledgeRepo.call("read", "acme", path, TODAY);
  expect(read).not.toBeNull();
  expect(read!.item).toMatchObject({
    origin: "mail",
    trust: "trusted",
    status: "active",
    kind: "answer",
    answeredAt: message.at,
    sources: [
      `mail:${message.keys.messageId}`,
      `thread:${createHash("sha256").update(c.messages[0]!.keys.messageId!).digest("hex")}`,
      `conversation:${c.id}`,
    ],
  });
  expect(read!.item.validAsOfCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(read!.body).toContain("press Export and pick CSV");
  const all = JSON.stringify(read);
  expect(all).not.toContain(CUSTOMER.name);
  expect(all).not.toContain(CUSTOMER.address);
  expect(all).not.toContain("600 100 200");
  expect((await listed("all")).length).toBe(1);
  expect(await pendingKeys()).toEqual([]);
  // Once per message: a second capture finds it there.
  expect(await captureReply(c.id, message.id, deps())).toBe("exists");
});

test("a reply that can't be kept creates no knowledge repository", async () => {
  const { c, message } = await answeredUncaptured();
  expect(
    await captureReply(c.id, message.id, {
      ...deps(),
      classify: (async () => null) as CaptureDeps["classify"],
    }),
  ).toBe("skipped");
  expect(await knowledgeRepo.call("hasRepo", "acme")).toBe(false);
  expect(await captureReply(c.id, message.id, deps())).toBe("written");
  expect(await knowledgeRepo.call("hasRepo", "acme")).toBe(true);
});

test("an automatic send is not captured", async () => {
  await tb.setInbox({ autonomy: "routine", vetoMs: null });
  const c = await tb.conversation({ text: QUESTION });
  const result = await proposeDraft(
    c.id,
    "Open the project, press Export and pick CSV.",
    AGENT,
    undefined,
    CITED,
  );
  expect(result.ok && result.draft.state).toBe("sent");
  await __waitForCapturesForTest();
  expect(await listed("all")).toEqual([]);
  expect(await pendingKeys()).toEqual([]);
  expect(labels).toEqual([]);
  // Asked directly, an agent's own send is still skipped.
  const out = (await getConversation(c.id))!.messages.at(-1)!;
  expect(await captureReply(c.id, out.id, deps())).toBe("skipped");
});

test("the same question answered by hand in two conversations becomes one suggestion, a third adds its source", async () => {
  const first = await answeredByHand();
  expect(await listed("suggestions")).toEqual([]);

  const second = await answeredByHand();
  let suggestions = await listed("suggestions");
  expect(suggestions).toHaveLength(1);
  const suggestion = suggestions[0]!;
  expect(suggestion).toMatchObject({
    origin: "suggestion",
    trust: "reference",
    status: "active",
    suggestedBy: "Pat",
    title: "Export a project as CSV",
  });
  expect(suggestion.path.startsWith("suggestions/")).toBe(true);
  expect([...suggestion.sources].sort()).toEqual(
    [
      `mail:${first.message.keys.messageId}`,
      `mail:${second.message.keys.messageId}`,
    ].sort(),
  );
  const body = (await knowledgeRepo.call(
    "read",
    "acme",
    suggestion.path,
    TODAY,
  ))!.body;
  expect(body).toContain("Open the project, press Export and pick CSV.");
  expect(body).not.toContain(CUSTOMER.name);

  const third = await answeredByHand();
  suggestions = await listed("suggestions");
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]!.path).toBe(suggestion.path);
  expect(suggestions[0]!.sources).toContain(
    `mail:${third.message.keys.messageId}`,
  );
  expect(suggestions[0]!.sources).toHaveLength(3);
});

test("answers behind a discarded suggestion make no suggestion again", async () => {
  const first = await answeredByHand();
  const second = await answeredByHand();
  const [suggestion] = await listed("suggestions");
  expect(suggestion).toBeDefined();
  await rememberRejectedSources("acme", suggestion!.sources);
  await knowledgeRepo.call(
    "write",
    "acme",
    [{ op: "delete", path: suggestion!.path }],
    {
      message: "Discard",
      author: { name: "Ada" },
      expected: { [suggestion!.path]: suggestion!.blob },
    },
  );
  expect(
    await suggestFromRepeats("acme", [itemPath(second.message)], deps()),
  ).toBeNull();
  await answeredByHand();
  expect(await listed("suggestions")).toEqual([]);
  expect(first).toBeDefined();
});

test("a second reply in the same conversation is no repeat", async () => {
  const { c } = await answeredByHand();
  await tb.customerReply(c.id, QUESTION);
  const again = await replyAsPerson(c.id, ANSWER, "Ada");
  expect(again.ok).toBe(true);
  await __waitForCapturesForTest();
  expect((await listed("all")).filter((i) => i.origin === "mail")).toHaveLength(
    2,
  );
  expect(await listed("suggestions")).toEqual([]);
  expect(labels).not.toContain("knowledge-repeat");
});

test("different questions make no suggestion", async () => {
  repeatVerdict = () => "different";
  await answeredByHand();
  await answeredByHand();
  expect(await listed("suggestions")).toEqual([]);
  expect(labels).toContain("knowledge-repeat");
});

test("a question an article already answers makes no suggestion", async () => {
  await knowledgeRepo.call("ensureRepo", "acme");
  await knowledgeRepo.call(
    "write",
    "acme",
    [
      {
        op: "put",
        path: "articles/export-csv.md",
        fm: {
          title: "Exporting a project as CSV",
          kind: "answer",
          trust: "trusted",
          status: "active",
          origin: "article",
          topics: ["export", "csv"],
          sources: [],
          dependsOn: ["repo:docs/export.md"],
          validAsOf: TODAY,
        },
        body: "Open the project, press Export and pick CSV.\n",
      },
    ],
    { message: "Add export article", author: { name: "Ada" } },
  );
  await answeredByHand();
  await answeredByHand();
  expect(await listed("suggestions")).toEqual([]);
  // The repeat was found; the article's top hit is the same question.
  expect(labels.filter((l) => l === "knowledge-repeat").length).toBe(2);
  expect(labels).not.toContain("knowledge-suggest");
});

test("a capture a crash left pending is processed by the retry", async () => {
  onReplySent(null);
  const c = await tb.conversation({ text: QUESTION });
  const sent = await replyAsPerson(c.id, ANSWER, "Ada");
  if (!sent.ok) throw new Error(sent.error);
  await catalogDocuments("knowledge-pending").set(
    `capture:${sent.message.id}`,
    {
      conversationId: c.id,
      messageId: sent.message.id,
      project: "acme",
      at: new Date().toISOString(),
      attempts: 0,
    },
  );
  expect(await listed("all")).toEqual([]);

  await retryPendingCaptures(Date.now(), { deps: deps() });
  const read = await knowledgeRepo.call(
    "read",
    "acme",
    itemPath(sent.message),
    TODAY,
  );
  expect(read?.item.trust).toBe("trusted");
  expect(await pendingKeys()).toEqual([]);
});

test("every sender of the thread is stripped from the question and the answer", async () => {
  const c = await tb.conversation({ text: QUESTION });
  const dave = { name: "Dave Okafor", address: "dave@partner.example.test" };
  await updateConversation(c.id, (x) => ({
    ...x,
    messages: [
      ...x.messages,
      {
        ...x.messages[0]!,
        id: "sm_test-dave",
        from: dave,
        text: "Dave Okafor here, Carol's colleague: we need the CSV too.",
        keys: {
          messageId: "dave-1@partner.example.test",
          inReplyTo: null,
          references: [],
        },
        providerId: "imap:1:dave",
      },
    ],
  }));
  const sent = await replyAsPerson(
    c.id,
    `Hi ${CUSTOMER.name} and Dave,\n\nOpen the project, press Export and pick CSV. Carol can forward it to Okafor.\n\nBest,\nAda`,
    "Ada",
  );
  if (!sent.ok) throw new Error(sent.error);
  await __waitForCapturesForTest();
  const sentToModel = contents.join("\n");
  expect(contents.length).toBeGreaterThan(0);
  for (const word of ["Carol", "carol@", "Dave", "Okafor", "dave@"])
    expect(sentToModel).not.toContain(word);
  const read = await knowledgeRepo.call(
    "read",
    "acme",
    itemPath(sent.message),
    TODAY,
  );
  expect(read).not.toBeNull();
  const all = JSON.stringify(read);
  for (const word of ["Carol", "Dave", "Okafor"])
    expect(all).not.toContain(word);
});

/** A conversation answered by Ada, not captured by the listener. */
async function answeredUncaptured() {
  onReplySent(null);
  const c = await tb.conversation({ text: QUESTION });
  const sent = await replyAsPerson(c.id, ANSWER, "Ada");
  if (!sent.ok) throw new Error(sent.error);
  return { c, message: sent.message };
}

test("a reply whose draft the knowledge check held is captured as reference with the reason", async () => {
  const { c, message } = await answeredUncaptured();
  expect(
    await captureReply(c.id, message.id, deps(), {
      knowledgeHold: "The reply quotes an internal note",
      citations: [],
    }),
  ).toBe("written");
  const read = await knowledgeRepo.call(
    "read",
    "acme",
    itemPath(message),
    TODAY,
  );
  expect(read!.item.trust).toBe("reference");
  expect(read!.item.validAsOfCommit).toBeUndefined();
  expect(read!.body.split("\n")[0]).toBe(
    "> Imported as reference: The reply quotes an internal note",
  );
});

test("a reply citing knowledge depends on what the cited items depend on", async () => {
  await knowledgeRepo.call("ensureRepo", "acme");
  const commit = await knowledgeRepo.call(
    "write",
    "acme",
    [
      {
        op: "put",
        path: "articles/export-csv.md",
        fm: {
          title: "Exporting",
          kind: "answer",
          trust: "trusted",
          status: "active",
          origin: "article",
          topics: [],
          sources: [],
          dependsOn: ["issue:12"],
          validAsOf: TODAY,
        },
        body: "Press Export.\n",
      },
    ],
    { message: "Add article", author: { name: "Ada" } },
  );
  const { c, message } = await answeredUncaptured();
  await captureReply(c.id, message.id, deps(), {
    knowledgeHold: null,
    citations: [`articles/export-csv.md@${commit}`],
  });
  const read = await knowledgeRepo.call(
    "read",
    "acme",
    itemPath(message),
    TODAY,
  );
  expect(read!.item.trust).toBe("trusted");
  expect(read!.item.dependsOn).toContain("issue:12");

  // A citation that can't be read leaves the dependencies unknown.
  const other = await answeredUncaptured();
  await captureReply(other.c.id, other.message.id, deps(), {
    knowledgeHold: null,
    citations: [`articles/gone.md@${commit}`],
  });
  const gone = await knowledgeRepo.call(
    "read",
    "acme",
    itemPath(other.message),
    TODAY,
  );
  expect(gone!.item.trust).toBe("reference");
});
