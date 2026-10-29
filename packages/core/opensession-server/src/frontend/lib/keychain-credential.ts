/**
 * The Keychain's add and edit dialog as plain data: the form a credential
 * opens with, the spec it saves, whether an edit changed anything, and the
 * words for its expiry and its test result. Pure, so the dialog stays a
 * component file and these rules are tested on their own.
 */
import { ceilingWidening } from "../../shared/keychain-ceiling";
import {
  KEYCHAIN_METHODS,
  type KeychainCredentialDto,
  type KeychainCredentialSpec,
  type KeychainMethod,
} from "./api/settings";

export interface CredentialFormState {
  /** What people read; optional. */
  name: string;
  /** The ID agents use: a slug, following the name until edited. */
  service: string;
  host: string;
  description: string;
  /** "" means Authorization. */
  header: string;
  /** The word before the secret: Bearer, Basic, Token, or "" for none. */
  scheme: string;
  methods: KeychainMethod[];
  /** Comma-separated, as typed. */
  prefixes: string;
  statusOnly: boolean;
  workspace: boolean;
  /** YYYY-MM-DD, or "" for none. */
  expiresOn: string;
  testPath: string;
}

export function credentialForm(c?: KeychainCredentialDto): CredentialFormState {
  return {
    name: c?.name ?? "",
    service: c?.service ?? "",
    host: c?.host ?? "",
    description: c?.description ?? "",
    header: c?.injection?.header ?? "",
    scheme: c?.injection?.scheme ?? defaultScheme(c?.injection?.header ?? ""),
    methods: KEYCHAIN_METHODS.filter((m) => c?.allowedMethods?.includes(m)),
    prefixes: (c?.allowedPathPrefixes ?? []).join(", "),
    statusOnly: c?.statusOnly === true,
    workspace: c?.scope === "workspace",
    expiresOn: c?.expiresOn ?? "",
    testPath: c?.testPath ?? "",
  };
}

export function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Every field of the form as the server takes it. An empty field is sent
 * as a clear (`""`, `[]`, `null`), so saving an edit can remove a limit;
 * on an add the server drops them.
 */
export function credentialSpec(
  form: CredentialFormState,
): KeychainCredentialSpec & { service: string; host: string } {
  return {
    name: form.name.trim(),
    service: serviceSlug(form.service),
    host: form.host.trim(),
    description: form.description.trim(),
    injection: injectionOf(form),
    allowedMethods: form.methods,
    allowedPathPrefixes: list(form.prefixes),
    statusOnly: form.statusOnly,
    scope: form.workspace ? "workspace" : "personal",
    expiresOn: form.expiresOn || null,
    testPath: form.testPath.trim() || null,
  };
}

/**
 * What a person types as a credential's ID (or the name it follows) as the
 * server's slug rule takes it: lower-case, each run of other characters one
 * "-", nothing before the first letter or digit, no "-" at the end. While
 * `typing`, a trailing "-" stays, so the next word can follow it.
 */
export function serviceSlug(raw: string, typing = false): string {
  const slug = raw
    .toLowerCase()
    .replace(/-*[^a-z0-9._-]+-*/g, "-")
    .replace(/^[._-]+/, "");
  return typing ? slug : slug.replace(/-+$/, "");
}

/** What people call a credential: its name, else its ID. */
export function credentialName(c: { name?: string; service: string }): string {
  return c.name || c.service;
}

/** A server refusal about the ID, worded for the field it shows under;
 *  null for any other error. */
export function serviceIdError(message: string): string | null {
  if (/^service must\b/i.test(message))
    return "The ID takes lowercase letters, digits, . _ and -, starting with a letter or digit";
  const taken = /credential for service "([^"]*)" already exists/i.exec(
    message,
  );
  return taken
    ? `A credential with the ID ${taken[1]} already exists. Choose another`
    : null;
}

/** The schemes the dialog offers, "" meaning none. */
export const SCHEMES = ["Bearer", "Basic", "Token", ""] as const;

/** The scheme a header gets when none is chosen, as the server decides it:
 *  Bearer for Authorization (any case), nothing for anything else. */
export function defaultScheme(header: string): string {
  const name = header.trim() || "Authorization";
  return name.toLowerCase() === "authorization" ? "Bearer" : "";
}

/** The injection to store: nothing when it is the default (Authorization:
 *  Bearer), so an untouched edit changes nothing; else what was set. */
function injectionOf(
  form: CredentialFormState,
): NonNullable<KeychainCredentialSpec["injection"]> {
  const header = form.header.trim() || "Authorization";
  const isDefaultHeader = header.toLowerCase() === "authorization";
  if (isDefaultHeader && form.scheme === "Bearer") return {};
  if (form.scheme === defaultScheme(header)) return { header };
  return { header, scheme: form.scheme };
}

/** The header line a call carries, the secret masked: what "Sends:" shows. */
export function injectionPreview(form: CredentialFormState): string {
  const header = form.header.trim() || "Authorization";
  return `${header}: ${form.scheme ? `${form.scheme} ` : ""}••••`;
}

/** Whether the form saves something different from where it started. */
export function formChanged(
  before: CredentialFormState,
  after: CredentialFormState,
): boolean {
  return (
    JSON.stringify(credentialSpec(before)) !==
    JSON.stringify(credentialSpec(after))
  );
}

const DAY_MS = 86_400_000;

/** A credential's expiry as a person reads it, in whole UTC days, as the
 *  server counts them. Null without one. */
export function expiryNote(
  expiresOn: string | undefined,
  now = Date.now(),
): { text: string; expired: boolean } | null {
  if (!expiresOn) return null;
  const today = Date.parse(
    `${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const last = Date.parse(`${expiresOn}T00:00:00Z`);
  if (Number.isNaN(last)) return null;
  const days = Math.round((last - today) / DAY_MS);
  if (days < 0) return { text: `Expired on ${expiresOn}`, expired: true };
  if (days === 0) return { text: "Expires today", expired: false };
  if (days === 1) return { text: "Expires tomorrow", expired: false };
  return { text: `Expires in ${days} days`, expired: false };
}

export type TestResult = { status: number; reason: string } | { error: string };

export interface TestOutcome {
  text: string;
  tone: "success" | "warning" | "danger";
}

/** What a test's line says, and its tone: green for a 2xx, amber for any
 *  other answer, red when no answer came back. Never the body. */
export function testOutcome(result: TestResult, path: string): TestOutcome {
  if ("error" in result)
    return {
      text: result.error.charAt(0).toUpperCase() + result.error.slice(1),
      tone: "danger",
    };
  const line = `GET ${path} answered ${result.status}${result.reason ? ` ${result.reason}` : ""}`;
  if (result.status >= 200 && result.status < 300)
    return { text: line, tone: "success" };
  if (result.status === 401 || result.status === 403)
    return {
      text: `${line}. Check the secret and the header`,
      tone: "warning",
    };
  return { text: line, tone: "warning" };
}

/** What a grant needs for editEffect to count it. */
export interface GrantForEffect {
  status: string;
  mode: string;
  implicit?: true;
  incident?: object;
}

export interface EditEffect {
  kind: "widened" | "moved";
  text: string;
}

/**
 * What saving an edit does to the grants live now, said before the save:
 * a new host ends them all, and wider limits pause the ones an owner
 * approved under the old limits (grants nobody approved, and incident
 * grants, which are re-lent from the project, don't pause). Null when no
 * grant is affected.
 */
export function editEffect(
  before: CredentialFormState,
  after: CredentialFormState,
  grants: readonly GrantForEffect[],
): EditEffect | null {
  const live = grants.filter((g) => g.status === "active");
  if (before.host.trim() !== after.host.trim()) {
    return live.length
      ? {
          kind: "moved",
          text: `Saving moves it to a new host, so its ${plural(live.length, "active grant")} ${live.length === 1 ? "ends" : "end"}`,
        }
      : null;
  }
  const widened = ceilingWidening(ceilingOf(before), ceilingOf(after));
  const approved = live.filter(
    (g) => !g.implicit && !g.incident && g.mode !== "release",
  ).length;
  if (!widened.length || !approved) return null;
  return {
    kind: "widened",
    text: `Saving widens the limits: ${widened.join("; ")}. ${plural(approved, "grant")} approved under the old limits ${approved === 1 ? "pauses until you allow it" : "pause until you allow them"} again`,
  };
}

function ceilingOf(form: CredentialFormState) {
  return {
    allowedMethods: form.methods,
    allowedPathPrefixes: list(form.prefixes).map(
      (p) => p.replace(/\/+$/, "") || "/",
    ),
    statusOnly: form.statusOnly,
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Whether the signed-in person can lend a credential to incident agents:
 *  their own, or a workspace one; never a login (the server checks again). */
export function canLend(c: KeychainCredentialDto): boolean {
  return c.kind !== "login" && (c.mine === true || c.scope === "workspace");
}

/** A project's lending in the access table's words: "investigator always,
 *  verifier ask once". */
export function lendingRoles(
  roles: NonNullable<KeychainCredentialDto["lentIn"]>[number]["roles"],
): string {
  return Object.entries(roles)
    .filter(([, mode]) => mode)
    .map(
      ([role, mode]) =>
        `${role} ${mode === "standing" ? "always" : "ask once"}`,
    )
    .join(", ");
}
