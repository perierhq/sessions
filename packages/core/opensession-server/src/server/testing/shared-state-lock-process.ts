/**
 * One contender for a claude-account-shared-state lock, run in a process of
 * its own. Waits until `startAt` so every contender tries at once, takes the
 * lock, holds it for `holdMs`, and appends the interval it held it to `log`
 * before releasing.
 *
 * Usage: bun shared-state-lock-process.ts <lock> <log> <holdMs> <startAt>
 */
import { appendFileSync } from "fs";
import { __lockForTest as lock } from "../claude-account-shared-state";

const [path, log, holdMs, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) Bun.sleepSync(1);
const deadline = Date.now() + 5_000;
let handle = lock.acquire(path!);
while (!handle && Date.now() < deadline) {
  Bun.sleepSync(1);
  handle = lock.acquire(path!);
}
if (!handle) process.exit(2);
const from = Date.now();
Bun.sleepSync(Number(holdMs));
appendFileSync(log!, JSON.stringify({ from, to: Date.now() }) + "\n");
lock.release(handle);
