import { readFile } from "node:fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { withFileLock } from "./shared/file-lock";

/** Merge one title into the registry under its cross-process lock
 * (shared/file-lock.ts). */
export async function writeGeneratedTitleRegistry(
  path: string,
  id: string,
  title: string,
): Promise<void> {
  await withFileLock(
    path,
    async () => {
      let registry: Record<string, string> = {};
      try {
        registry = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        // An unreadable or malformed registry must not be replaced with a partial map.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeJsonAtomicAsync(path, { ...registry, [id]: title });
    },
    "Title registry",
  );
}
