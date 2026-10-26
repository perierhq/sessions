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
  __setKnowledgeServiceForTest,
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

export { __setKnowledgeServiceForTest };

export const knowledgeRepo = {
  call<M extends KnowledgeMethod>(
    method: M,
    ...args: KnowledgeArgs<M>
  ): Promise<KnowledgeResult<M>> {
    return callKnowledge(method, args) as Promise<KnowledgeResult<M>>;
  },
};
