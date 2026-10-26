/**
 * Gateway-side facade for the memory repository service.
 *
 * Every git subprocess and every index read runs on memory-repo-worker.ts.
 * Nothing starts at import: the worker starts on the first call and is keyed
 * by the memory directory, so a repointed state root gets its own worker.
 * Tests can swap in an in-process service.
 *
 * Knowledge (knowledge/client.ts) runs on the same worker as a third call
 * target, "knowledge", so it shares the thread, the directory key and the
 * test seam shape.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary, workerEntry } from "../../runner-host/exe";
import { memoryDir } from "../../agents/slack/memory";
import { configuredServer } from "../config";
import { SLACK_ID_TO_NAME } from "../shared/user-mappings";
import type { MemoryStore } from "../memory-v2/store";
import { dispatchKnowledge } from "../knowledge/dispatch";
import {
  KnowledgeConflictError,
  type KnowledgeService,
} from "../knowledge/service";
import type {
  IndexMethod,
  KnowledgeMethod,
  MemoryRepoWorkerRequest,
  MemoryRepoWorkerResponse,
  MemoryRepoWorkerTarget,
  ServiceMethod,
} from "./protocol";
import {
  MemoryRepoError,
  type MemoryRepoService,
  type MemoryRepoServiceOptions,
} from "./service";

const REQUEST_TIMEOUT_MS = 180_000;

type AnyFn = (...args: never[]) => unknown;
type Args<T, M extends keyof T> = T[M] extends AnyFn ? Parameters<T[M]> : never;
type Result<T, M extends keyof T> = T[M] extends AnyFn
  ? Awaited<ReturnType<T[M]>>
  : never;

export function memoryHookCommand(): string[] {
  if (isCompiledBinary())
    return [
      "env",
      "BUN_BE_BUN=1",
      process.execPath,
      join(dirname(process.execPath), "memory-repo-hook.js"),
    ];
  return [
    process.execPath,
    fileURLToPath(new URL("./hook-main.ts", import.meta.url)),
  ];
}

function uiBase(): string {
  if (process.env.OPENSESSION_UI_BASE) return process.env.OPENSESSION_UI_BASE;
  try {
    return configuredServer().publicBaseUrl || "";
  } catch {
    return "";
  }
}

export function memoryRepoOptions(): MemoryRepoServiceOptions {
  const labels: Record<string, string> = {};
  for (const [id, name] of Object.entries(SLACK_ID_TO_NAME))
    labels[`user-${id}`] = name;
  return {
    base: memoryDir(),
    hookCommand: memoryHookCommand(),
    uiBase: uiBase(),
    labels,
  };
}

interface Backend {
  call(
    target: MemoryRepoWorkerTarget,
    method: string,
    args: unknown[],
  ): Promise<unknown>;
  base: string;
  close(): void;
}

class LocalBackend implements Backend {
  constructor(
    readonly service: MemoryRepoService | null,
    readonly knowledge: KnowledgeService | null = null,
  ) {}
  get base() {
    return this.service?.opts.base ?? this.knowledge?.opts.base ?? "";
  }
  async call(target: MemoryRepoWorkerTarget, method: string, args: unknown[]) {
    if (target === "knowledge") {
      if (!this.knowledge)
        throw new MemoryRepoError("Knowledge isn't set up in this test.", 503);
      return dispatchKnowledge(this.knowledge, method, args);
    }
    if (!this.service)
      throw new MemoryRepoError("Memory isn't set up in this test.", 503);
    const owner = (target === "service"
      ? this.service
      : this.service.index) as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    return owner[method].apply(
      target === "service" ? this.service : this.service.index,
      args,
    );
  }
  close() {}
}

type WorkerHandle = Worker & { ref(): void; unref(): void };

class WorkerBackend implements Backend {
  private worker: WorkerHandle | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  constructor(readonly options: MemoryRepoServiceOptions) {}
  get base() {
    return this.options.base;
  }

  private ensure(): WorkerHandle {
    if (this.worker) return this.worker;
    const url = workerEntry(
      "memory-repo-worker.js",
      new URL("../memory-repo-worker.ts", import.meta.url).href,
    );
    const worker = new Worker(url, { type: "module" }) as WorkerHandle;
    worker.addEventListener("message", (event: MessageEvent) => {
      if (this.worker !== worker) return;
      this.settle(event.data as MemoryRepoWorkerResponse);
    });
    worker.addEventListener("error", (event) => {
      if (this.worker !== worker) return;
      this.fail(
        new MemoryRepoError(`Memory worker failed: ${event.message}`, 503),
      );
    });
    worker.unref();
    worker.postMessage({
      t: "open",
      options: this.options,
    } satisfies MemoryRepoWorkerRequest);
    this.worker = worker;
    return worker;
  }

  call(
    target: MemoryRepoWorkerTarget,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new MemoryRepoError("Memory request timed out.", 503)),
        REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      worker.postMessage({
        t: "call",
        id,
        target,
        method,
        args,
      } satisfies MemoryRepoWorkerRequest);
    });
  }

  private settle(response: MemoryRepoWorkerResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.t === "ok") pending.resolve(response.value);
    else
      pending.reject(
        rebuildError(response.name, response.message, response.status),
      );
    if (!this.pending.size) this.worker?.unref();
  }

  private fail(error: Error) {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.fail(new MemoryRepoError("Memory worker stopped.", 503));
  }
}

function rebuildError(name: string, message: string, status?: number): Error {
  if (name === "KnowledgeConflictError")
    return new KnowledgeConflictError(message);
  if (name === "MemoryNotFoundError") return new MemoryRepoError(message, 404);
  if (name === "DuplicateMemoryError") return new MemoryRepoError(message, 409);
  if (name === "MemoryRepoError" || name === "SecretInMemoryError")
    return new MemoryRepoError(message, status ?? 400);
  const error = new Error(message);
  error.name = name;
  return error;
}

const g = globalThis as typeof globalThis & {
  __osMemoryRepo?: {
    override?: Backend;
    knowledge?: Backend;
    worker?: WorkerBackend;
  };
};

function backend(target: MemoryRepoWorkerTarget): Backend {
  const state = (g.__osMemoryRepo ??= {});
  const override = target === "knowledge" ? state.knowledge : state.override;
  if (override) return override;
  const options = memoryRepoOptions();
  if (state.worker && state.worker.base !== options.base) {
    state.worker.close();
    state.worker = undefined;
  }
  return (state.worker ??= new WorkerBackend(options));
}

/** Test seam: run the service in-process (or restore the worker with null). */
export function __setMemoryRepoServiceForTest(
  service: MemoryRepoService | null,
): void {
  const state = (g.__osMemoryRepo ??= {});
  state.override = service ? new LocalBackend(service) : undefined;
}

/** Test seam: run the knowledge service in-process (or restore the worker
 *  with null). Calls still go through dispatchKnowledge, so the method list
 *  and the fresh-before-index-read rule apply as on the worker. */
export function __setKnowledgeServiceForTest(
  service: KnowledgeService | null,
): void {
  const state = (g.__osMemoryRepo ??= {});
  state.knowledge = service ? new LocalBackend(null, service) : undefined;
}

/** One knowledge call on the memory worker (knowledge/client.ts types it). */
export function callKnowledge(
  method: KnowledgeMethod,
  args: unknown[],
): Promise<unknown> {
  return backend("knowledge").call("knowledge", method, args);
}

export const memoryRepo = {
  service<M extends ServiceMethod>(
    method: M,
    ...args: Args<MemoryRepoService, M>
  ): Promise<Result<MemoryRepoService, M>> {
    return backend("service").call("service", method, args) as Promise<
      Result<MemoryRepoService, M>
    >;
  },
  index<M extends IndexMethod>(
    method: M,
    ...args: Args<MemoryStore, M>
  ): Promise<Result<MemoryStore, M>> {
    return backend("index").call("index", method, args) as Promise<
      Result<MemoryStore, M>
    >;
  },
};
