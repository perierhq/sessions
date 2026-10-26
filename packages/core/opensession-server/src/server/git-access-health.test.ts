import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_ACCESS_BASE_BACKOFF_MS,
  GIT_ACCESS_MAX_BACKOFF_MS,
  __setGitAccessSeamsForTest,
  classifyGitFetchFailure,
  gitAccessBackoffMs,
  gitAccessDue,
  gitAccessIssue,
  gitErrorLine,
  recordGitAccessFailure,
  recordGitAccessOk,
} from "./git-access-health";
import type { NotificationEvent } from "./notification-threads";
import { cleanDocument, applyNotificationEvent } from "./notification-threads";

const BAD_TOKEN = [
  "remote: Invalid username or token. Password authentication is not supported for Git operations.",
  "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
].join("\n");
const HELPER_DENIED = [
  "/srv/other-install/bin/opensession github-credential get: Permission denied",
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
].join("\n");

let root = "";
const savedStateDir = process.env.OPENSESSION_STATE_DIR;
let now = Date.parse("2026-10-25T21:39:00.000Z");
let told: NotificationEvent[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "os-git-access-"));
});

afterAll(() => {
  if (savedStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = savedStateDir;
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function fresh(): void {
  process.env.OPENSESSION_STATE_DIR = join(root, `state-${++n}`);
  now = Date.parse("2026-10-25T21:39:00.000Z");
  told = [];
  __setGitAccessSeamsForTest({
    now: () => now,
    notify: async (event) => {
      told.push(event);
    },
  });
}

afterEach(() => __setGitAccessSeamsForTest(undefined));

test("sign-in failures are told apart from other fetch failures", () => {
  expect(classifyGitFetchFailure(BAD_TOKEN)).toBe("auth");
  expect(classifyGitFetchFailure(HELPER_DENIED)).toBe("helper");
  expect(
    classifyGitFetchFailure(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ),
  ).toBe("auth");
  expect(
    classifyGitFetchFailure(
      "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
    ),
  ).toBeNull();
  expect(
    classifyGitFetchFailure("fatal: couldn't find remote ref refs/heads/trunk"),
  ).toBeNull();
});

test("the error line is the one that says why", () => {
  expect(gitErrorLine(BAD_TOKEN)).toStartWith("remote: Invalid username");
  expect(gitErrorLine(HELPER_DENIED)).toContain("Permission denied");
});

test("backoff doubles from five minutes up to six hours", () => {
  expect(gitAccessBackoffMs(1)).toBe(GIT_ACCESS_BASE_BACKOFF_MS);
  expect(gitAccessBackoffMs(2)).toBe(2 * GIT_ACCESS_BASE_BACKOFF_MS);
  expect(gitAccessBackoffMs(4)).toBe(8 * GIT_ACCESS_BASE_BACKOFF_MS);
  expect(gitAccessBackoffMs(50)).toBe(GIT_ACCESS_MAX_BACKOFF_MS);
});

test("ten hours of a broken token: a handful of tries and one alert", async () => {
  fresh();
  const end = now + 10 * 60 * 60_000;
  let tries = 0;
  // The warm-template sweep asks every five minutes.
  for (; now < end; now += 5 * 60_000) {
    if (!gitAccessDue("acme")) continue;
    tries++;
    await recordGitAccessFailure({ id: "acme", label: "Acme" }, BAD_TOKEN);
  }
  expect(tries).toBeLessThanOrEqual(10);
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({
    kind: "access_failing",
    subject: { type: "repo", id: "acme", title: "Acme" },
    url: "/settings/projects/acme",
  });
  expect(told[0]!.body).toContain("Invalid username or token");
  const issue = gitAccessIssue("acme");
  expect(issue).toMatchObject({
    kind: "auth",
    failures: tries,
    notified: true,
  });
});

test("a restart keeps the backoff and does not alert again", async () => {
  fresh();
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  expect(told).toHaveLength(1);
  // Same state file, as after a restart.
  now += GIT_ACCESS_BASE_BACKOFF_MS - 1;
  expect(gitAccessDue("acme")).toBe(false);
  now += 1;
  expect(gitAccessDue("acme")).toBe(true);
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  expect(told).toHaveLength(1);
});

test("a fetch that works closes the issue and settles the row quietly", async () => {
  fresh();
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  await recordGitAccessOk({ id: "acme" });
  expect(gitAccessIssue("acme")).toBeNull();
  expect(gitAccessDue("acme")).toBe(true);
  expect(told).toHaveLength(2);
  expect(told[1]).toMatchObject({
    kind: "access_failing",
    delivery: "quiet",
    existingOnly: true,
  });
  // A later break is a new issue: the owner hears about it again.
  now += 60 * 60_000;
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  expect(told).toHaveLength(3);
  expect(told[2]!.eventKey).not.toBe(told[0]!.eventKey);
});

test("other failures leave no issue and no backoff", async () => {
  fresh();
  const issue = await recordGitAccessFailure(
    { id: "acme" },
    "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
  );
  expect(issue).toBeNull();
  expect(gitAccessIssue("acme")).toBeNull();
  expect(gitAccessDue("acme")).toBe(true);
  expect(told).toHaveLength(0);
});

test("a fetch with no token to offer: the App isn't installed for the repository", async () => {
  fresh();
  const repo = { id: "acme", label: "Acme", ghRepo: "acme/app" };
  const NO_ANSWER =
    "fatal: could not read Username for 'https://github.com': No such device or address";
  const issue = await recordGitAccessFailure(repo, NO_ANSWER, {
    token: false,
  });
  expect(issue).toMatchObject({ kind: "not-installed", ghRepo: "acme/app" });
  expect(told).toHaveLength(1);
  expect(told[0]?.reason).toBe("The GitHub App isn't installed for acme/app");
  expect(told[0]?.body).toContain("Install the GitHub App on acme");
  // A token that was handed over and refused stays a refused credential.
  fresh();
  expect(
    await recordGitAccessFailure(repo, BAD_TOKEN, { token: true }),
  ).toMatchObject({ kind: "auth" });
  expect(told[0]?.reason).toBe("Git can't sign in to GitHub");
  // Other failures are not sign-in failures, token or not.
  expect(
    await recordGitAccessFailure(repo, "fatal: unable to access: Could not resolve host", {
      token: false,
    }),
  ).toBeNull();
});

test("a different cause is a new issue, and the owner hears about it", async () => {
  fresh();
  const repo = { id: "acme", label: "Acme", ghRepo: "acme/app" };
  await recordGitAccessFailure(repo, BAD_TOKEN, { token: true });
  now += GIT_ACCESS_BASE_BACKOFF_MS;
  await recordGitAccessFailure(repo, BAD_TOKEN, { token: true });
  expect(gitAccessIssue("acme")?.failures).toBe(2);
  expect(told).toHaveLength(1);
  now += 2 * GIT_ACCESS_BASE_BACKOFF_MS;
  const issue = await recordGitAccessFailure(repo, BAD_TOKEN, {
    token: false,
  });
  expect(issue).toMatchObject({
    kind: "not-installed",
    failures: 1,
    since: new Date(now).toISOString(),
  });
  expect(told).toHaveLength(2);
  expect(told[1]?.eventKey).not.toBe(told[0]?.eventKey);
});

test("an owner who could not be told is told on the next failure", async () => {
  fresh();
  let fail = true;
  __setGitAccessSeamsForTest({
    now: () => now,
    notify: async (event) => {
      if (fail) throw new Error("catalog down");
      told.push(event);
    },
  });
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  expect(gitAccessIssue("acme")?.notified).toBeUndefined();
  fail = false;
  now += GIT_ACCESS_BASE_BACKOFF_MS;
  await recordGitAccessFailure({ id: "acme" }, BAD_TOKEN);
  expect(told).toHaveLength(1);
  expect(gitAccessIssue("acme")?.notified).toBe(true);
});

test("the inbox keeps an access row", () => {
  const event: NotificationEvent = {
    kind: "access_failing",
    subject: { type: "repo", id: "acme", title: "Acme" },
    reason: "Git can't sign in to GitHub",
    body: "remote: Invalid username or token.",
    url: "/settings/projects/acme",
    eventKey: "git-access:acme:1",
    at: now,
  };
  const { doc, thread, delivery } = applyNotificationEvent(
    { threads: [] },
    event,
  );
  expect(delivery).toBe("alert");
  expect(thread?.id).toBe("repo:acme");
  expect(cleanDocument(doc).threads).toHaveLength(1);
});
