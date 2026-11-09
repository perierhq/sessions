#!/usr/bin/env bun
import { serveDir, CHROME } from "./serve";
/**
 * Side-by-side check: the real render (shots/<id>.png) next to the serialized
 * Paper HTML rendered as plain HTML with the Paper tokens defined.
 *   bun preview.ts --only <group> [--theme light]  -> out/<group>/compare.png
 * A row that differs between left and right is a serializer or specimen bug.
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const group = flag("only", "all")!;
const theme = flag("theme", "light")!;
const OUT = join(HERE, "out", group);
const ids = flag("ids")?.split(",");
const specs = JSON.parse(
  readFileSync(join(OUT, `specimens-${theme}.json`), "utf8"),
).filter((s: any) => !ids || ids.includes(s.id));
const outName =
  (ids ? "compare-sel" : "compare") + (theme === "dark" ? "-dark" : "");
const tokens = [
  ...JSON.parse(readFileSync(join(HERE, "out", "paper-tokens.json"), "utf8")),
  ...(theme === "dark"
    ? JSON.parse(
        readFileSync(join(HERE, "out", "paper-tokens-dark.json"), "utf8"),
      )
    : []),
];
const vars = tokens
  .map(
    (t: any) =>
      `${t.name}: ${t.type === "fontFamily" ? `'${t.value}'` : t.value};`,
  )
  .join("\n");
const htmlFix = (h: string) => h.split(`paper-asset://${OUT}/`).join("");
const row = (s: any) => `
<div style="display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid ${theme === "dark" ? "#333" : "#eee"}">
  <div style="font:11px/14px system-ui;color:#888">${s.id} · ${s.group} / ${s.section} / ${s.name}</div>
  <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
    <div style="display:flex;flex-direction:column;gap:4px"><span style="font:10px system-ui;color:#aaa">real</span><img src="${theme === "dark" ? "shots-dark" : "shots"}/${s.id}.png" style="width:${s.w}px;height:${s.h}px"></div>
    <div style="display:flex;flex-direction:column;gap:4px"><span style="font:10px system-ui;color:#aaa">paper html</span><div style="display:flex">${htmlFix(s.html)}</div></div>
  </div>
</div>`;
// Pages of 25 so a screenshot never passes Chrome's ~16k px limit.
const pages: any[][] = [];
for (let i = 0; i < specs.length; i += 25) pages.push(specs.slice(i, i + 25));
const server = serveDir(OUT);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({
  viewport: { width: 1500, height: 900 },
  deviceScaleFactor: 1,
});
const files: string[] = [];
for (const [n, chunk] of pages.entries()) {
  const name = pages.length > 1 ? `${outName}-${n + 1}` : outName;
  writeFileSync(
    join(OUT, `${name}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}} body{margin:0;padding:24px;background:${theme === "dark" ? "#181818" : "#fff"}} *{box-sizing:border-box} span{display:inline-block} svg{display:block}</style></head><body>${chunk.map(row).join("")}</body></html>`,
  );
  await page.goto(`http://localhost:${server.port}/${name}.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  files.push(join(OUT, `${name}.png`));
}
console.log(files.join("\n"));
await browser.close();
server.stop();
