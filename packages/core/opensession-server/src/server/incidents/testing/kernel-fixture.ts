// Test fixture: an in-memory session kernel, a scratch state directory, a
// recording audit sink and a project check accepting `acme` and `acme-api`.
// Flushes queued observation writes before removing the scratch dir.
// Not on any live import chain (excluded from the side-effect scan).
import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setSessionKernelStoreForTest } from "../../session-kernel/kernel";
import { SessionKernelStore } from "../../session-kernel/store";
import { type AuditSink, __setIncidentAuditForTest } from "../audit-sink";
import { flushObservations } from "../observation-store";
import { __setProjectCheckForTest } from "../signal-store";

export const TEST_PROJECTS = ["acme", "acme-api"];

export function useIncidentTestKernel(): {
  root(): string;
  audits: Array<Record<string, unknown>>;
} {
  const audits: Array<Record<string, unknown>> = [];
  let root = "";
  let store: SessionKernelStore | undefined;
  let previousStore: SessionKernelStore | undefined;
  let previousRoot: string | undefined;
  let previousAudit: AuditSink | undefined;

  beforeEach(async () => {
    audits.length = 0;
    root = await mkdtemp(join(tmpdir(), "incidents-"));
    previousRoot = process.env.OPENSESSION_STATE_DIR;
    process.env.OPENSESSION_STATE_DIR = root;
    store = new SessionKernelStore(":memory:");
    previousStore = __setSessionKernelStoreForTest(store);
    previousAudit = __setIncidentAuditForTest((event) => {
      audits.push(event);
    });
    __setProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  });

  afterEach(async () => {
    // Queued observation writes would recreate the scratch dir after rm.
    await flushObservations();
    __setProjectCheckForTest(undefined);
    __setIncidentAuditForTest(previousAudit);
    __setSessionKernelStoreForTest(previousStore);
    store?.close();
    store = undefined;
    if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  return { root: () => root, audits };
}
