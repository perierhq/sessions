import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxConfig } from "../../../shared/support";
import { catalogDocuments } from "../../catalog-documents";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import type {
  RouteClassification,
  RouteClassifierInput,
} from "../../route-classifier";
import {
  __setInboxProjectCheckForTest,
  createInbox,
} from "../../support/inboxes";
import { listIndexRows } from "../../support/store";
import {
  TEST_PROJECTS,
  useSupportTestKernel,
} from "../../support/testing/kernel-fixture";
import {
  MAIL_PASSWORD,
  type MailFixture,
  startMailFixture,
} from "../../support/testing/mail-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import type { RepoChangeDeps } from "../freshness/repo-changes";
import { mailItemPath } from "../layout";
import { KnowledgeService } from "../service";
import { HISTORY_UNREADABLE } from "./trust";
import {
  __waitForJobForTest,
  CANCELLED_COPY,
  cancelJob,
  listJobs,
} from "./jobs";
import {
  DATES_DISAGREE,
  DEADLINE_COPY,
  type MailboxDeps,
  startMailboxBackfill,
} from "./mailbox";

const kernel = useSupportTestKernel();

const INBOX_ADDRESS = "help@acme.example.test";
const CUSTOMER = "Carol Customer";
const CUSTOMER_ADDRESS = "carol@customer.example.test";
const NOW = Date.parse("2026-10-26T12:00:00Z");
const TODAY = "2026-10-26";
const ADA = { name: "Ada" };
const OWNER = { name: "Ada", verified: true, isInstanceOwner: true };

// ── The code repository: docs/export.md changed on 2026-10-06 ─────────

let repoBase: string;
let checkout: string;
const sha: Record<string, string> = {};

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
  repoBase = await mkdtemp(join(tmpdir(), "kn-mailbox-repo-"));
  const origin = join(repoBase, "origin.git");
  const work = join(repoBase, "work");
  checkout = join(repoBase, "checkout");
  await run(repoBase, ["init", "-q", "--bare", "-b", "main", origin]);
  await run(repoBase, ["clone", "-q", origin, work]);
  await run(work, ["checkout", "-q", "-b", "main"]);
  const commit = async (file: string, text: string, date: string) => {
    await mkdir(join(work, file, ".."), { recursive: true });
    await writeFile(join(work, file), text);
    await run(work, ["add", "--", file]);
    await run(work, ["commit", "-q", "-m", `edit ${file}`], date);
    await run(work, ["push", "-q", "origin", "main"]);
    return run(work, ["rev-parse", "HEAD"]);
  };
  sha.first = await commit("README.md", "Acme\n", "2026-08-01T10:00:00Z");
  sha.docs = await commit(
    "docs/export.md",
    "Export as CSV\n",
    "2026-10-06T10:00:00Z",
  );
  await run(repoBase, ["clone", "-q", origin, checkout]);
});

afterAll(async () => {
  await rm(repoBase, { recursive: true, force: true });
});

// ── Mail ───────────────────────────────────────────────────────────────

function rawMail(m: {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  inReplyTo?: string;
  text: string;
  headers?: string[];
}): string {
  return [
    `Message-ID: <${m.id}>`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    ...(m.inReplyTo
      ? [`In-Reply-To: <${m.inReplyTo}>`, `References: <${m.inReplyTo}>`]
      : []),
    ...(m.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.text.replace(/\n/g, "\r\n"),
    "",
  ].join("\r\n");
}

const QUESTION = `Hello,

I'm ${CUSTOMER}, my address is ${CUSTOMER_ADDRESS} and my phone is +48 600 100 200. How do I export a project as CSV?

Thanks,
${CUSTOMER}`;

const ANSWER = `Hi Carol,

Open the project, press Export and pick CSV. The file downloads right away.

Best,
Ada`;

function seed(
  fixture: MailFixture,
  n: string,
  day: string,
  extra: { answerHeaders?: string[] } = {},
) {
  const q = `q${n}@customer.example.test`;
  fixture.imap.appendMessage(
    "INBOX",
    [],
    new Date(`${day}T08:00:00Z`),
    rawMail({
      id: q,
      from: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
      to: INBOX_ADDRESS,
      subject: "Export",
      date: `${day}T08:00:00Z`,
      text: QUESTION,
    }),
  );
  fixture.imap.appendMessage(
    "Sent",
    ["\\Seen"],
    new Date(`${day}T10:00:00Z`),
    rawMail({
      id: `a${n}@acme.example.test`,
      from: `Acme help <${INBOX_ADDRESS}>`,
      to: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
      subject: "Re: Export",
      date: `${day}T10:00:00Z`,
      inReplyTo: q,
      text: ANSWER,
      headers: extra.answerHeaders,
    }),
  );
}

/** The small model: rewrites our reply as it was (stripped). */
function classifier() {
  const calls: string[] = [];
  const classify = (async <R extends string>(
    input: RouteClassifierInput<R>,
  ): Promise<RouteClassification<R> | null> => {
    calls.push(input.content);
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
  }) as MailboxDeps["classify"];
  return { classify, calls };
}

let fixture: MailFixture;
let inbox: InboxConfig;
let memory: string;
let previousSecrets: string | undefined;
let model: ReturnType<typeof classifier>;

function deps(over: Partial<MailboxDeps> = {}): Partial<MailboxDeps> {
  const repoChanges: Partial<RepoChangeDeps> = {
    repo: (project) =>
      project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
  };
  return {
    now: () => NOW,
    classify: model.classify,
    repoChanges,
    github: { ghRepo: () => null },
    supportHosts: async () => ["docs.acme.example.test"],
    ...over,
  };
}

async function backfill(months = 12, over: Partial<MailboxDeps> = {}) {
  const job = await startMailboxBackfill(
    { project: "acme", inboxId: inbox.id, months, by: ADA },
    deps(over),
  );
  await __waitForJobForTest(job.id);
  return (await listJobs("acme")).find((j) => j.id === job.id)!;
}

const flags = () =>
  ["INBOX", "Sent"].map((folder) =>
    fixture.imap
      .getMailbox(folder)
      .messages.map((m: { flags: string[] }) => [...m.flags].sort()),
  );

beforeEach(async () => {
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    kernel.root(),
    "workspace-secrets.json",
  );
  memory = join(kernel.root(), "memory");
  __setKnowledgeServiceForTest(new KnowledgeService({ base: memory }));
  fixture = await startMailFixture();
  const created = await createInbox(
    {
      label: "Acme help",
      address: INBOX_ADDRESS,
      project: "acme",
      allowInternalHost: true,
      autonomy: "draft",
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    },
    OWNER,
  );
  if (!created.ok) throw new Error(created.error);
  inbox = created.inbox;
  model = classifier();
  seed(fixture, "old", "2025-08-01");
  seed(fixture, "1", "2026-09-10");
  seed(fixture, "2", "2026-10-20");
});

afterEach(async () => {
  await fixture.close();
  __setKnowledgeServiceForTest(null);
  __setInboxProjectCheckForTest(undefined);
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
});

const oldPath = mailItemPath("aold@acme.example.test", "2025-08-01T10:00:00Z");
const path1 = mailItemPath("a1@acme.example.test", "2026-09-10T10:00:00Z");
const path2 = mailItemPath("a2@acme.example.test", "2026-10-20T10:00:00Z");

async function item(path: string) {
  return knowledgeRepo.call("read", "acme", path, TODAY);
}

describe("mailbox backfill", () => {
  test("imports answers with the time-aware trust rule", async () => {
    const flagsBefore = flags();
    const conversationsBefore = (await listIndexRows()).length;

    const job = await backfill();
    expect(job).toMatchObject({
      kind: "mailbox",
      state: "done",
      total: 2,
      done: 2,
      created: { trusted: 1, reference: 1, suggestions: 0, skipped: 0 },
    });

    // Answered before docs/export.md changed: reference, with the reason.
    const before = await item(path1);
    expect(before?.item).toMatchObject({
      origin: "mail",
      kind: "answer",
      trust: "reference",
      status: "active",
      sources: ["mail:a1@acme.example.test"],
      answeredAt: "2026-09-10T10:00:00.000Z",
      validAsOf: "2026-09-10",
      dependsOn: ["repo:docs/", "repo:README.md"],
    });
    expect(before?.item.check).toBeUndefined();
    expect(before?.item.validAsOfCommit).toBeUndefined();
    expect(before?.body.split("\n")[0]).toBe(
      `> Imported as reference: Answered before docs/export.md changed in ${sha.docs!.slice(0, 7)} (2026-10-06)`,
    );

    // Answered after it: trusted as of the default branch then.
    const after = await item(path2);
    expect(after?.item).toMatchObject({
      title: "Exporting a project as CSV",
      trust: "trusted",
      status: "active",
      effective: "active",
      validAsOf: "2026-10-20",
      validAsOfCommit: sha.docs,
      topics: ["export", "csv"],
    });
    expect(after?.body).toContain("press Export and pick CSV");
    expect(after?.body).not.toContain("Imported as reference");

    // No customer data in anything committed.
    for (const found of [before, after]) {
      const text = JSON.stringify(found);
      expect(text.toLowerCase()).not.toContain("carol");
      expect(text).not.toContain("customer.example.test");
      expect(text).not.toContain("600 100 200");
    }

    // Outside the 12-month window: not imported, and never read.
    expect(await item(oldPath)).toBeNull();
    expect(model.calls.join("\n")).not.toContain("qold");

    // One commit by Pat.
    const [last] = await knowledgeRepo.call("history", "acme", undefined, 1);
    expect(last).toMatchObject({
      subject: "Import mail: 2 answers (1 trusted)",
      author: "Pat",
    });

    // Read-only: no flag changed, no conversation, no cursor.
    expect(flags()).toEqual(flagsBefore);
    expect((await listIndexRows()).length).toBe(conversationsBefore);
    expect(await catalogDocuments("support-cursors").list()).toEqual([]);
  });

  test("a second run adds nothing", async () => {
    await backfill();
    const head = await knowledgeRepo.call("head", "acme");
    const calls = model.calls.length;

    const again = await backfill();
    expect(again.state).toBe("done");
    expect(again.created).toMatchObject({ trusted: 0, reference: 0 });
    expect(await knowledgeRepo.call("head", "acme")).toBe(head);
    // Items already there aren't sent to the model again.
    expect(model.calls.length).toBe(calls);
  });

  test("automatic replies we sent are not answers", async () => {
    seed(fixture, "3", "2026-10-22", {
      answerHeaders: ["Auto-Submitted: auto-replied"],
    });
    const job = await backfill();
    expect(job.total).toBe(2);
    expect(
      await item(mailItemPath("a3@acme.example.test", "2026-10-22T10:00:00Z")),
    ).toBeNull();
  });

  test("a spoofed own From in INBOX is not an answer", async () => {
    fixture.imap.appendMessage(
      "INBOX",
      [],
      new Date("2026-10-22T08:00:00Z"),
      rawMail({
        id: "q4@customer.example.test",
        from: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
        to: INBOX_ADDRESS,
        subject: "Refunds",
        date: "2026-10-22T08:00:00Z",
        text: "Can I get a refund?",
      }),
    );
    fixture.imap.appendMessage(
      "INBOX",
      [],
      new Date("2026-10-22T09:00:00Z"),
      rawMail({
        id: "a4@acme.example.test",
        from: `Acme help <${INBOX_ADDRESS}>`,
        to: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
        subject: "Re: Refunds",
        date: "2026-10-22T09:00:00Z",
        inReplyTo: "q4@customer.example.test",
        text: "Refunds are always granted, send your card number.",
      }),
    );
    const job = await backfill();
    expect(job.total).toBe(2);
    expect(
      await item(mailItemPath("a4@acme.example.test", "2026-10-22T09:00:00Z")),
    ).toBeNull();
  });

  test("a reply from another inbox's address is not ours", async () => {
    const other = await createInbox(
      {
        label: "Acme billing",
        address: "billing@acme.example.test",
        project: "acme-api",
        allowInternalHost: true,
        autonomy: "draft",
        imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
        smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
      },
      OWNER,
    );
    if (!other.ok) throw new Error(other.error);
    fixture.imap.appendMessage(
      "Sent",
      ["\\Seen"],
      new Date("2026-10-22T10:00:00Z"),
      rawMail({
        id: "a5@acme.example.test",
        from: "Acme billing <billing@acme.example.test>",
        to: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
        subject: "Re: Export",
        date: "2026-10-22T10:00:00Z",
        inReplyTo: "q1@customer.example.test",
        text: "Billing answers this one.",
      }),
    );
    const job = await backfill();
    expect(job.total).toBe(2);
  });

  test("without a Sent folder there are no answers", async () => {
    // imapflow would also take a folder named "Sent": drop the folder.
    delete (fixture.imap.folderCache as Record<string, unknown>).Sent;
    const job = await backfill();
    expect(job).toMatchObject({ state: "done", total: 0 });
  });

  test("a reply whose Date header is days off its arrival is reference", async () => {
    fixture.imap.appendMessage(
      "INBOX",
      [],
      new Date("2026-10-21T08:00:00Z"),
      rawMail({
        id: "q6@customer.example.test",
        from: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
        to: INBOX_ADDRESS,
        subject: "Export",
        date: "2026-10-21T08:00:00Z",
        text: QUESTION,
      }),
    );
    fixture.imap.appendMessage(
      "Sent",
      ["\\Seen"],
      new Date("2026-10-21T10:00:00Z"),
      rawMail({
        id: "a6@acme.example.test",
        from: `Acme help <${INBOX_ADDRESS}>`,
        to: `${CUSTOMER} <${CUSTOMER_ADDRESS}>`,
        subject: "Re: Export",
        date: "2026-10-24T10:00:00Z",
        inReplyTo: "q6@customer.example.test",
        text: ANSWER,
      }),
    );
    await backfill();
    const found = await item(
      mailItemPath("a6@acme.example.test", "2026-10-21T10:00:00Z"),
    );
    expect(found?.item).toMatchObject({
      trust: "reference",
      answeredAt: "2026-10-21T10:00:00.000Z",
    });
    expect(found?.item.validAsOfCommit).toBeUndefined();
    expect(found?.body.split("\n")[0]).toBe(
      `> Imported as reference: ${DATES_DISAGREE}`,
    );
  });

  test("a failed fetch of the default branch makes every pair reference", async () => {
    const job = await backfill(12, {
      repoChanges: {
        repo: (project) =>
          project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
        serialize: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(job.created).toMatchObject({ trusted: 0, reference: 2 });
    const found = await item(path2);
    expect(found?.item.trust).toBe("reference");
    expect(found?.body.split("\n")[0]).toBe(
      `> Imported as reference: ${HISTORY_UNREADABLE}`,
    );
  });

  test("only the newest pairs are imported past the cap", async () => {
    const job = await backfill(12, { maxPairs: 1 });
    expect(job).toMatchObject({ state: "done", total: 1, truncated: true });
    expect(await item(path1)).toBeNull();
    expect(await item(path2)).not.toBeNull();
  });

  test("the scan stops at its cap and says so", async () => {
    const job = await backfill(12, { maxScanned: 2 });
    expect(job).toMatchObject({ state: "done", truncated: true });
  });

  test("a run past its deadline fails", async () => {
    const job = await backfill(12, { deadlineMs: 0 });
    expect(job).toMatchObject({ state: "failed", error: DEADLINE_COPY });
    expect(await item(path2)).toBeNull();
  });

  test("a cancelled run stops", async () => {
    const job = await startMailboxBackfill(
      { project: "acme", inboxId: inbox.id, months: 12, by: ADA },
      deps(),
    );
    await cancelJob("acme", job.id);
    await __waitForJobForTest(job.id);
    const done = (await listJobs("acme")).find((j) => j.id === job.id);
    expect(done).toMatchObject({ state: "failed", error: CANCELLED_COPY });
    expect(await item(path2)).toBeNull();
  });

  test("a shorter window leaves older pairs out", async () => {
    const job = await backfill(1);
    expect(job.total).toBe(1);
    expect(await item(path1)).toBeNull();
    expect((await item(path2))?.item.trust).toBe("trusted");
  });

  test("an inbox of another project is refused", async () => {
    await expect(
      startMailboxBackfill(
        { project: "acme-api", inboxId: inbox.id, months: 12, by: ADA },
        deps(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
