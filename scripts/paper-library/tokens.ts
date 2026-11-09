#!/usr/bin/env bun
import { serveDir, CHROME } from "./serve";
// Dumps the app's Tailwind-namespace tokens resolved in a theme -> out/tokens-<theme>.json
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HERE = import.meta.dir,
  OUT = join(HERE, "out"),
  PAGE = join(OUT, "button");
const theme = process.argv[2] ?? "light";
const tw = readFileSync(
  join(
    HERE,
    "../../packages/core/opensession-server/src/frontend/styles/tailwind.css",
  ),
  "utf8",
);
const block = tw.slice(tw.indexOf("@theme inline {"));
const names = [
  ...block.matchAll(
    /^\s*(--(?:color|text|radius|font-weight|spacing)-[a-z0-9-]+):\s*([^;]+);/gm,
  ),
]
  .filter((m) => !/^--[a-z0-9-]+--/.test(m[1]))
  .map((m) => [m[1], m[2].trim()]);
const server = serveDir(PAGE);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.port}/?theme=${theme}`);
const out = await page.evaluate((names) => {
  const res: any[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  // Tailwind's @theme inline doesn't emit vars; resolve via the utility's base var.
  const css = [...document.styleSheets].flatMap((s) => {
    try {
      return [...s.cssRules];
    } catch {
      return [];
    }
  });
  for (const [n, expr] of names) {
    const kind = n.split("-")[2];
    let type =
      kind === "color"
        ? "color"
        : kind === "text"
          ? "fontSize"
          : kind === "radius"
            ? "radius"
            : kind === "font"
              ? "fontWeight"
              : "spacing";
    el.removeAttribute("style");
    el.className = "";
    if (type === "color") {
      el.style.backgroundColor = expr;
      res.push({
        name: n,
        type,
        value: getComputedStyle(el).backgroundColor,
        expr,
      });
      continue;
    }
    if (type === "fontSize") {
      el.style.fontSize = expr;
      res.push({ name: n, type, value: getComputedStyle(el).fontSize, expr });
      continue;
    }
    if (type === "radius" && !expr.includes("%")) {
      el.style.borderTopLeftRadius = expr;
      res.push({
        name: n,
        type,
        value: getComputedStyle(el).borderTopLeftRadius,
        expr,
      });
      continue;
    }
    if (type === "spacing") {
      el.style.width = expr;
      res.push({ name: n, type, value: getComputedStyle(el).width, expr });
      continue;
    }
    const util = n
      .replace(/^--color-/, "bg-")
      .replace(/^--text-/, "text-")
      .replace(/^--radius-/, "rounded-")
      .replace(/^--font-weight-/, "font-")
      .replace(/^--spacing-/, "w-");
    el.className = util;
    const cs = getComputedStyle(el);
    let v =
      type === "color"
        ? cs.backgroundColor
        : type === "fontSize"
          ? cs.fontSize
          : type === "radius"
            ? cs.borderTopLeftRadius
            : type === "fontWeight"
              ? cs.fontWeight
              : cs.width;
    res.push({ name: n, type, value: v, util });
  }
  return res;
}, names);
writeFileSync(join(OUT, `tokens-${theme}.json`), JSON.stringify(out, null, 1));
console.log(out.map((t: any) => `${t.name} ${t.value}`).join("\n"));
await browser.close();
server.stop();
