/**
 * Cross-process lock around a read-merge-write of a small state file, for
 * files more than one gateway process can write (an old and a new gateway
 * overlap during a restart).
 *
 * A shell child holds an OS lock on `<path>.lock` while `fn` runs. Closing its
 * stdin (including on gateway death) releases the lock. No source helper is
 * re-executed, so this works in compiled installs without Bun on PATH. The
 * lock file is never unlinked: existing waiters must keep locking the same
 * inode.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

async function lockReady(stream: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let line = "";
  try {
    while (line.length < "LOCKED\n".length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      line += decoder.decode(chunk.value, { stream: true });
    }
    return line === "LOCKED\n";
  } finally {
    reader.releaseLock();
  }
}

/** Run `fn` while holding the lock for `path`. Rejects when the lock cannot
 * be taken within ten seconds; `fn` then does not run. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  what = "State file",
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/lockf", "-k", "-t", "10", lock]
      : ["flock", "-w", "10", lock];
  const child = Bun.spawn(
    [...command, "/bin/sh", "-c", "printf 'LOCKED\\n'; /bin/cat >/dev/null"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  try {
    if (!(await lockReady(child.stdout)))
      throw new Error(`${what} lock was not acquired`);
    return await fn();
  } finally {
    child.stdin.end();
    const [code, error] = await Promise.all([child.exited, stderr]);
    if (code !== 0)
      throw new Error(`${what} lock failed (${code}): ${error.trim()}`);
  }
}
