#!/usr/bin/env bun
/**
 * Runs `return 1+1` through pi's codemode tool and exits 0 only if the script
 * completed with 2. Codemode runs scripts in QuickJS (quickjs-wasi's
 * quickjs.wasm) in a worker thread, so this goes red whenever the sandbox
 * cannot load.
 *
 * It exists to be compiled: `bun build --compile` reproduces the release
 * binary, where the WASM and the worker have to sit beside the executable (see
 * scripts/lib/pi-runtime-files.ts). The release workflow runs it beside the
 * staged Linux artefact's copies, and codemode-probe.test.ts runs it with and
 * without them. A compiled build only looks beside the executable, so unlike
 * image-read-probe.ts it needs no guard against the build machine's paths.
 */

import {
  createCodemodeExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// The same options the server registers codemode with (piCodemodeExtension).
let tool: ToolDefinition<any, any, any> | undefined;
// SAFETY: the extension calls only these four ExtensionAPI members.
createCodemodeExtension({ mode: "on", models: false })({
  registerTool: (definition: ToolDefinition<any, any, any>) => {
    tool = definition;
  },
  getSettings: () => ({}),
  getAllTools: () => [],
  appendEntry: () => {},
} as never);
if (!tool) throw new Error("codemode-probe: pi registered no codemode tool");

try {
  // SAFETY: codemode's executor treats a missing context as "no callable
  // tools", which is all `return 1+1` needs.
  const result = await tool.execute(
    "codemode-probe",
    { code: "return 1+1" },
    undefined,
    undefined,
    undefined as never,
  );
  // SAFETY: a tool result's content is pi's text and image blocks.
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
  if (/^Script completed\b/.test(text) && /\nOutput:\s*2\s*$/.test(text)) {
    console.log("codemode-probe: ok (2)");
  } else {
    console.error(`codemode-probe: the script did not return 2\n${text}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `codemode-probe: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
