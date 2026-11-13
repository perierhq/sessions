/**
 * Blob's board in the central catalog (shared/blob-board.ts has the model
 * and the ops): one board document per owner in `blob-boards`, keyed by
 * supervisorInboxKey(owner), and its last BOARD_LIMITS.versions versions in
 * `blob-board-versions`, keyed `<owner key>~<revision>`.
 *
 * Writes are compare-and-set on the board's revision: board_apply names the
 * revision it read, and a board that moved on since is refused with the
 * current revision, never overwritten. The ops run inside the catalog's own
 * CAS loop, so two gateways can't interleave either. After the board
 * commits, its version document is written and the one that fell out of the
 * window is deleted; a version write that fails loses that history entry
 * only, never the board (the board document is the truth, and always holds
 * the current version).
 *
 * Reads are one document per owner (and one per version asked for): no
 * scans. The owner's open clients hear `supervisor_board_changed` with the
 * new revision and read GET /api/supervisor/board again.
 */
import {
  BOARD_LIMITS,
  BOARD_SCHEMA,
  applyBoardOps,
  emptyBoard,
  parseBoardElement,
  type ApplyReport,
  type Board,
  type BoardElement,
  type BoardViewport,
} from "../shared/blob-board";
import { catalogDocuments } from "./catalog-documents";
import { supervisorInboxKey } from "./supervisor-inbox";

export const BOARD_NAMESPACE = "blob-boards";
export const BOARD_VERSION_NAMESPACE = "blob-board-versions";
/** The socket frame a new board revision sends: { type, user, revision }. */
export const BOARD_CHANGED_EVENT = "supervisor_board_changed";

/** One stored version: the board right after an apply. */
export interface BoardVersion {
  schema: typeof BOARD_SCHEMA;
  revision: number;
  at: number;
  elements: BoardElement[];
  /** What that apply added, updated or moved. */
  touched: string[];
  /** What it removed, cascades included. */
  removed: string[];
}

export interface BoardDeps {
  now(): number;
  /** The projects whose lead answers to the owner (region frames). */
  ownedProjects(owner: string): Promise<string[]>;
  announce(owner: string, revision: number): Promise<void>;
}

const liveDeps: BoardDeps = {
  now: Date.now,
  ownedProjects: async (owner) => {
    const { listLeadRoster } = await import("./leads/roster");
    const key = supervisorInboxKey(owner);
    return (await listLeadRoster())
      .filter((e) => !!e.owner?.trim() && supervisorInboxKey(e.owner) === key)
      .map((e) => e.project);
  },
  announce: async (owner, revision) => {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(owner, {
      type: BOARD_CHANGED_EVENT,
      user: owner,
      revision,
    });
  },
};

let deps: BoardDeps = liveDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setBoardDepsForTest(
  overrides: Partial<BoardDeps>,
): () => void {
  const previous = deps;
  deps = { ...liveDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const boards = () => catalogDocuments(BOARD_NAMESPACE);
const versions = () => catalogDocuments(BOARD_VERSION_NAMESPACE);

function versionKey(owner: string, revision: number): string {
  return `${supervisorInboxKey(owner)}~${revision}`;
}

/** A stored board, cleaned: elements that no longer parse are dropped
 *  rather than failing the read. */
function cleanBoard(value: unknown): Board {
  if (!value || typeof value !== "object") return emptyBoard();
  const v = value as Record<string, unknown>;
  if (v.schema !== BOARD_SCHEMA) return emptyBoard();
  const revision =
    typeof v.revision === "number" &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0
      ? v.revision
      : 0;
  const elements = Array.isArray(v.elements)
    ? v.elements.flatMap((raw) => {
        const el = parseBoardElement(raw);
        return el.ok ? [el.el] : [];
      })
    : [];
  return {
    schema: BOARD_SCHEMA,
    revision,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    elements,
  };
}

function cleanVersion(value: unknown): BoardVersion | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const board = cleanBoard({ ...v, updatedAt: v.at });
  if (!board.revision) return null;
  const ids = (raw: unknown) =>
    Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string")
      : [];
  return {
    schema: BOARD_SCHEMA,
    revision: board.revision,
    at: board.updatedAt,
    elements: board.elements,
    touched: ids(v.touched),
    removed: ids(v.removed),
  };
}

/** The owner's board; revision 0 and no elements before the first apply. */
export async function readBoard(owner: string): Promise<Board> {
  return cleanBoard(await boards().get(supervisorInboxKey(owner)));
}

export type BoardApplyResult =
  | { ok: true; board: Board; report: ApplyReport }
  | { ok: false; error: string; conflict?: { revision: number } };

/**
 * Apply `ops` to the owner's board if it is still at `expectedRevision`.
 * The new board gets revision + 1. `viewport` is the camera the owner has
 * now (the turn's Blob surface), for the hinge guard and the off-camera
 * report.
 */
export async function applyBoard(
  owner: string,
  ops: unknown,
  expectedRevision: number,
  viewport?: BoardViewport,
): Promise<BoardApplyResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    return { ok: false, error: "expected_revision must be a whole number" };
  // A region frame names one of the owner's projects. Checked before the
  // CAS: the roster is another namespace.
  const regions = new Set<string>();
  if (Array.isArray(ops))
    for (const op of ops) {
      const o = op as {
        op?: unknown;
        el?: { region?: unknown };
        set?: { region?: unknown };
      };
      const region = o?.el?.region ?? o?.set?.region;
      if (typeof region === "string") regions.add(region);
    }
  if (regions.size) {
    const owned = new Set(await deps.ownedProjects(owner));
    for (const region of regions)
      if (!owned.has(region))
        return {
          ok: false,
          error: `region ${region} is not one of the owner's projects`,
        };
  }

  // Ops are applied to the board as read, then committed only if the
  // board is still at that revision: no write at all for refused ops.
  const read = await readBoard(owner);
  const conflict = (revision: number): BoardApplyResult => ({
    ok: false,
    error: `the board is at revision ${revision}, not ${expectedRevision}: read it again and redo your ops on it`,
    conflict: { revision },
  });
  if (read.revision !== expectedRevision) return conflict(read.revision);
  const applied = applyBoardOps(read.elements, ops, viewport);
  if (!applied.ok) return { ok: false, error: applied.error };
  const next: Board = {
    schema: BOARD_SCHEMA,
    revision: read.revision + 1,
    updatedAt: deps.now(),
    elements: applied.elements,
  };
  let outcome: BoardApplyResult | undefined;
  await boards().update(supervisorInboxKey(owner), (value) => {
    const current = cleanBoard(value);
    if (current.revision !== expectedRevision) {
      // Another writer got in between the read and the commit.
      outcome = conflict(current.revision);
      return value;
    }
    outcome = { ok: true, board: next, report: applied.report };
    return next;
  });
  if (!outcome) throw new Error("board apply produced no outcome");
  if (!outcome.ok) return outcome;

  const { board, report } = outcome;
  const version: BoardVersion = {
    schema: BOARD_SCHEMA,
    revision: board.revision,
    at: board.updatedAt,
    elements: board.elements,
    touched: report.touched,
    removed: [...report.removed, ...report.cascaded.map((c) => c.id)],
  };
  try {
    await versions().set(versionKey(owner, board.revision), version);
    const expired = board.revision - BOARD_LIMITS.versions;
    if (expired >= 1) await versions().delete(versionKey(owner, expired));
  } catch (error) {
    // A delete that fails leaves the expired version document behind. It is
    // never read (readBoardVersion refuses revisions outside the window) and
    // the key is per revision, so it costs storage only; a later sweep of
    // keys below the window could remove such orphans. Not done in v1.
    console.warn(
      "[board] version write failed:",
      error instanceof Error ? error.message : error,
    );
  }
  await deps.announce(owner, board.revision).catch(() => {});
  return outcome;
}

/** One kept version of the owner's board, or null when it fell out of the
 *  window or never existed. The current revision always reads. */
export async function readBoardVersion(
  owner: string,
  revision: number,
): Promise<BoardVersion | null> {
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const current = await readBoard(owner);
  if (revision > current.revision) return null;
  if (revision === current.revision)
    return {
      schema: BOARD_SCHEMA,
      revision,
      at: current.updatedAt,
      elements: current.elements,
      touched: [],
      removed: [],
    };
  if (revision <= current.revision - BOARD_LIMITS.versions) return null;
  return cleanVersion(await versions().get(versionKey(owner, revision)));
}

export const VERSIONS_PAGE_MAX = 20;
export const VERSIONS_PAGE_DEFAULT = 5;

/**
 * Kept versions before `before` (default: after the current one, so the
 * current is first), newest first, at most `limit`. `before` in the
 * answer pages on; null when nothing older is kept.
 */
export async function readBoardVersions(
  owner: string,
  options: { before?: number; limit?: number } = {},
): Promise<{
  revision: number;
  versions: BoardVersion[];
  before: number | null;
}> {
  const current = await readBoard(owner);
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? VERSIONS_PAGE_DEFAULT)),
    VERSIONS_PAGE_MAX,
  );
  const oldest = Math.max(1, current.revision - BOARD_LIMITS.versions + 1);
  const top = Math.min(
    current.revision,
    options.before !== undefined ? options.before - 1 : current.revision,
  );
  const wanted: number[] = [];
  for (let r = top; r >= oldest && wanted.length < limit; r--) wanted.push(r);
  const found = new Map<number, BoardVersion>();
  if (wanted.length) {
    const rows = await versions().getMany(
      wanted.map((r) => versionKey(owner, r)),
    );
    for (const row of rows) {
      const v = cleanVersion(row.value);
      if (v) found.set(v.revision, v);
    }
  }
  const list = wanted.flatMap((r): BoardVersion[] => {
    if (r === current.revision)
      return [
        {
          schema: BOARD_SCHEMA,
          revision: r,
          at: current.updatedAt,
          elements: current.elements,
          touched: found.get(r)?.touched ?? [],
          removed: found.get(r)?.removed ?? [],
        },
      ];
    const v = found.get(r);
    return v ? [v] : [];
  });
  const last = wanted.at(-1);
  return {
    revision: current.revision,
    versions: list,
    before: last !== undefined && last > oldest ? last : null,
  };
}
