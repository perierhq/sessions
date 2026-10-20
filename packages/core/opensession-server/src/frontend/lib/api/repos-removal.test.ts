import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { removeRepoApi } from "./repos";

type Reply = Response | Error;
let replies: Record<string, Reply> = {};
let calls: string[] = [];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  calls = [];
  replies = {};
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const key = `${init?.method || "GET"} ${new URL(String(url), "http://localhost").pathname.replace(/^.*\/api/, "")}`;
        calls.push(key);
        const reply = replies[key];
        if (!reply)
          return Response.json({ error: "unexpected" }, { status: 500 });
        if (reply instanceof Error) throw reply;
        return reply.clone();
      },
      { preconnect() {} },
    ),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
});

const DELETE = "DELETE /setup/repos/widget";
const PREVIEW = "GET /setup/repos/widget/removal";
const STATUS = "GET /setup/repos/widget/removal-status";
const request = { deleteFiles: true, planToken: "a".repeat(32) };

test("a lost answer with the repository gone counts as removed", async () => {
  replies[DELETE] = new TypeError("Load failed");
  replies[PREVIEW] = Response.json({ error: "Unknown" }, { status: 404 });
  replies[STATUS] = Response.json({
    id: "widget",
    state: "deleting",
    startedAt: "x",
    plan: ["/a"],
  });

  const outcome = await removeRepoApi("widget", request);

  expect(outcome).toMatchObject({
    removed: true,
    deleting: true,
    plan: ["/a"],
  });
  expect(calls).toEqual([DELETE, PREVIEW, STATUS]);
});

test("a gateway timeout is checked the same way", async () => {
  replies[DELETE] = new Response("Gateway Timeout", { status: 504 });
  replies[PREVIEW] = Response.json({ error: "Unknown" }, { status: 404 });
  replies[STATUS] = Response.json({ error: "none" }, { status: 404 });

  const outcome = await removeRepoApi("widget", request);

  // Gone, but nothing says what happened to its files.
  expect(outcome).toMatchObject({ id: "widget", filesUnknown: true });
});

test("a lost answer with the repository still there is a failure", async () => {
  replies[DELETE] = new TypeError("Load failed");
  replies[PREVIEW] = Response.json({ id: "widget" });

  await expect(removeRepoApi("widget", request)).rejects.toThrow("Load failed");
});
