/**
 * Knowledge's error types, apart from the service so the memory client can
 * rebuild them from the worker without loading knowledge code.
 */

import { MemoryRepoError } from "../memory-repo/git-store";

/** Someone else changed a file between the caller's read and this write. */
export class KnowledgeConflictError extends MemoryRepoError {
  constructor(message = "Someone changed this article. Reload and try again.") {
    super(message, 409);
    this.name = "KnowledgeConflictError";
  }
}
