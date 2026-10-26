/** Messages between the memory-repo client and memory-repo-worker.ts. */

import type { MemoryRepoServiceOptions } from "./service";

export type MemoryRepoWorkerTarget = "service" | "index" | "knowledge";

export type MemoryRepoWorkerRequest =
  | { t: "open"; options: MemoryRepoServiceOptions }
  | {
      t: "call";
      id: number;
      /** "service.<method>", "index.<method>" (memory) or "knowledge"
       *  (knowledge/dispatch.ts; its index calls are named "index.<method>"). */
      target: MemoryRepoWorkerTarget;
      method: string;
      args: unknown[];
    };

export type MemoryRepoWorkerResponse =
  | { t: "ok"; id: number; value: unknown }
  | { t: "error"; id: number; name: string; message: string; status?: number };

/** Service methods the gateway may call. Anything else is refused. */
export const SERVICE_METHODS = [
  "ensureRepo",
  "listRepos",
  "repoExists",
  "head",
  "refresh",
  "fresh",
  "freshAll",
  "installHooks",
  "addEntry",
  "updateEntry",
  "removeEntries",
  "restoreEntry",
  "mergeEntries",
  "history",
  "diff",
  "revert",
  "readFile",
  "remoteUrl",
  "remoteStatus",
  "setRemote",
  "syncRemote",
  "syncAllRemotes",
  "exportFromV2",
  "bareDir",
  "ensureCheckouts",
  "entryPoints",
  "listFiles",
  "writeFile",
  "migrateFromV2",
  "parityReport",
  "rollbackIntoV2",
  "reinstallHooks",
] as const;

/** Index (MemoryStore) methods the gateway may call. */
export const INDEX_METHODS = [
  "get",
  "list",
  "search",
  "all",
  "stats",
  "markRetrieved",
  "expireDue",
  "findRelatedCandidates",
  "delete",
  "metadata",
  "setMetadata",
] as const;

export type ServiceMethod = (typeof SERVICE_METHODS)[number];
export type IndexMethod = (typeof INDEX_METHODS)[number];

/** Knowledge calls the gateway may make (knowledge/client.ts). Methods
 *  prefixed `index.` go to the KnowledgeIndex after the service brought the
 *  project's index up to date; the rest go to KnowledgeService. */
export const KNOWLEDGE_METHODS = [
  "ensureRepo",
  "hasRepo",
  "listProjects",
  "fresh",
  "head",
  "read",
  "readAt",
  "blobAt",
  "isAncestor",
  "write",
  "history",
  "diff",
  "revert",
  "readAttachment",
  "index.search",
  "index.list",
  "index.counts",
  "index.get",
  "index.internalBodies",
  "index.dependents",
] as const;

export type KnowledgeMethod = (typeof KNOWLEDGE_METHODS)[number];
