// The sessions active at a graceful shutdown are kept next to the session
// store, not inside it: everything in `sessions/` is read as a session
// record. An older install's file there is read once and moved.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readShutdownSnapshot,
  shutdownSnapshotPath,
  writeShutdownSnapshot,
} from "./shutdown-snapshot";

const root = mkdtempSync(join(tmpdir(), "shutdown-snapshot-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function store(name: string) {
  const sessions = join(root, name, "sessions");
  mkdirSync(sessions, { recursive: true });
  return sessions;
}

test("the snapshot lives beside the sessions directory", () => {
  const sessions = store("beside");
  expect(shutdownSnapshotPath(sessions)).toBe(
    join(root, "beside", "active-at-shutdown.json"),
  );
  writeShutdownSnapshot(sessions, [{ osSessionId: "os-acme" }]);
  expect(existsSync(join(sessions, "active-at-shutdown.json"))).toBe(false);
  expect(readShutdownSnapshot(sessions)).toEqual([{ osSessionId: "os-acme" }]);
});

test("an older snapshot inside sessions/ is read once and moved out", () => {
  const sessions = store("legacy");
  const legacy = join(sessions, "active-at-shutdown.json");
  writeFileSync(legacy, JSON.stringify([{ osSessionId: "os-old" }]));
  expect(readShutdownSnapshot(sessions)).toEqual([{ osSessionId: "os-old" }]);
  expect(existsSync(legacy)).toBe(false);
  expect(
    JSON.parse(readFileSync(shutdownSnapshotPath(sessions), "utf-8")),
  ).toEqual([{ osSessionId: "os-old" }]);
  expect(readShutdownSnapshot(sessions)).toEqual([{ osSessionId: "os-old" }]);
});

test("a write retires an older snapshot left inside sessions/", () => {
  const sessions = store("retire");
  const legacy = join(sessions, "active-at-shutdown.json");
  writeFileSync(legacy, "[]");
  writeShutdownSnapshot(sessions, []);
  expect(existsSync(legacy)).toBe(false);
  expect(readShutdownSnapshot(sessions)).toEqual([]);
});

test("nothing recorded reads as an empty list", () => {
  expect(readShutdownSnapshot(store("empty"))).toEqual([]);
});
