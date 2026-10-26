/**
 * The knowledge index: one SQLite file with every project's items, their
 * bodies for full-text search (FTS5) and their `dependsOn` entries for the
 * freshness check. Rebuilt from the repository by KnowledgeService.fresh;
 * the repository stays the truth.
 *
 * Synchronous bun:sqlite, owned by the memory-repo worker (never the
 * gateway thread). Construction opens the file; nothing else happens at
 * import.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  KNOWLEDGE_FILTERS,
  parseDependency,
  type DependencyRef,
  type KnowledgeFilter,
  type KnowledgeFrontMatter,
  type KnowledgeItem,
  type KnowledgeSearchHit,
  type KnowledgeStatus,
} from "../../shared/knowledge";
import { ftsQuery } from "../memory-v2/store";

const EXCERPT_CHARS = 240;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface ItemRow {
  project: string;
  path: string;
  fm_json: string;
  blob: string;
  commit_sha: string;
  updated_at: string;
  excerpt: string;
  effective: KnowledgeStatus;
}

/** Today's UTC day, for a call that wasn't given one. */
export function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

/** The list and search excerpt: the body's first characters on one line. */
export function excerptOf(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_CHARS
    ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
    : text;
}

/** effectiveStatus (shared/knowledge.ts) as SQL, on `?` (a YYYY-MM-DD
 *  bind): an active item past its review date, or with a review date that
 *  isn't a day, needs a check. */
const EFFECTIVE = `CASE WHEN i.status = 'active' AND i.review_by IS NOT NULL
  AND (i.review_by NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR i.review_by < ?)
  THEN 'needs-check' ELSE i.status END`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `today` as given (YYYY-MM-DD, throws otherwise), or today's UTC day when
 *  the caller left it out. Every call that computes `effective` takes it. */
function checkDay(day: string | undefined): string {
  if (day === undefined) return utcDay();
  if (typeof day !== "string" || !DAY.test(day))
    throw new Error(`Invalid date "${day}".`);
  return day;
}

/** Search tier: backing first, then needs a check, then reference. */
const TIER = `CASE
  WHEN (${EFFECTIVE}) = 'needs-check' THEN 1
  WHEN i.trust = 'trusted' THEN 0
  ELSE 2 END`;

const SUGGESTION = `i.path LIKE 'suggestions/%'`;

/** WHERE clause per list filter; `?` binds are the day (EFFECTIVE). */
function filterSql(filter: KnowledgeFilter): { sql: string; days: number } {
  switch (filter) {
    case "all":
      return { sql: `i.status <> 'retired'`, days: 0 };
    case "answer":
      return {
        sql: `i.kind = 'answer' AND i.trust = 'trusted' AND (${EFFECTIVE}) = 'active' AND NOT ${SUGGESTION}`,
        days: 1,
      };
    case "internal":
      return {
        sql: `i.kind = 'internal' AND (${EFFECTIVE}) = 'active' AND NOT ${SUGGESTION}`,
        days: 1,
      };
    case "needs-check":
      return {
        sql: `(${EFFECTIVE}) = 'needs-check' AND NOT ${SUGGESTION}`,
        days: 1,
      };
    case "reference":
      return {
        sql: `i.kind = 'answer' AND i.trust = 'reference' AND (${EFFECTIVE}) = 'active' AND NOT ${SUGGESTION}`,
        days: 1,
      };
    case "suggestions":
      return { sql: `${SUGGESTION} AND i.status <> 'retired'`, days: 0 };
    case "retired":
      return { sql: `i.status = 'retired'`, days: 0 };
  }
}

function fromRow(row: ItemRow): KnowledgeItem {
  const fm = JSON.parse(row.fm_json) as KnowledgeFrontMatter;
  return {
    ...fm,
    project: row.project,
    path: row.path,
    blob: row.blob,
    commit: row.commit_sha,
    updatedAt: row.updated_at,
    effective: row.effective,
    excerpt: row.excerpt,
  };
}

/** Rows for one `dependsOn` entry: `repo` stores the path and whether it is
 *  a folder prefix; the others store their formatted value. */
function depKey(dep: DependencyRef): { type: string; value: string } {
  switch (dep.type) {
    case "repo":
      return { type: "repo", value: dep.path };
    case "url":
      return { type: "url", value: dep.url };
    case "issue":
    case "pr":
      return { type: dep.type, value: String(dep.number) };
    case "release":
      return { type: "release", value: dep.tag };
  }
}

export class KnowledgeIndex {
  private readonly db: Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_items (
        project TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        trust TEXT NOT NULL,
        status TEXT NOT NULL,
        review_by TEXT,
        valid_as_of TEXT NOT NULL,
        fm_json TEXT NOT NULL,
        blob TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY(project, path)
      );
      CREATE TABLE IF NOT EXISTS knowledge_deps (
        project TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        prefix INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_deps
        ON knowledge_deps(project, type, value);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        project UNINDEXED, path UNINDEXED, title, topics, body,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS knowledge_heads (
        project TEXT PRIMARY KEY,
        commit_sha TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Replace everything indexed for a project with the items at `commit`,
   *  if the project is still indexed at `expectedHead` (null: never
   *  indexed). Returns false and changes nothing when another reindex got
   *  there first, so an older head never overwrites a newer one. */
  replaceProject(
    project: string,
    commit: string,
    items: KnowledgeItem[],
    bodies: Map<string, string>,
    expectedHead: string | null,
  ): boolean {
    const insertItem = this.db.prepare(
      `INSERT INTO knowledge_items
        (project, path, title, kind, trust, status, review_by, valid_as_of,
         fm_json, blob, commit_sha, updated_at, excerpt, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO knowledge_fts (project, path, title, topics, body)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertDep = this.db.prepare(
      `INSERT INTO knowledge_deps (project, path, type, value, prefix)
       VALUES (?, ?, ?, ?, ?)`,
    );
    return this.db.transaction(() => {
      if (this.head(project) !== expectedHead) return false;
      for (const table of [
        "knowledge_items",
        "knowledge_fts",
        "knowledge_deps",
      ])
        this.db.query(`DELETE FROM ${table} WHERE project = ?`).run(project);
      for (const item of items) {
        const body = bodies.get(item.path) ?? "";
        const fm = frontMatterOf(item);
        insertItem.run(
          project,
          item.path,
          fm.title,
          fm.kind,
          fm.trust,
          fm.status,
          fm.reviewBy ?? null,
          fm.validAsOf,
          JSON.stringify(fm),
          item.blob,
          item.commit,
          item.updatedAt,
          item.excerpt || excerptOf(body),
          body,
        );
        insertFts.run(project, item.path, fm.title, fm.topics.join(" "), body);
        for (const raw of fm.dependsOn) {
          const dep = parseDependency(raw);
          if (!dep) continue;
          const key = depKey(dep);
          insertDep.run(
            project,
            item.path,
            key.type,
            key.value,
            dep.type === "repo" && dep.prefix ? 1 : 0,
          );
        }
      }
      this.db
        .query(
          `INSERT INTO knowledge_heads (project, commit_sha) VALUES (?, ?)
           ON CONFLICT(project) DO UPDATE SET commit_sha = excluded.commit_sha`,
        )
        .run(project, commit);
      return true;
    })();
  }

  /** Each indexed path's blob and the time it was first indexed with that
   *  blob, so a reindex keeps `updatedAt` for files that didn't change. */
  stamps(project: string): Map<string, { blob: string; updatedAt: string }> {
    const rows = this.db
      .query(
        `SELECT path, blob, updated_at FROM knowledge_items WHERE project = ?`,
      )
      .all(project) as Array<{
      path: string;
      blob: string;
      updated_at: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.path,
        { blob: row.blob, updatedAt: row.updated_at },
      ]),
    );
  }

  /** The repository commit the project was last indexed at. */
  head(project: string): string | null {
    const row = this.db
      .query(`SELECT commit_sha FROM knowledge_heads WHERE project = ?`)
      .get(project) as { commit_sha: string } | null;
    return row?.commit_sha ?? null;
  }

  private select(where: string): string {
    return `SELECT i.project, i.path, i.fm_json, i.blob, i.commit_sha,
      i.updated_at, i.excerpt, (${EFFECTIVE}) AS effective
      FROM knowledge_items i WHERE i.project = ? AND ${where}`;
  }

  get(project: string, path: string, today?: string): KnowledgeItem | null {
    const row = this.db
      .query(this.select("i.path = ?"))
      .get(checkDay(today), project, path) as ItemRow | null;
    return row ? fromRow(row) : null;
  }

  body(project: string, path: string): string | null {
    const row = this.db
      .query(`SELECT body FROM knowledge_items WHERE project = ? AND path = ?`)
      .get(project, path) as { body: string } | null;
    return row?.body ?? null;
  }

  /** One page of a list filter, optionally narrowed by a text query. */
  list(
    project: string,
    filter: KnowledgeFilter,
    opts: {
      query?: string;
      limit?: number;
      offset?: number;
      today?: string;
    } = {},
  ): { items: KnowledgeItem[]; total: number } {
    const day = checkDay(opts.today);
    const { sql, days } = filterSql(filter);
    const dayBinds = Array<string>(days).fill(day);
    const terms = opts.query ? ftsQuery(opts.query) : "";
    const match = terms
      ? ` AND i.path IN (SELECT path FROM knowledge_fts WHERE knowledge_fts MATCH ? AND project = ?)`
      : "";
    const matchBinds = terms ? [terms, project] : [];
    const limit = clampLimit(opts.limit);
    const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
    const rows = this.db
      .query(
        `${this.select(`(${sql})${match}`)}
         ORDER BY i.valid_as_of DESC, i.title, i.path LIMIT ? OFFSET ?`,
      )
      .all(
        day,
        project,
        ...dayBinds,
        ...matchBinds,
        limit,
        offset,
      ) as ItemRow[];
    const total = this.db
      .query(
        `SELECT COUNT(*) AS n FROM knowledge_items i
         WHERE i.project = ? AND (${sql})${match}`,
      )
      .get(project, ...dayBinds, ...matchBinds) as { n: number };
    return { items: rows.map(fromRow), total: total.n };
  }

  /**
   * Full-text search for the agent and the page. Every term must match;
   * when nothing does, any term may (an agent asks in sentences).
   * Order: tier (backing, needs a check, reference), then newer `validAsOf`,
   * then bm25 (title 8, topics 4, body 1). In the any-term fallback bm25
   * comes before `validAsOf`, since matches differ in how much they match.
   * Retired items never come back.
   */
  search(
    project: string,
    query: string,
    opts: { limit?: number; includeReference?: boolean; today: string },
  ): KnowledgeSearchHit[] {
    if (opts.today === undefined) throw new Error("Search needs today's date.");
    checkDay(opts.today);
    const all = this.searchTerms(project, ftsQuery(query), false, opts);
    if (all.length) return all;
    return this.searchTerms(project, ftsQuery(query, true), true, opts);
  }

  private searchTerms(
    project: string,
    terms: string,
    anyTerm: boolean,
    opts: { limit?: number; includeReference?: boolean; today: string },
  ): KnowledgeSearchHit[] {
    if (!terms) return [];
    const reference =
      opts.includeReference === false ? ` AND i.trust <> 'reference'` : "";
    const order = anyTerm
      ? "tier, rank, i.valid_as_of DESC, i.path"
      : "tier, i.valid_as_of DESC, rank, i.path";
    const rows = this.db
      .query(
        `SELECT i.project, i.path, i.fm_json, i.blob, i.commit_sha,
           i.updated_at, i.excerpt, (${EFFECTIVE}) AS effective,
           (${TIER}) AS tier,
           bm25(knowledge_fts, 0, 0, 8.0, 4.0, 1.0) AS rank
         FROM knowledge_fts f
         JOIN knowledge_items i ON i.project = f.project AND i.path = f.path
         WHERE knowledge_fts MATCH ? AND f.project = ?
           AND i.status <> 'retired'${reference}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(
        opts.today,
        opts.today,
        terms,
        project,
        clampLimit(opts.limit ?? 10),
      ) as Array<ItemRow & { rank: number }>;
    return rows.map((row) => ({ item: fromRow(row), rank: row.rank }));
  }

  counts(project: string, today: string): Record<KnowledgeFilter, number> {
    if (today === undefined) throw new Error("Counts need today's date.");
    const day = checkDay(today);
    const parts = KNOWLEDGE_FILTERS.map((filter) => {
      const { sql, days } = filterSql(filter);
      return { filter, sql, days };
    });
    const row = this.db
      .query(
        `SELECT ${parts
          .map(
            (p, n) =>
              `COALESCE(SUM(CASE WHEN ${p.sql} THEN 1 ELSE 0 END), 0) AS c${n}`,
          )
          .join(", ")}
         FROM knowledge_items i WHERE i.project = ?`,
      )
      .get(
        ...parts.flatMap((p) => Array<string>(p.days).fill(day)),
        project,
      ) as Record<string, number>;
    return Object.fromEntries(
      parts.map((p, n) => [p.filter, row[`c${n}`] ?? 0]),
    ) as Record<KnowledgeFilter, number>;
  }

  /** Every internal article's text, for the quote check. Retired notes
   *  count too: they were never meant for customers either. */
  internalBodies(
    project: string,
  ): Array<{ path: string; title: string; body: string }> {
    return this.db
      .query(
        `SELECT path, title, body FROM knowledge_items
         WHERE project = ? AND kind = 'internal' ORDER BY path`,
      )
      .all(project) as Array<{ path: string; title: string; body: string }>;
  }

  /** Items whose `dependsOn` covers `dep`. A repo folder entry (`docs/`)
   *  covers every path under it; a folder `dep` matches every entry under
   *  it. */
  dependents(
    project: string,
    dep: DependencyRef,
    today?: string,
  ): KnowledgeItem[] {
    const day = checkDay(today);
    const key = depKey(dep);
    let where: string;
    let binds: Array<string | number>;
    if (dep.type === "repo") {
      where = `d.type = 'repo' AND (d.value = ?
        OR (d.prefix = 1 AND substr(?, 1, length(d.value)) = d.value)
        OR (? = 1 AND substr(d.value, 1, length(?)) = ?))`;
      binds = [key.value, key.value, dep.prefix ? 1 : 0, key.value, key.value];
    } else {
      where = `d.type = ? AND d.value = ?`;
      binds = [key.type, key.value];
    }
    const rows = this.db
      .query(
        this.select(
          `i.path IN (SELECT d.path FROM knowledge_deps d WHERE d.project = ? AND ${where}) ORDER BY i.path`,
        ),
      )
      .all(day, project, project, ...binds) as ItemRow[];
    return rows.map(fromRow);
  }
}

/** The front matter part of an item (what the repository file says). */
function frontMatterOf(item: KnowledgeItem): KnowledgeFrontMatter {
  const {
    project: _project,
    path: _path,
    blob: _blob,
    commit: _commit,
    updatedAt: _updatedAt,
    effective: _effective,
    excerpt: _excerpt,
    ...fm
  } = item;
  return fm;
}
