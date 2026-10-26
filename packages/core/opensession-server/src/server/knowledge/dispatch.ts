/**
 * Runs one knowledge call from the gateway against a KnowledgeService.
 * Used by memory-repo-worker.ts (and the in-process test backend), so the
 * method list is enforced in one place: anything not in KNOWLEDGE_METHODS
 * is refused. Index calls (`index.<method>`) never reach a stale index:
 * when KnowledgeService has a method of that name (its fail-closed wrapper,
 * which awaits `fresh` itself) that method runs; otherwise the project's
 * index is brought up to date with `service.fresh` first. `fresh` throws
 * when it can't reindex, so the reader gets an error, not old data.
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
    const name = method.slice("index.".length);
    const wrapper = (service as unknown as Partial<Callable>)[name];
    if (typeof wrapper === "function") return wrapper.apply(service, args);
    await service.fresh(project);
    return (service.index as unknown as Callable)[name].apply(
      service.index,
      args,
    );
  }
  return (service as unknown as Callable)[method].apply(service, args);
}
