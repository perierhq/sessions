#!/usr/bin/env node
// Read one build setting for one target out of ../project.yml.
//
//   node project-settings.mjs <target> <setting> [config]
//
// project.yml is the single source of truth for bundle ids and provisioning
// profile names; the release workflows read them here instead of repeating
// them. With a config (e.g. Release) the target's `configs.<config>` value
// wins over its `base` value, the way Xcode resolves them.
//
// Not a YAML parser: it follows the indentation of mapping keys, which is all
// project.yml's `targets.<name>.settings` blocks use. List items are skipped.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const PROJECT_FILE = fileURLToPath(
  new URL("../project.yml", import.meta.url),
);

/** Every `a.b.c` mapping path in the file with its scalar value. */
export function scalarPaths(source) {
  const values = new Map();
  const stack = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^( *)([^\s#:-][^:#]*?):(?:\s+(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    stack.push({ indent, key: match[2].trim() });
    const value = scalar(match[3]);
    if (value !== undefined) {
      values.set(stack.map((entry) => entry.key).join("."), value);
    }
  }
  return values;
}

function scalar(raw) {
  if (raw === undefined) return undefined;
  const text = raw.replace(/\s+#.*$/, "").trim();
  if (!text) return undefined;
  const quoted = text.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : text;
}

export function targetSetting(source, target, setting, config) {
  const values = scalarPaths(source);
  const prefix = `targets.${target}.settings`;
  return (
    (config && values.get(`${prefix}.configs.${config}.${setting}`)) ||
    values.get(`${prefix}.base.${setting}`)
  );
}

export function readTargetSetting(target, setting, config) {
  return targetSetting(
    fs.readFileSync(PROJECT_FILE, "utf8"),
    target,
    setting,
    config,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [target, setting, config] = process.argv.slice(2);
  if (!target || !setting) {
    console.error("usage: project-settings.mjs <target> <setting> [config]");
    process.exit(2);
  }
  const value = readTargetSetting(target, setting, config);
  if (!value) {
    console.error(
      `::error::No ${setting} for the ${target} target${config ? ` (${config})` : ""} in project.yml`,
    );
    process.exit(1);
  }
  console.log(value);
}
