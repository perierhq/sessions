/** Opaque workspace-owned secrets.
 *
 * This is deliberately separate from keychain.ts: keychain credentials are
 * person-owned, lendable to agents, and broker-addressable. Workspace secrets
 * are instance configuration. They can only be resolved by server code and
 * are never listed or projected into a run/sandbox.
 *
 * Every write is async and runs on one promise chain in this process, so no
 * read-modify-write can land between another one's read and its rename.
 * There are deliberately no synchronous writers: one would bypass the chain
 * and a concurrent async write would put back the snapshot it read before.
 *
 * A missing store reads as empty. Any other read failure (unreadable file,
 * bad JSON) throws, so a write never replaces a store it couldn't read.
 */

import { chmod, readFile } from "fs/promises";
import { stateDir } from "./paths";
import { writeFileAtomicAsync } from "./shared/atomic-write";
import { readJsonFileShared } from "./shared/json-file-cache";

interface WorkspaceSecretRecord {
  id: string;
  purpose: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceSecretStore {
  version: 1;
  secrets: WorkspaceSecretRecord[];
}

function storePath(): string {
  return (
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE ||
    stateDir("workspace-secrets.json")
  );
}

const emptyStore = (): WorkspaceSecretStore => ({ version: 1, secrets: [] });

function normalizeStore(
  raw: { secrets?: unknown } | undefined,
): WorkspaceSecretStore {
  if (!raw || !Array.isArray(raw.secrets)) return emptyStore();
  return {
    version: 1,
    secrets: raw.secrets.filter(
      (entry: unknown): entry is WorkspaceSecretRecord => {
        const value = entry as WorkspaceSecretRecord;
        return Boolean(
          value?.id && value?.purpose && typeof value?.value === "string",
        );
      },
    ),
  };
}

/** The sync readers' view; shared, so never mutated. Throws on anything but
 *  a missing file (json-file-cache reads ENOENT and ENOTDIR as missing). */
function readStore(): WorkspaceSecretStore {
  return normalizeStore(readJsonFileShared<{ secrets?: unknown }>(storePath()));
}

/** Sets `id` in `store` (mutates). */
function upsertSecret(
  store: WorkspaceSecretStore,
  purpose: string,
  value: string,
  ref: string | undefined,
): string {
  if (!purpose.trim()) throw new Error("workspace secret purpose is required");
  if (!value) throw new Error("workspace secret is empty");
  const now = new Date().toISOString();
  const id = ref || `wssec-${crypto.randomUUID()}`;
  const existing = store.secrets.find((secret) => secret.id === id);
  if (existing) {
    existing.value = value;
    existing.purpose = purpose.trim();
    existing.updatedAt = now;
  } else {
    store.secrets.push({
      id,
      purpose: purpose.trim(),
      value,
      createdAt: now,
      updatedAt: now,
    });
  }
  return id;
}

// ── Writers ─────────────────────────────────────────────────────────────
// Every read-modify-write runs on one promise chain, so two writes started
// together (an inbox and a sandbox key saved at once) never lose a secret.

let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(write: () => Promise<T>): Promise<T> {
  const next = writeChain.then(write, write);
  writeChain = next.catch(() => {});
  return next;
}

async function readStoreAsync(): Promise<WorkspaceSecretStore> {
  let text: string;
  try {
    text = await readFile(storePath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  // A store that exists but does not parse is not overwritten with an
  // empty one: the write fails instead.
  return normalizeStore(JSON.parse(text));
}

async function persistAsync(store: WorkspaceSecretStore): Promise<void> {
  const path = storePath();
  await writeFileAtomicAsync(path, JSON.stringify(store, null, 2), 0o600);
  await chmod(path, 0o600);
}

export function putWorkspaceSecretAsync(
  purpose: string,
  value: string,
  ref?: string,
): Promise<string> {
  return serialized(async () => {
    const store = await readStoreAsync();
    const id = upsertSecret(store, purpose, value, ref);
    await persistAsync(store);
    return id;
  });
}

export function deleteWorkspaceSecretAsync(ref: string): Promise<boolean> {
  return serialized(async () => {
    const store = await readStoreAsync();
    const next = store.secrets.filter((secret) => secret.id !== ref);
    if (next.length === store.secrets.length) return false;
    store.secrets = next;
    await persistAsync(store);
    return true;
  });
}

/** resolveWorkspaceSecret for request handlers: never blocks the loop. */
export async function resolveWorkspaceSecretAsync(
  ref: string,
): Promise<string | undefined> {
  const store = await readStoreAsync();
  return store.secrets.find((secret) => secret.id === ref)?.value;
}

export function resolveWorkspaceSecret(ref: string): string | undefined {
  return readStore().secrets.find((secret) => secret.id === ref)?.value;
}

export function workspaceSecretExists(ref: string): boolean {
  return readStore().secrets.some((secret) => secret.id === ref);
}
