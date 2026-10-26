/**
 * Gateway-side facade for project knowledge.
 *
 * KnowledgeService and its index run on the memory-repo worker
 * (memory-repo-worker.ts, call target "knowledge"); this module only types
 * the calls. Nothing starts at import: the worker starts on the first call.
 * Index calls are named `index.<method>` and always run after the project's
 * index caught up with its repository (knowledge/dispatch.ts).
 *
 * Errors keep their meaning across the thread: MemoryRepoError keeps its
 * status, KnowledgeConflictError comes back as itself (409).
 */

import {
  __setKnowledgeServiceForTest as setServiceForTest,
  callKnowledge,
} from "../memory-repo/client";
import type { KnowledgeMethod } from "../memory-repo/protocol";
import type { KnowledgeIndex } from "./index-store";
import type { KnowledgeService } from "./service";

type AnyFn = (...args: never[]) => unknown;

type Target<M extends KnowledgeMethod> = M extends `index.${infer N}`
  ? N extends keyof KnowledgeIndex
    ? KnowledgeIndex[N]
    : never
  : M extends keyof KnowledgeService
    ? KnowledgeService[M]
    : never;

export type KnowledgeArgs<M extends KnowledgeMethod> =
  Target<M> extends AnyFn ? Parameters<Target<M>> : never;
export type KnowledgeResult<M extends KnowledgeMethod> =
  Target<M> extends AnyFn ? Awaited<ReturnType<Target<M>>> : never;

/** How long a project's "no knowledge repository" answer is reused. */
export const NO_REPO_TTL_MS = 60_000;

/** Projects the worker said have no knowledge repository, until when.
 *  Only the negative answer is kept: a project with a repository always
 *  asks, so a worker outage still fails its checks closed. Every
 *  repository is created through `call("ensureRepo")` here, which drops
 *  the entry and bumps `generation`, so an answer read across a creation
 *  is never kept. */
const noRepoUntil = new Map<string, number>();
let generation = 0;

export function __setKnowledgeServiceForTest(
  ...args: Parameters<typeof setServiceForTest>
): void {
  noRepoUntil.clear();
  setServiceForTest(...args);
}

export const knowledgeRepo = {
  call<M extends KnowledgeMethod>(
    method: M,
    ...args: KnowledgeArgs<M>
  ): Promise<KnowledgeResult<M>> {
    if (method !== "ensureRepo")
      return callKnowledge(method, args) as Promise<KnowledgeResult<M>>;
    const project = String(args[0]);
    const forget = () => {
      generation++;
      noRepoUntil.delete(project);
    };
    forget();
    return (callKnowledge(method, args) as Promise<KnowledgeResult<M>>).then(
      (value) => (forget(), value),
      (error: unknown) => {
        forget();
        throw error;
      },
    );
  },
  /** Whether `project` has a knowledge repository, reusing a "no" for
   *  NO_REPO_TTL_MS (see noRepoUntil). Throws as the call does. */
  async hasRepo(project: string, now = Date.now()): Promise<boolean> {
    const until = noRepoUntil.get(project);
    if (until !== undefined && until > now) return false;
    const before = generation;
    const has = await knowledgeRepo.call("hasRepo", project);
    if (has) noRepoUntil.delete(project);
    else if (generation === before)
      noRepoUntil.set(project, now + NO_REPO_TTL_MS);
    return Boolean(has);
  },
};
