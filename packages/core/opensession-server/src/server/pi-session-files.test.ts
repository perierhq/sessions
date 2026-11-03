import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths";
import {
  piRemoteContextDir,
  piSessionDir,
  piSessionDirsToSweep,
  removePiSessionFiles,
  sweepOrphanPiSessionFiles,
} from "./pi-session-files";

const STATE = mkdtempSync(join(tmpdir(), "pi-session-files-test-"));
const PREV_STATE = process.env.OPENSESSION_STATE_DIR;

// Re-pin per test: another file's afterAll can restore OPENSESSION_STATE_DIR
// mid-suite and redirect later writes (same guard as session-scratch.test.ts).
beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = STATE;
});
afterAll(() => {
  if (PREV_STATE === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = PREV_STATE;
});

const NOW = Date.parse("2026-08-18T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What pi writes for a session: its native jsonl and a turn checkpoint. */
function writePiFiles(sessionId: string): string {
  const dir = piSessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-08-18T10-00-00_acme.jsonl"),
    `${JSON.stringify({ type: "session", id: "pi-acme" })}\n`,
  );
  writeFileSync(join(dir, "turn-checkpoint.json"), "{}");
  return dir;
}

describe("piSessionDir", () => {
  it("names the session's dir under the pi state root", () => {
    expect(piSessionDir("os-acme")).toBe(
      join(stateDir("pi"), "sessions", "os-acme"),
    );
    expect(piSessionDir("os-acme")).toStartWith(STATE);
    expect(piRemoteContextDir("os-acme")).toBe(
      join(stateDir("pi"), "remote-context", "os-acme"),
    );
  });

  it("sanitizes the id the way pi's session setup does", () => {
    expect(piSessionDir("bks-ghpr-acme/app-12")).toBe(
      join(stateDir("pi"), "sessions", "bks-ghpr-acme_app-12"),
    );
  });
});

describe("removePiSessionFiles", () => {
  it("removes the session's pi transcript files and its mirrored context", async () => {
    const dir = writePiFiles("os-delete-me");
    const context = piRemoteContextDir("os-delete-me");
    mkdirSync(context, { recursive: true });
    writeFileSync(join(context, "AGENTS.md"), "# acme");
    const other = writePiFiles("os-keep-me");

    await removePiSessionFiles("os-delete-me");

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(context)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("never removes the whole store for an id that sanitizes to a path step", async () => {
    const other = writePiFiles("os-still-here");
    await removePiSessionFiles("");
    await removePiSessionFiles(".");
    await removePiSessionFiles("..");
    expect(existsSync(other)).toBe(true);
  });
});

describe("piSessionDirsToSweep", () => {
  const old = (name: string) => ({ name, mtimeMs: NOW - 30 * DAY });

  it("sweeps a session id's dir once no session owns it and it is past the horizon", () => {
    expect(
      piSessionDirsToSweep(
        [old("os-gone"), old("bks-gone")],
        [{ id: "os-live" }],
        NOW,
      ),
    ).toEqual(["os-gone", "bks-gone"]);
  });

  it("keeps a live session's dir whatever its age, aliases included", () => {
    expect(
      piSessionDirsToSweep(
        [old("os-live"), old("os-older-id"), old("bks-ghpr-acme_app-12")],
        [
          { id: "os-live", aliasIds: ["os-older-id"] },
          { id: "bks-ghpr-acme/app-12" },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("keeps an ownerless dir until its own mtime is past the horizon", () => {
    expect(
      piSessionDirsToSweep(
        [{ name: "os-just-deleted", mtimeMs: NOW - HOUR }],
        [{ id: "os-live" }],
        NOW,
      ),
    ).toEqual([]);
  });

  it("leaves dirs that are not a session's: workflow agents, one-shots", () => {
    expect(
      piSessionDirsToSweep(
        [
          old("oneshot-0b9c"),
          old("comment-answer-0b9c"),
          old("rh-0b9c"),
          old("0b9c-run-key"),
        ],
        [{ id: "os-live" }],
        NOW,
      ),
    ).toEqual([]);
  });

  it("sweeps nothing when it knows no session at all", () => {
    expect(piSessionDirsToSweep([old("os-gone")], [], NOW)).toEqual([]);
  });
});

describe("sweepOrphanPiSessionFiles", () => {
  it("removes an orphan session's pi files from disk and keeps a live one's", async () => {
    const live = writePiFiles("os-sweep-live");
    const orphan = writePiFiles("os-sweep-orphan");
    const stale = (Date.now() - 30 * DAY) / 1000;
    utimesSync(live, stale, stale);
    utimesSync(orphan, stale, stale);

    const removed = await sweepOrphanPiSessionFiles([{ id: "os-sweep-live" }]);

    expect(removed).toContain("os-sweep-orphan");
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
