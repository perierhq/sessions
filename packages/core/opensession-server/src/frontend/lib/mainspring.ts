// Mainspring in Settings, Providers: the owner-only settings behind
// /api/settings/mainspring (server/routes/mainspring.ts). The key is
// write-only: it goes up in a PUT and never comes back, only its last four.
// Pure apart from the fetches, so the section and its tests share one
// reading.

import { z } from "zod";
import { ApiError, request } from "./api/request";
import { BASE_PATH } from "./base";

export const MAINSPRING_PURPOSE =
  "Run Claude on the subscriptions pooled in your Mainspring gateway instead of the accounts connected here.";

/** The setup doc, for the full steps. */
export const MAINSPRING_DOCS_URL =
  "https://github.com/perierhq/sessions/blob/main/docs/setup/mainspring.md";

const viewSchema = z.object({
  url: z.string().nullable(),
  keySet: z.boolean(),
  keyHint: z.string().nullable(),
  routeClaude: z.boolean(),
  fallbackDirect: z.boolean(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      contextWindow: z.number().optional(),
    }),
  ),
  modelsAt: z.string().nullable(),
});
export type Mainspring = z.infer<typeof viewSchema>;

const responseSchema = z.object({ mainspring: viewSchema });
const testSchema = z.object({
  test: z.union([
    z.object({ ok: z.literal(true), models: z.number() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  mainspring: viewSchema,
});
export type MainspringTest = z.infer<typeof testSchema>;

/** What the section shows. `hidden` is the server saying this person may
 *  not see it (signed out, not the owner) or an old server without the
 *  route; the section then renders nothing. */
export type MainspringLoad =
  | { kind: "ready"; settings: Mainspring }
  | { kind: "hidden" }
  | { kind: "error" };

const HIDDEN_STATUSES = new Set([401, 403, 404]);

export async function loadMainspring(
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input),
): Promise<MainspringLoad> {
  try {
    const response = await fetchImpl(`${BASE_PATH}/api/settings/mainspring`);
    if (HIDDEN_STATUSES.has(response.status)) return { kind: "hidden" };
    if (!response.ok) return { kind: "error" };
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: "ready", settings: parsed.data.mainspring }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export interface MainspringPatch {
  url?: string;
  key?: string;
  routeClaude?: boolean;
  fallbackDirect?: boolean;
}

/** The server answered, but not with the settings. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super("The server sent an unexpected answer.");
    this.name = "UnexpectedAnswerError";
  }
}

async function requestView(
  path: string,
  opts: { method: string; body?: MainspringPatch; label: string },
): Promise<Mainspring> {
  const parsed = responseSchema.safeParse(await request(path, opts));
  if (!parsed.success) throw new UnexpectedAnswerError();
  return parsed.data.mainspring;
}

export function saveMainspring(patch: MainspringPatch): Promise<Mainspring> {
  return requestView("/settings/mainspring", {
    method: "PUT",
    body: patch,
    label: "Couldn't save Mainspring",
  });
}

export function removeMainspringKey(): Promise<Mainspring> {
  return requestView("/settings/mainspring/key", {
    method: "DELETE",
    label: "Couldn't remove the key",
  });
}

export async function testMainspring(): Promise<MainspringTest> {
  const parsed = testSchema.safeParse(
    await request("/settings/mainspring/test", {
      method: "POST",
      label: "Couldn't test Mainspring",
    }),
  );
  if (!parsed.success) throw new UnexpectedAnswerError();
  return parsed.data;
}

/** A server or network error as a sentence for the person. The route's
 *  checks name the field (`key: ...`); the person only sees the reason. */
export function plainError(error: Error): string {
  if (error instanceof UnexpectedAnswerError) return error.message;
  if (!(error instanceof ApiError))
    return "Couldn't reach the server. Try again.";
  const message = error.message.trim();
  const field = /^[a-zA-Z]+: /.exec(message);
  const sentence = field
    ? message.charAt(field[0].length).toUpperCase() +
      message.slice(field[0].length + 1)
    : message;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The key's masked form: "sk-ms-…wxyz". */
export function maskedKey(hint: string | null): string {
  return hint ? `sk-ms-…${hint}` : "Key saved";
}

/** The model list's summary line: "12 models, listed Nov 12". */
export function modelsSummary(settings: Mainspring): string | null {
  if (!settings.modelsAt) return null;
  const count = settings.models.length;
  const at = new Date(settings.modelsAt);
  const day = Number.isNaN(at.getTime())
    ? ""
    : `, listed ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return `${count} ${count === 1 ? "model" : "models"}${day}`;
}
