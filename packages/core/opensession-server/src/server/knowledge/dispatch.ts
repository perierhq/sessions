/**
 * Runs one knowledge call from the gateway against a KnowledgeService.
 * Used by memory-repo-worker.ts (and the in-process test backend), so the
 * method list is enforced in one place: anything not in KNOWLEDGE_METHODS
 * is refused. Each index call (`index.<method>`) maps to the service method
 * that runs `service.fresh` first, which throws when it can't: a reader
 * never gets an answer from an index older than the repository, and no
 * index method is reachable without that check.
 */

import { MemoryRepoError } from "../memory-repo/git-store";
import {
  KNOWLEDGE_METHODS,
  type KnowledgeMethod,
} from "../memory-repo/protocol";
import type { KnowledgeService } from "./service";

const ALLOWED: ReadonlySet<string> = new Set(KNOWLEDGE_METHODS);

type IndexCall = Extract<KnowledgeMethod, `index.${string}`>;
type Params<M extends keyof KnowledgeService> = KnowledgeService[M] extends (
  ...args: infer P
) => unknown
  ? P
  : never;

/** Every index call and the fresh-first service method that answers it. */
const INDEX_CALLS: Record<
  IndexCall,
  (service: KnowledgeService, args: unknown[]) => Promise<unknown>
> = {
  "index.search": (service, args) =>
    service.search(...(args as Params<"search">)),
  "index.list": (service, args) => service.list(...(args as Params<"list">)),
  "index.counts": (service, args) =>
    service.counts(...(args as Params<"counts">)),
  "index.get": (service, args) => service.get(...(args as Params<"get">)),
  "index.internalBodies": (service, args) =>
    service.internalBodies(...(args as Params<"internalBodies">)),
  "index.dependents": (service, args) =>
    service.dependents(...(args as Params<"dependents">)),
};

type Callable = Record<string, (...args: unknown[]) => unknown>;

export async function dispatchKnowledge(
  service: KnowledgeService,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!ALLOWED.has(method))
    throw new Error(`Unknown knowledge method ${method}`);
  if (method.startsWith("index.")) {
    if (typeof args[0] !== "string")
      throw new MemoryRepoError("A knowledge index call needs a project.");
    return INDEX_CALLS[method as IndexCall](service, args);
  }
  return (service as unknown as Callable)[method].apply(service, args);
}
