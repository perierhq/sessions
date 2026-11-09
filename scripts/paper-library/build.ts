#!/usr/bin/env bun
/**
 * Builds a static specimen page from the real ui/ primitives and the app's real
 * stylesheets, so extract.ts can read computed styles off live DOM.
 *
 * CSS = base.css (imports inlined, same order as frontend-build.ts) + legacy.css
 * + the Tailwind sheet compiled from styles/tailwind.css (+ this folder as an
 * extra @source). Interaction pseudo-classes are rewritten so a specimen can
 * force a state with data-force-hover / -active / -focus.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
const FE = join(ROOT, "packages/core/opensession-server/src/frontend");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
const OUT = join(HERE, "out", ONLY ?? "all");
mkdirSync(OUT, { recursive: true });

// 1. base.css with local imports inlined, then legacy.css.
const baseCss = await Bun.file(`${FE}/styles/base.css`).text();
const imports = await Promise.all(
  [...baseCss.matchAll(/^@import "\.\/([^"]+)";$/gm)].map((m) =>
    Bun.file(`${FE}/styles/${m[1]}`).text(),
  ),
);
let i = 0;
let css = baseCss.replace(
  /^@import "\.\/([^"]+)";$/gm,
  () => imports[i++] ?? "",
);
css += `\n${await Bun.file(`${FE}/styles/legacy.css`).text()}`;

// 2. Tailwind, scanning the frontend tree plus the specimens.
const twIn = join(OUT, ".tw-in.css");
writeFileSync(
  twIn,
  `@import "${FE}/styles/tailwind.css";\n@source "${HERE}/specimens";\n`,
);
const tw = Bun.spawn(
  [
    `${ROOT}/node_modules/.bin/tailwindcss`,
    "-i",
    twIn,
    "-o",
    join(OUT, ".tw.css"),
  ],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
if ((await tw.exited) !== 0)
  throw new Error(await new Response(tw.stderr).text());
css += `\n${await Bun.file(join(OUT, ".tw.css")).text()}`;

// 3. Forceable states. `:hover` → `:is(:hover,[data-force-hover])` etc.
//    Skip `:hover` inside @media queries' parens (only selectors match `:x` here).
const force = (s: string, pseudo: string, attr: string) =>
  s.replace(
    new RegExp(`(?<!\\\\):${pseudo}(?![-\\w])`, "g"),
    `:is(:${pseudo},[data-force-${attr}],[data-force-${attr}-in] > *)`,
  );
css = force(css, "hover", "hover");
css = force(css, "active", "active");
css = force(css, "focus-visible", "focus");
css = force(css, "focus-within", "focus");
// The rewrite touches `@media (hover: hover)` too — undo it there.
css = css.replace(
  /\(hover: ?:is\(:hover,\[data-force-hover\],\[data-force-hover-in\] > \*\)\)/g,
  "(hover: hover)",
);

// Paper draws circular corners: use the app's circular-fallback radii (--rf
// 0.771, the Safari path) instead of Chrome's squircle 1.35.
css += `
@supports (corner-shape: squircle) {
  :root { --rf: 0.771 !important; --cs: round !important; }
  * { corner-shape: round !important; }
}
*, *::before, *::after { transition: none !important; animation-play-state: paused !important; caret-color: transparent !important; }
`;
writeFileSync(join(OUT, "app.css"), css);

// 4. JS bundle.
const result = await Bun.build({
  entrypoints: [join(HERE, "entry.tsx")],
  outdir: OUT,
  target: "browser",
  minify: false,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: ONLY
    ? [
        {
          name: "only-specimens",
          setup(b) {
            b.onResolve({ filter: /^\.\/specimens$/ }, () => ({
              path: join(HERE, "specimens", `${ONLY}.tsx`),
            }));
          },
        },
      ]
    : [],
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css"></head>
<script>const q = new URLSearchParams(location.search); document.documentElement.dataset.theme = q.get("theme") || "light"; document.documentElement.dataset.accent = q.get("accent") || "sky";</script>
<body style="margin:0;background:var(--bg)"><div id="root"></div>
<script type="module" src="entry.js"></script></body></html>`,
);
console.log("built", OUT);
