import { expect, test } from "bun:test";
import type { KnowledgeImportJob } from "../../../shared/knowledge";
import {
  FILE_TOO_BIG_COPY,
  FILE_TYPES_COPY,
  TOO_MANY_FILES_COPY,
  ZIP_COPY,
} from "../../../server/knowledge/ingest/files";
import {
  BACKFILL_MONTH_CHOICES,
  DEFAULT_IMPORT_MONTHS,
  FILE_ACCEPT,
  JOB_POLL_MS,
  checkFiles,
  importChoices,
  jobError,
  jobTitle,
  jobProgress,
  monthsLabel,
  pollJobs,
  websiteCardLine,
  websiteHosts,
} from "./import-model";

function job(over: Partial<KnowledgeImportJob> = {}): KnowledgeImportJob {
  return {
    id: "kj_1",
    project: "acme",
    kind: "mailbox",
    state: "done",
    startedAt: "2026-10-26T10:00:00.000Z",
    done: 0,
    total: null,
    created: { trusted: 0, reference: 0, suggestions: 0, skipped: 0 },
    options: {},
    ...over,
  };
}

const INBOXES = [
  {
    id: "inb_1",
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
  },
  {
    id: "inb_2",
    label: "Other help",
    address: "help@other.example.test",
    project: "other",
  },
  {
    id: "inb_3",
    label: "Acme billing",
    address: "billing@acme.example.test",
    project: "acme",
  },
];

test("importChoices offers only this project's inboxes", () => {
  expect(importChoices(INBOXES, "acme")).toEqual([
    { value: "inb_1", label: "Acme help (help@acme.example.test)" },
    { value: "inb_3", label: "Acme billing (billing@acme.example.test)" },
  ]);
  expect(importChoices(INBOXES, "acme-api")).toEqual([]);
});

test("jobs are polled every 2 s while one is queued or running, then not", () => {
  expect(JOB_POLL_MS).toBe(2_000);
  expect(pollJobs(undefined)).toBe(0);
  expect(pollJobs([])).toBe(0);
  expect(pollJobs([job({ state: "running" }), job()])).toBe(2_000);
  expect(pollJobs([job({ state: "queued" })])).toBe(2_000);
  expect(pollJobs([job(), job({ state: "failed", error: "Cancelled." })])).toBe(
    0,
  );
});

test("a wildcard host is listed as skipped", () => {
  expect(
    websiteHosts([
      { host: "help.acme.example.test", roles: ["support"], knowledge: true },
      { host: "*.acme.example.test", roles: ["support"], knowledge: true },
      { host: "*", roles: ["support", "automations"], knowledge: true },
      {
        host: "docs.acme.example.test",
        roles: ["automations"],
        knowledge: true,
      },
      { host: "Help.Acme.Example.Test", roles: ["support"], knowledge: true },
      {
        host: "status.acme.example.test:8443",
        roles: ["support"],
        knowledge: true,
      },
      // Links-only: a Support website not used as knowledge.
      { host: "blog.acme.example.test", roles: ["support"] },
    ]),
  ).toEqual([
    { host: "help.acme.example.test", skipped: null },
    { host: "*.acme.example.test", skipped: "skipped: wildcard" },
    { host: "*", skipped: "skipped: wildcard" },
    { host: "status.acme.example.test:8443", skipped: null },
  ]);
});

test("the mailbox window is 3 to 36 months, 12 by default", () => {
  expect(BACKFILL_MONTH_CHOICES).toEqual([3, 6, 12, 24, 36]);
  expect(DEFAULT_IMPORT_MONTHS).toBe(12);
  expect(monthsLabel(12)).toBe("Last 12 months");
  expect(monthsLabel(1)).toBe("Last month");
});

test("files the server would refuse are named with its reason", () => {
  expect(FILE_ACCEPT).toBe(".md,.markdown,.txt,.html,.pdf");
  const mb = 1024 * 1024;
  const checked = checkFiles([
    { name: "guide.md", type: "text/markdown", size: 10 },
    { name: "export.zip", type: "application/zip", size: 10 },
    { name: "notes.docx", type: "", size: 10 },
    { name: "manual.pdf", type: "application/pdf", size: 11 * mb },
    { name: "faq.HTML", type: "text/html", size: 10 },
  ]);
  expect(checked.accepted.map((f) => f.name)).toEqual(["guide.md", "faq.HTML"]);
  expect(checked.refused).toEqual([
    { name: "export.zip", reason: ZIP_COPY },
    { name: "notes.docx", reason: FILE_TYPES_COPY },
    { name: "manual.pdf", reason: FILE_TOO_BIG_COPY },
  ]);
  expect(checked.error).toBeNull();
});

test("more than 20 files is refused as a whole", () => {
  const files = Array.from({ length: 21 }, (_, i) => ({
    name: `${i}.md`,
    type: "text/markdown",
    size: 1,
  }));
  const checked = checkFiles(files);
  expect(checked.error).toBe(TOO_MANY_FILES_COPY);
  expect(checked.accepted).toEqual([]);
});

test("progress is a share of the total, unknown without one", () => {
  expect(jobProgress(job({ state: "running", done: 30, total: 120 }))).toBe(25);
  expect(jobProgress(job({ state: "running", done: 3, total: null }))).toBe(
    null,
  );
  expect(jobProgress(job({ state: "running", done: 0, total: 0 }))).toBe(0);
  expect(jobProgress(job({ state: "done", done: 3, total: null }))).toBe(100);
});

test("a failed job names the failure on its own line; a cancelled one doesn't", () => {
  const failed = job({
    state: "failed",
    error: "The mail server refused the password",
  });
  expect(jobTitle(failed)).toBe("Mailbox · Failed");
  expect(jobError(failed)).toBe("The mail server refused the password");
  const cancelled = job({
    kind: "website",
    state: "failed",
    error: "Cancelled.",
  });
  expect(jobTitle(cancelled)).toBe("Website · Cancelled");
  expect(jobError(cancelled)).toBeNull();
  const running = job({ state: "running", done: 3, total: 10 });
  expect(jobTitle(running)).toBe("Mailbox · 3 of 10");
  expect(jobError(running)).toBeNull();
});

test("the website card says which sites it reads, or how to add one", () => {
  expect(websiteCardLine(null)).toEqual({
    text: "Support websites used as knowledge",
  });
  expect(websiteCardLine(0)).toEqual({
    text: "No Support website is used as knowledge yet.",
    link: "Turn one on in Access",
  });
  expect(websiteCardLine(2)).toEqual({
    text: "Support websites used as knowledge, up to 200 pages.",
    link: "Edit in Access",
  });
});
