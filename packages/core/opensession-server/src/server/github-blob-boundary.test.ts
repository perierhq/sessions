/** Architecture tripwire: Blob's GitHub token (a workspace secret, purpose
 * `github.blob`, referenced by `integrations.github.blob.tokenRef`) is
 * resolved by server/github-blob.ts alone. No other module may name its ref
 * or its purpose, so none can read the token and hand it to a shell, a
 * `GH_CONFIG_DIR` or an agent. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const sourceRoot = resolve(import.meta.dir, "..");
const OWNER = "server/github-blob.ts";

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(sourceRoot)) {
    if (/\.test\.tsx?$/.test(file) || file.includes("/testing/")) continue;
    files.push(file);
  }
  files.push(relative(sourceRoot, resolve(sourceRoot, "../opensession.ts")));
  return files;
}

/** Where `file` names the token's ref or purpose: the `tokenRef` property
 *  in any form, or the `github.blob` string. Comments don't count. */
function tokenAccesses(file: string): string[] {
  const text = readFileSync(resolve(sourceRoot, file), "utf8");
  if (!text.includes("tokenRef") && !text.includes("github.blob")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  visit(source, (node) => {
    const name =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
        ? node.text
        : ts.isStringLiteralLike(node)
          ? node.text
          : undefined;
    if (name === "tokenRef" || name === "github.blob") {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      hits.push(`${file}:${line + 1}`);
    }
  });
  return hits;
}

describe("Blob's GitHub token boundary", () => {
  test("only server/github-blob.ts names the token's ref or purpose", () => {
    const offenders = sourceFiles()
      .filter((file) => file !== OWNER)
      .flatMap(tokenAccesses);
    expect(offenders).toEqual([]);
    // The tripwire is live: it finds the owner's own accesses.
    expect(tokenAccesses(OWNER).length).toBeGreaterThan(0);
  });

  test("the settings route reaches the token only through github-blob.ts", () => {
    const file = "server/routes/blob-github.ts";
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(sourceRoot, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    visit(source, (node) => {
      if (ts.isImportDeclaration(node))
        imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    });
    expect(imports.sort()).toEqual([
      "../github-blob",
      "../support/actor",
      "./context",
      "./context",
    ]);
  });

  test("github-blob.ts never spawns a process or touches the environment", () => {
    const text = readFileSync(resolve(sourceRoot, OWNER), "utf8");
    expect(text).not.toMatch(/Bun\.spawn|child_process|process\.env/);
  });
});
