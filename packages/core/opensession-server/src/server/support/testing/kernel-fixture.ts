// Test fixture: an in-memory session kernel behind the catalog documents, a
// scratch state directory and a recording support audit sink. The shape of
// incidents/testing/kernel-fixture.ts. Later support tests add their own
// seams (channel adapters, the pipeline) next to this one.
// Not on any live import chain (excluded from the side-effect scan).
import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __clearProjectDocumentCacheForTest } from "../../projects/store";
import { __setSessionKernelStoreForTest } from "../../session-kernel/kernel";
import { SessionKernelStore } from "../../session-kernel/store";
import { type SupportAuditSink, __setSupportAuditForTest } from "../audit-sink";
import { __resetChannelAdaptersForTest } from "../channel";

export const TEST_PROJECTS = ["acme", "acme-api"];

export function useSupportTestKernel(): {
  root(): string;
  /** The kernel store behind the catalog, for writes that bypass it. */
  store(): SessionKernelStore;
  audits: Array<Record<string, unknown>>;
} {
  const audits: Array<Record<string, unknown>> = [];
  let root = "";
  let store: SessionKernelStore | undefined;
  let previousStore: SessionKernelStore | undefined;
  let previousRoot: string | undefined;
  let previousAudit: SupportAuditSink | undefined;

  beforeEach(async () => {
    audits.length = 0;
    root = await mkdtemp(join(tmpdir(), "support-"));
    previousRoot = process.env.OPENSESSION_STATE_DIR;
    process.env.OPENSESSION_STATE_DIR = root;
    store = new SessionKernelStore(":memory:");
    __clearProjectDocumentCacheForTest();
    previousStore = __setSessionKernelStoreForTest(store);
    previousAudit = __setSupportAuditForTest((event) => {
      audits.push(event);
    });
    __resetChannelAdaptersForTest();
  });

  afterEach(async () => {
    __resetChannelAdaptersForTest();
    __setSupportAuditForTest(previousAudit);
    __setSessionKernelStoreForTest(previousStore);
    store?.close();
    store = undefined;
    if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  return {
    root: () => root,
    store: () => {
      if (!store) throw new Error("The test kernel runs only inside a test");
      return store;
    },
    audits,
  };
}
