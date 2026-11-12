/**
 * Blob's glossary: what goes in, in what order, what is left out, the cap,
 * the cache, and the route reading the live config.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./routes/context";

const root = mkdtempSync(join(tmpdir(), "blob-glossary-test-"));
const priorState = process.env.OPENSESSION_STATE_DIR;
const priorConfig = process.env.OPENSESSION_CONFIG;
const configFile = join(root, "config.json");
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_CONFIG = configFile;
writeFileSync(
  configFile,
  JSON.stringify({
    persona: { name: "Pat" },
    repos: {
      acme: {
        label: "Acme Rocket",
        repo: join(root, "acme"),
        ghRepo: "acme-co/rocket-app",
      },
    },
    identity: {
      team: [
        { name: "Ada Lovelace", email: "ada@example.test" },
        { name: "Grace Hopper", email: "grace@example.test" },
        { name: "Deploy Bot", email: "bot@example.test", directory: false },
      ],
    },
  }),
);

type Glossary = typeof import("./blob-glossary");
type Routes = typeof import("./routes/blob-glossary");
let glossary: Glossary;
let routes: Routes;

beforeAll(async () => {
  await (await import("./config")).getConfigAsync();
  glossary = await import("./blob-glossary");
  routes = await import("./routes/blob-glossary");
});

afterAll(() => {
  if (priorState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorState;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  rmSync(root, { recursive: true, force: true });
});

describe("buildBlobGlossary", () => {
  test("personas and work terms first, then projects, repos and first names", () => {
    expect(
      glossary.buildBlobGlossary({
        persona: "Pat",
        projects: [
          { id: "widget", label: "Widget Hub", ghRepo: "acme/widget-hub" },
        ],
        people: ["Ada Lovelace"],
      }),
    ).toEqual([
      "Pat",
      "Blob",
      "PR",
      "PRs",
      "merge",
      "incident",
      "lead",
      "Duo",
      "Widget Hub",
      "widget",
      "widget-hub",
      "Ada",
    ]);
  });

  test("drops case-insensitive repeats, keeping the first spelling", () => {
    const terms = glossary.buildBlobGlossary({
      persona: "Blob",
      projects: [{ id: "acme", label: "Acme", ghRepo: "acme-co/acme" }],
      people: ["pat", "PAT Smith"],
    });
    expect(terms.filter((t) => t.toLowerCase() === "blob")).toEqual(["Blob"]);
    expect(terms.filter((t) => t.toLowerCase() === "acme")).toEqual(["Acme"]);
    expect(terms.filter((t) => t.toLowerCase() === "pat")).toEqual(["pat"]);
  });

  test("leaves out empty, one-letter, too long, numeric and control terms", () => {
    const terms = glossary.buildBlobGlossary({
      persona: "",
      projects: [
        { id: "x", label: "  " },
        { id: "1234", label: "a".repeat(glossary.MAX_TERM_CHARS + 1) },
        { id: "ok", label: "bad\u0007name" },
      ],
      people: [""],
    });
    expect(terms).toEqual(["Blob", ...glossary.COMMON_TERMS, "ok"]);
  });

  test("is cut at the cap", () => {
    const terms = glossary.buildBlobGlossary({
      persona: "Pat",
      projects: Array.from({ length: 200 }, (_, i) => ({
        id: `project-${i}`,
        label: `project-${i}`,
      })),
      people: ["Ada"],
    });
    expect(terms).toHaveLength(glossary.MAX_GLOSSARY_TERMS);
    expect(terms).not.toContain("Ada");
  });

  test("collapses whitespace inside a term", () => {
    expect(glossary.glossaryTerm("  Widget \n Hub ")).toBe("Widget Hub");
  });
});

describe("blobGlossary cache", () => {
  test("rebuilds only after the cache time", () => {
    glossary.resetBlobGlossaryCache();
    let calls = 0;
    const sources = () => {
      calls++;
      return { persona: `P${calls}x`, projects: [], people: [] };
    };
    expect(glossary.blobGlossary(0, sources)[0]).toBe("P1x");
    expect(glossary.blobGlossary(1000, sources)[0]).toBe("P1x");
    expect(glossary.blobGlossary(glossary.GLOSSARY_CACHE_MS, sources)[0]).toBe(
      "P2x",
    );
    expect(calls).toBe(2);
    glossary.resetBlobGlossaryCache();
  });
});

function ctx(method = "GET", path = "/api/blob/glossary"): RouteContext {
  const url = new URL(`http://example.test${path}`);
  return {
    req: new Request(url, { method }),
    url,
    path,
    publicPrefix: "/backstage",
    authUser: { login: "ada", name: "ada" },
  };
}

describe("GET /api/blob/glossary", () => {
  test("serves the live config's terms, cacheable", async () => {
    glossary.resetBlobGlossaryCache();
    const res = await routes.handleBlobGlossaryRoutes(ctx());
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("private, max-age=300");
    const { terms } = (await res!.json()) as { terms: string[] };
    expect(terms.slice(0, 2)).toEqual(["Pat", "Blob"]);
    expect(terms).toContain("Acme Rocket");
    expect(terms).toContain("rocket-app");
    expect(terms).toContain("Ada");
    expect(terms).toContain("Grace");
    expect(terms).not.toContain("Deploy");
    expect(terms.length).toBeLessThanOrEqual(glossary.MAX_GLOSSARY_TERMS);
  });

  test("answers only GET on its own path", async () => {
    expect(await routes.handleBlobGlossaryRoutes(ctx("POST"))).toBeUndefined();
    expect(
      await routes.handleBlobGlossaryRoutes(ctx("GET", "/api/blob/other")),
    ).toBeUndefined();
  });
});
