/** Architecture tripwire: Blob's GitHub token (a workspace secret, purpose
 * `github.blob`, referenced by `integrations.github.blob.tokenRef`) is
 * resolved by server/github-blob.ts alone. No other module may name its ref
 * or its purpose, or resolve a workspace secret from a ref it read out of
 * `integrations.github.blob`, so none can read the token and hand it to a
 * shell, a `GH_CONFIG_DIR` or an agent. */
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
function tokenAccesses(
  file: string,
  text = readFileSync(resolve(sourceRoot, file), "utf8"),
): string[] {
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

/** Where `file` resolves a workspace secret while also reading a `blob`
 *  property (`github.blob`, `["blob"]`, `{ blob }`): the shape of reading
 *  `integrations.github.blob`'s ref, however it is spelled, and resolving
 *  it. Comments don't count. */
function blobSecretResolves(
  file: string,
  text = readFileSync(resolve(sourceRoot, file), "utf8"),
): string[] {
  if (!text.includes("resolveWorkspaceSecret") || !text.includes("blob"))
    return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const resolves: string[] = [];
  const blobReads: string[] = [];
  visit(source, (node) => {
    if (ts.isIdentifier(node) && node.text.startsWith("resolveWorkspaceSecret"))
      resolves.push(at(node));
    const readsBlob =
      (ts.isPropertyAccessExpression(node) && node.name.text === "blob") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "blob") ||
      (ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(source) === "blob");
    if (readsBlob) blobReads.push(at(node));
  });
  return resolves.length && blobReads.length ? [...resolves, ...blobReads] : [];
}

describe("Blob's GitHub token boundary", () => {
  test("only server/github-blob.ts names the token's ref or purpose", () => {
    const offenders = sourceFiles()
      .filter((file) => file !== OWNER)
      .flatMap((file) => tokenAccesses(file));
    expect(offenders).toEqual([]);
    // The tripwire is live: it finds the owner's own accesses.
    expect(tokenAccesses(OWNER).length).toBeGreaterThan(0);
  });

  test("only server/github-blob.ts resolves a secret read from integrations.github.blob", () => {
    const offenders = sourceFiles()
      .filter((file) => file !== OWNER)
      .flatMap((file) => blobSecretResolves(file));
    expect(offenders).toEqual([]);
    expect(blobSecretResolves(OWNER).length).toBeGreaterThan(0);
  });

  test("the tripwire catches a ref read under another spelling", () => {
    for (const text of [
      `const ref = configuredIntegration("github").blob["token" + "Ref"];\nresolveWorkspaceSecret(ref);`,
      `const { blob } = configuredIntegration("github");\nawait resolveWorkspaceSecretAsync(blob[key]);`,
      `const gh = cfg.integrations.github;\nresolveWorkspaceSecret(gh["blob"].ref);`,
    ])
      expect(blobSecretResolves("server/elsewhere.ts", text)).not.toEqual([]);
    expect(
      tokenAccesses(
        "server/elsewhere.ts",
        `resolveWorkspaceSecret(integrations.github.blob.tokenRef);`,
      ),
    ).not.toEqual([]);
    // Resolving another secret, or reading a web Blob, is fine.
    expect(
      blobSecretResolves(
        "server/elsewhere.ts",
        `resolveWorkspaceSecret(cfg.slack.tokenRef);`,
      ),
    ).toEqual([]);
    expect(
      blobSecretResolves("server/elsewhere.ts", `const b = res.blob;`),
    ).toEqual([]);
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
