/**
 * Runs one knowledge call from the gateway against a KnowledgeService.
 * Used by memory-repo-worker.ts (and the in-process test backend), so the
 * method list is enforced in one place: anything not in KNOWLEDGE_METHODS
 * is refused. Index calls (`index.<method>`) first bring the project's index
 * up to date with `service.fresh`, which throws when it can't: a reader never
 * gets an answer from an index older than the repository.
 */

import { MemoryRepoError } from "../memory-repo/git-store";
import { KNOWLEDGE_METHODS } from "../memory-repo/protocol";
import type { KnowledgeService } from "./service";

const ALLOWED: ReadonlySet<string> = new Set(KNOWLEDGE_METHODS);

type Callable = Record<string, (...args: unknown[]) => unknown>;

export async function dispatchKnowledge(
  service: KnowledgeService,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!ALLOWED.has(method))
    throw new Error(`Unknown knowledge method ${method}`);
  if (method.startsWith("index.")) {
    const project = args[0];
    if (typeof project !== "string")
      throw new MemoryRepoError("A knowledge index call needs a project.");
    await service.fresh(project);
    const name = method.slice("index.".length);
    return (service.index as unknown as Callable)[name].apply(
      service.index,
      args,
    );
  }
  return (service as unknown as Callable)[method].apply(service, args);
}
