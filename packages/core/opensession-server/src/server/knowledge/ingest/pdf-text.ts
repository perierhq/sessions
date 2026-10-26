/**
 * PDF text for the file import, read in a child process.
 *
 * pdf.js parses whatever a person uploads. A crafted file can spin or
 * balloon memory, so the parse runs in a child of its own: this binary
 * re-executed with the `knowledge-pdf-text` subcommand (src/main.ts) when
 * compiled, `bun pdf-text.ts` from source (runner-host/exe.ts decides).
 * The parent writes the PDF to the child's stdin and reads one JSON answer
 * from its stdout. It kills the child after PDF_TIMEOUT_MS, when its
 * resident memory passes PDF_MAX_RSS_BYTES (polled; `ulimit -v` can't be
 * used: Bun reserves far more address space than it touches), when its
 * answer is larger than any text it may send, and when the job's signal
 * aborts. The child gets only PATH and HOME from the environment.
 *
 * The child checks for credentials itself: the document's metadata
 * (getMetadata) and the text of every page, also the pages past the text
 * budget, so a credential on page 900 still skips the file that would
 * otherwise be attached whole. A PDF with more than PDF_MAX_PAGES pages
 * can't be checked in full and is reported `partial` (the import then
 * keeps the text but doesn't attach the file).
 */
import { findSecrets } from "../../memory-repo/secrets";
import { knowledgePdfTextArgv } from "../../../runner-host/exe";

export const PDF_TIMEOUT_MS = 60_000;
export const PDF_MAX_RSS_BYTES = 1024 * 1024 * 1024;
/** Pages read and checked from one PDF. */
export const PDF_MAX_PAGES = 2000;
/** Characters of text the child sends back (an item holds less). */
export const PDF_TEXT_CHARS = 256 * 1024;
/** A PDF the child accepts on stdin (the import's 10 MB, with room). */
const MAX_INPUT_BYTES = 11 * 1024 * 1024;
/** Its answer: the text budget as UTF-8 JSON, with room. */
const MAX_OUTPUT_BYTES = PDF_TEXT_CHARS * 8 + 64 * 1024;
const RSS_POLL_MS = 250;

export type PdfTextResult =
  /** `cut`: there was more text than PDF_TEXT_CHARS. `partial`: pages past
   *  PDF_MAX_PAGES weren't read or checked. */
  | { text: string; cut: boolean; partial: boolean }
  /** The metadata or a page looked like it holds a credential. */
  | { secret: true }
  | { error: "timeout" | "memory" | "unreadable" };

/** Every string inside `value` (metadata dictionaries nest). */
function strings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 10_000) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value))
    for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out, depth + 1);
    }
}

const hasSecret = (text: string) => findSecrets(text).length > 0;

/** The child's work: text and credential check of the PDF in `bytes`. */
export async function readPdf(bytes: Uint8Array): Promise<PdfTextResult> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes, {
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      // Errors only: a missing standard font still yields its text.
      verbosity: 0,
    });
  } catch {
    return { error: "unreadable" };
  }
  try {
    // Metadata: the info dictionary and the XMP packet.
    const meta = await pdf.getMetadata().catch(() => null);
    if (meta) {
      const found: string[] = [];
      strings(meta.info, found);
      const xmp = meta.metadata as { getAll?: () => unknown } | null;
      if (xmp?.getAll) strings(xmp.getAll(), found);
      if (hasSecret(found.join("\n"))) return { secret: true };
    }
    const pages: string[] = [];
    let size = 0;
    let cut = false;
    const last = Math.min(pdf.numPages, PDF_MAX_PAGES);
    for (let n = 1; n <= last; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      page.cleanup();
      // Every page is checked, also those past the text budget.
      if (hasSecret(text)) return { secret: true };
      const room = PDF_TEXT_CHARS - size;
      if (text.length > room) cut = true;
      if (room > 0) {
        const kept = text.slice(0, room);
        pages.push(kept);
        size += kept.length;
      }
    }
    return {
      text: pages.join("\n\n"),
      cut,
      partial: pdf.numPages > PDF_MAX_PAGES,
    };
  } catch {
    return { error: "unreadable" };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** The child process: a PDF on stdin, one JSON PdfTextResult on stdout. */
export async function runPdfTextWorker(): Promise<void> {
  const input = new Uint8Array(await Bun.stdin.arrayBuffer());
  const result: PdfTextResult =
    input.byteLength > MAX_INPUT_BYTES
      ? { error: "unreadable" }
      : await readPdf(input);
  await Bun.write(Bun.stdout, JSON.stringify(result));
  // pdf.js may leave timers behind; the answer is out.
  process.exit(0);
}

/** argv for the child: this binary's `knowledge-pdf-text` subcommand when
 *  compiled, else bun with this file. */
export function pdfTextArgv(): string[] {
  return knowledgePdfTextArgv(process.execPath, import.meta.path);
}

/** Resident memory of `pid` in bytes; null when it can't be read. */
async function rssOf(pid: number): Promise<number | null> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    if (kb) return Number(kb) * 1024;
  } catch {
    // No /proc (macOS): ask ps.
  }
  try {
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const kb = Number((await new Response(ps.stdout).text()).trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

export interface PdfChildOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRssBytes?: number;
  /** Replaces pdfTextArgv() (tests). */
  argv?: string[];
}

/**
 * The text of the PDF in `bytes`, read by a child process (see the module
 * comment). Rejects with the signal's reason when it aborts.
 */
export async function pdfTextInChild(
  bytes: Uint8Array,
  opts: PdfChildOptions = {},
): Promise<PdfTextResult> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const proc = Bun.spawn(opts.argv ?? pdfTextArgv(), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    },
  });
  let killed: "timeout" | "memory" | "aborted" | "output" | null = null;
  const kill = (why: NonNullable<typeof killed>) => {
    killed ??= why;
    proc.kill("SIGKILL");
  };
  const timer = setTimeout(
    () => kill("timeout"),
    opts.timeoutMs ?? PDF_TIMEOUT_MS,
  );
  const maxRss = opts.maxRssBytes ?? PDF_MAX_RSS_BYTES;
  let polling = false;
  const watchdog = setInterval(() => {
    if (polling) return;
    polling = true;
    void rssOf(proc.pid)
      .then((rss) => {
        if (rss !== null && rss > maxRss) kill("memory");
      })
      .finally(() => {
        polling = false;
      });
  }, RSS_POLL_MS);
  const abort = () => kill("aborted");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    try {
      proc.stdin.write(bytes);
      await proc.stdin.end();
    } catch {
      // The child is gone already; its exit says why.
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        kill("output");
        break;
      }
      chunks.push(chunk);
    }
    const code = await proc.exited;
    if (killed === "aborted") throw signal?.reason ?? new Error("Aborted");
    if (killed === "timeout" || killed === "memory") return { error: killed };
    if (killed || code !== 0) return { error: "unreadable" };
    const parsed = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    ) as PdfTextResult;
    if ("secret" in parsed && parsed.secret === true) return { secret: true };
    if ("text" in parsed && typeof parsed.text === "string")
      return {
        text: parsed.text,
        cut: parsed.cut === true,
        partial: parsed.partial === true,
      };
    return { error: "unreadable" };
  } catch (error) {
    if (killed === "aborted") throw signal?.reason ?? error;
    return { error: "unreadable" };
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    signal?.removeEventListener("abort", abort);
    if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
  }
}

if (import.meta.main) await runPdfTextWorker();
