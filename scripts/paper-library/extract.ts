#!/usr/bin/env bun
import { serveDir, CHROME } from "./serve";
/**
 * Loads out/index.html in Chrome, renders each specimen alone (?only=id), and
 * serializes it to Paper HTML. Writes out/specimens.json and out/shots/<id>.png.
 *   bun extract.ts [--theme light|dark] [--filter <substring>]
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const ROOT_OUT = join(HERE, "out");
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const theme = flag("theme", "light")!;
const OUT = join(ROOT_OUT, flag("only", "all")!);
const filter = flag("filter");

mkdirSync(join(OUT, theme === "dark" ? "shots-dark" : "shots"), {
  recursive: true,
});
const server = serveDir(OUT);
const base = `http://localhost:${server.port}/`;
// Dark: match against the dark values under their plain names, then point the
// output at the --dark-* tokens.
const tokens =
  theme === "dark"
    ? JSON.stringify(
        JSON.parse(
          readFileSync(join(ROOT_OUT, "paper-tokens-dark.json"), "utf8"),
        ).map((t: any) => ({ ...t, name: t.name.replace(/^--dark-/, "--") })),
      )
    : readFileSync(join(ROOT_OUT, `paper-tokens.json`), "utf8");
const serializer =
  `window.__TOKENS = ${tokens};\n` +
  readFileSync(join(HERE, "serialize.js"), "utf8");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1200 },
  deviceScaleFactor: 2,
});
// Components that apply the theme themselves read these, so keep them in step.
await ctx.addInitScript(
  `try { localStorage.setItem("opensession-theme", ${JSON.stringify(theme)}); localStorage.setItem("opensession-accent", "sky"); } catch {}`,
);
const page = await ctx.newPage();
await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light" });
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(`${base}?theme=${theme}`);
await page.waitForFunction(() => (window as any).__SPECS);
let specs: any[] = await page.evaluate(() => (window as any).__SPECS);
const descriptions = await page.evaluate(() => (window as any).__DESCRIPTIONS);
writeFileSync(
  join(OUT, "descriptions.json"),
  JSON.stringify(descriptions, null, 1),
);
if (filter)
  specs = specs.filter((s) =>
    `${s.group} ${s.section} ${s.name}`.includes(filter),
  );

const results: any[] = [];
for (const s of specs) {
  await page.setViewportSize({
    width: s.viewport ?? 1600,
    height: s.viewport ? 844 : 1200,
  });
  await page.goto(`${base}?only=${s.id}&theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(s.select ? 400 : 60);
  await page.addScriptTag({ content: serializer });
  const sel = s.select ?? `[data-spec="${s.id}"] > *`;
  const handle = await page.$(sel);
  if (!handle) {
    console.error("missing", s.id, s.name, sel);
    continue;
  }
  const layer = `${s.section.replace(/^.*? · /, "")} · ${s.name}`.replace(
    /^/,
    "",
  );
  const out = await handle.evaluate(
    (el, name) => (window as any).__paperSerialize(el, name),
    `${s.name}`,
  );
  await handle
    .screenshot({
      path: join(OUT, theme === "dark" ? "shots-dark" : "shots", `${s.id}.png`),
      omitBackground: true,
    })
    .catch(() => {});
  // Images: copy each source into out/<group>/img and point Paper at the file.
  const imgs = [...out.html.matchAll(/src="__IMG__([^"]+)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  for (const src of new Set(imgs)) {
    let file: string | null = null;
    try {
      mkdirSync(join(OUT, "img"), { recursive: true });
      const name = `${Bun.hash(src).toString(36)}`;
      if (src.startsWith("data:")) {
        const m = src.match(/^data:image\/([a-z+]+);base64,(.*)$/);
        if (m) {
          file = join(OUT, "img", `${name}.${m[1].replace("svg+xml", "svg")}`);
          writeFileSync(file, Buffer.from(m[2], "base64"));
        } else if (src.startsWith("data:image/svg+xml")) {
          file = join(OUT, "img", `${name}.svg`);
          writeFileSync(
            file,
            decodeURIComponent(src.slice(src.indexOf(",") + 1)),
          );
        }
      } else {
        const res = await fetch(new URL(src, base));
        if (res.ok) {
          const ext = (res.headers.get("content-type") || "image/png")
            .split("/")[1]
            .split(";")[0]
            .replace("svg+xml", "svg")
            .replace("jpeg", "jpg");
          file = join(OUT, "img", `${name}.${ext}`);
          writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        }
      }
    } catch {}
    const esc = src.replace(/&/g, "&amp;");
    out.html = out.html
      .split(`src="__IMG__${esc}"`)
      .join(file ? `src="paper-asset://${file}"` : `src=""`);
  }
  if (theme === "dark")
    out.html = out.html.replace(/var\(--color-/g, "var(--dark-color-");
  results.push({ ...s, ...out });
  process.stdout.write(".");
}
writeFileSync(
  join(OUT, `specimens-${theme}.json`),
  JSON.stringify(results, null, 1),
);
console.log(`\n${results.length} specimens -> out/specimens-${theme}.json`);
await browser.close();
server.stop();
