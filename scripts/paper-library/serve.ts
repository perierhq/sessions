import { join } from "node:path";
export const CHROME =
  process.env.PAPER_LIB_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
export function serveDir(dir: string) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const f = Bun.file(join(dir, p === "/" ? "index.html" : p));
      return (await f.exists())
        ? new Response(f)
        : new Response("", { status: 404 });
    },
  });
}
