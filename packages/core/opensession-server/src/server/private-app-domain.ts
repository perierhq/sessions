/** Managed private app domains: Cloudflare DNS, ACME DNS-01, and Caddy. */
import { CADDY_STREAM_CLOSE_DELAY } from "./caddy-stream";
import { X509Certificate, randomBytes } from "crypto";
import { resolve4 } from "dns/promises";
import { connect as tlsConnect } from "tls";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { configuredServer } from "./config";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { isTailnetIpv4 } from "./shared/network-address";

export type PrivateAppDnsProvider = "cloudflare" | "vercel";
export type PrivateAppHealth =
  | "ready"
  | "waiting_dns"
  | "unreachable"
  | "not_configured";

interface PrivateAppCredential {
  version: 1;
  provider: PrivateAppDnsProvider;
  domain: string;
  email: string;
  apiToken: string;
  teamId?: string;
  upstream?: string;
  /** More private app hostnames whose certificates this credential renews.
   * Each has its own lego certificate and its own Caddy site. */
  domains?: string[];
}

export interface PrivateAppCertificateStatus {
  domain: string;
  /** Expiry of the certificate Caddy serves, or of the installed file when
   * the served one could not be read. Empty when neither is known. */
  expiresAt: string;
  /** Last renewal check, ISO time. Empty before the first check. */
  checkedAt: string;
  /** Why the last renewal check failed; empty when it succeeded. */
  renewalError: string;
}

export interface PrivateAppDomainStatus {
  health: PrivateAppHealth;
  dnsProvider: PrivateAppDnsProvider | null;
  credentialConfigured: boolean;
  certificateEmailConfigured: boolean;
  certificateExpiresAt: string;
  /** Every certificate Open Session renews, primary domain first. */
  certificates: PrivateAppCertificateStatus[];
  legoInstalled: boolean;
}

const CREDENTIAL_PATH = () => stateDir("private-app-dns.json");
const ACME_PATH = () => stateDir("private-app-acme");
const RENEWAL_PATH = () => stateDir("private-app-renewal.json");
const CADDYFILE = () =>
  process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
const TLS_DIR = () => process.env.OPENSESSION_TLS_DIR || "/etc/opensession/tls";
const MANAGED_START = "# BEGIN OPENSESSION PRIVATE APP";
const MANAGED_END = "# END OPENSESSION PRIVATE APP";
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;
const runtime = globalThis as typeof globalThis & {
  __opensessionPrivateAppRenewal?: ReturnType<typeof setInterval>;
  __opensessionPrivateAppRenewing?: boolean;
};

function safeCredential(): PrivateAppCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIAL_PATH(), "utf8"));
    if (
      parsed?.version !== 1 ||
      (parsed?.provider !== "cloudflare" && parsed?.provider !== "vercel") ||
      typeof parsed.domain !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.apiToken !== "string" ||
      (parsed.teamId !== undefined && typeof parsed.teamId !== "string") ||
      (parsed.upstream !== undefined && typeof parsed.upstream !== "string") ||
      (parsed.domains !== undefined &&
        (!Array.isArray(parsed.domains) ||
          !parsed.domains.every(
            (domain: unknown) =>
              typeof domain === "string" && HOSTNAME.test(domain),
          )))
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function certificatePaths(domain: string): {
  certificate: string;
  key: string;
} {
  return {
    certificate: join(TLS_DIR(), `${domain}.crt`),
    key: join(TLS_DIR(), `${domain}.key`),
  };
}

function legoCertificatePaths(domain: string): {
  certificate: string;
  key: string;
} {
  return {
    certificate: join(ACME_PATH(), "certificates", `${domain}.crt`),
    key: join(ACME_PATH(), "certificates", `${domain}.key`),
  };
}

function certificateExpiry(domain: string): string {
  const candidates = [
    certificatePaths(domain).certificate,
    `/etc/lego/certificates/${domain}.crt`,
  ];
  for (const path of candidates) {
    try {
      return new Date(
        new X509Certificate(readFileSync(path)).validTo,
      ).toISOString();
    } catch {}
  }
  return "";
}

async function runCommand(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function commandEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH:
      process.env.PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME || "",
    LANG: process.env.LANG || "C.UTF-8",
    ...extra,
  };
}

async function cloudflareRequest(
  token: string,
  path: string,
  init?: { method: "POST" | "PUT"; body: Record<string, unknown> },
): Promise<any> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || !payload?.success) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors
          .map((entry: any) => entry?.message)
          .filter(Boolean)
          .join("; ")
      : "";
    throw new Error(
      detail || `Cloudflare DNS request failed (${response.status})`,
    );
  }
  return payload.result;
}

export function cloudflareZoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const candidates: string[] = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    candidates.push(labels.slice(index).join("."));
  }
  return candidates;
}

async function cloudflareZone(
  token: string,
  domain: string,
): Promise<{ id: string; name: string }> {
  for (const candidate of cloudflareZoneCandidates(domain)) {
    const zones = await cloudflareRequest(
      token,
      `/zones?name=${encodeURIComponent(candidate)}&status=active`,
    );
    const zone = Array.isArray(zones) ? zones[0] : null;
    if (typeof zone?.id === "string" && typeof zone?.name === "string") {
      return { id: zone.id, name: zone.name };
    }
  }
  throw new Error(
    "The Cloudflare token cannot access the DNS zone for this domain",
  );
}

async function upsertCloudflarePrivateRecord(
  token: string,
  domain: string,
  tailnetIpv4: string,
): Promise<void> {
  const zone = await cloudflareZone(token, domain);
  const records = await cloudflareRequest(
    token,
    `/zones/${encodeURIComponent(zone.id)}/dns_records?name=${encodeURIComponent(domain)}`,
  );
  const matching = Array.isArray(records) ? records : [];
  const conflicting = matching.find((record: any) => record?.type !== "A");
  if (conflicting) {
    throw new Error(
      `${domain} already has a ${String(conflicting.type)} record in Cloudflare`,
    );
  }
  const body = {
    type: "A",
    name: domain,
    content: tailnetIpv4,
    proxied: false,
    ttl: 1,
    comment: "Managed by Open Session for private Tailscale access",
  };
  const addressRecords = matching.filter((record: any) => record?.type === "A");
  if (addressRecords.length > 1) {
    throw new Error(
      `${domain} has more than one A record in Cloudflare. Remove the extras before setup`,
    );
  }
  const existing = addressRecords[0];
  if (existing?.id) {
    await cloudflareRequest(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(existing.id)}`,
      {
        method: "PUT",
        body,
      },
    );
  } else {
    await cloudflareRequest(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records`,
      {
        method: "POST",
        body,
      },
    );
  }
}

async function vercelRequest(
  token: string,
  path: string,
  init?: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
): Promise<any> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error?.message ||
        `Vercel DNS request failed (${response.status})`,
    );
  }
  return payload;
}

function teamQuery(teamId: string | undefined): string {
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
}

export function vercelZoneForDomain(
  domain: string,
  zones: string[],
): string | null {
  return (
    zones
      .map((name) => name.toLowerCase())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .find((name) => domain === name || domain.endsWith(`.${name}`)) || null
  );
}

async function upsertVercelPrivateRecord(
  token: string,
  domain: string,
  tailnetIpv4: string,
  teamId?: string,
): Promise<void> {
  const zoneNames: string[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const listed = await vercelRequest(
      token,
      `/v5/domains?limit=100${teamQuery(teamId)}${cursor ? `&until=${encodeURIComponent(cursor)}` : ""}`,
    );
    const domains = Array.isArray(listed?.domains) ? listed.domains : [];
    zoneNames.push(...domains.map((entry: any) => String(entry?.name || "")));
    const next = listed?.pagination?.next;
    if (next === undefined || next === null || String(next) === cursor) break;
    cursor = String(next);
  }
  const zone = vercelZoneForDomain(domain, zoneNames);
  if (!zone)
    throw new Error(
      "The Vercel token cannot access the DNS zone for this domain",
    );
  const relativeName =
    domain === zone ? "" : domain.slice(0, -(zone.length + 1));
  const query = teamQuery(teamId);
  const listedRecords = await vercelRequest(
    token,
    `/v4/domains/${encodeURIComponent(zone)}/records?limit=100${query}`,
  );
  const records = Array.isArray(listedRecords?.records)
    ? listedRecords.records
    : [];
  const named = records.filter((record: any) => {
    const name = String(record?.name || "")
      .replace(/\.$/, "")
      .toLowerCase();
    return name === relativeName || name === domain;
  });
  const conflicting = named.find((record: any) => record?.type !== "A");
  if (conflicting)
    throw new Error(
      `${domain} already has a ${String(conflicting.type)} record in Vercel`,
    );
  if (named.length > 1)
    throw new Error(
      `${domain} has more than one A record in Vercel. Remove the extras before setup`,
    );
  const existing = named[0];
  if (existing?.value === tailnetIpv4) return;
  if (existing?.id) {
    await vercelRequest(
      token,
      `/v2/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(existing.id)}?${query.slice(1)}`,
      {
        method: "DELETE",
      },
    );
  }
  await vercelRequest(
    token,
    `/v2/domains/${encodeURIComponent(zone)}/records?${query.slice(1)}`,
    {
      method: "POST",
      body: { name: relativeName, type: "A", value: tailnetIpv4, ttl: 60 },
    },
  );
}

function validateCredentialInput(input: {
  domain: string;
  provider: PrivateAppDnsProvider;
  email?: string;
  apiToken?: string;
  teamId?: string;
  upstream?: string;
}): PrivateAppCredential {
  const saved = safeCredential();
  const canReuse =
    saved?.domain === input.domain && saved.provider === input.provider;
  const email = (input.email || (canReuse ? saved.email : "")).trim();
  const apiToken = (input.apiToken || (canReuse ? saved.apiToken : "")).trim();
  const teamId = (input.teamId || (canReuse ? saved.teamId : "") || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("A valid certificate email is required");
  }
  if (!apiToken || apiToken.length > 4096 || /\s/.test(apiToken)) {
    throw new Error(
      `A valid ${input.provider === "cloudflare" ? "Cloudflare" : "Vercel"} API token is required`,
    );
  }
  if (teamId && !/^(team|org)_[A-Za-z0-9]+$/.test(teamId)) {
    throw new Error("Vercel team ID must start with team_ or org_");
  }
  return {
    version: 1,
    provider: input.provider,
    domain: input.domain,
    email,
    apiToken,
    ...(input.provider === "vercel" && teamId ? { teamId } : {}),
    ...(input.upstream ? { upstream: input.upstream } : {}),
    ...(canReuse && saved.domains?.length ? { domains: saved.domains } : {}),
  };
}

export function privateAppCaddyUpstream(host: string, port: number): string {
  const normalized = host.replace(/^\[|\]$/g, "").trim();
  const upstreamHost =
    !normalized || normalized === "0.0.0.0"
      ? "127.0.0.1"
      : normalized === "::"
        ? "::1"
        : normalized;
  return `${upstreamHost.includes(":") ? `[${upstreamHost}]` : upstreamHost}:${port}`;
}

export function privateAppCaddySnippet(
  domain: string,
  tailnetIpv4: string,
  paths = certificatePaths(domain),
  upstream = "127.0.0.1:3850",
): string {
  return `${domain} {\n    ${MANAGED_START}\n    bind ${tailnetIpv4}\n    tls ${paths.certificate} ${paths.key}\n    reverse_proxy ${upstream} {\n        lb_try_duration 15s\n        lb_try_interval 250ms\n        stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}\n    }\n    ${MANAGED_END}\n}`;
}

function managedBlock(
  domain: string,
  tailnetIpv4: string,
  upstream: string,
): string {
  const paths = certificatePaths(domain);
  return `${MANAGED_START}\nbind ${tailnetIpv4}\ntls ${paths.certificate} ${paths.key}\nreverse_proxy ${upstream} {\n    lb_try_duration 15s\n    lb_try_interval 250ms\n    stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}\n}\n${MANAGED_END}`;
}

function closingBrace(source: string, opening: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let comment = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (!quoted && character === "#") {
      comment = true;
      continue;
    }
    if (character === '"' && source[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return undefined;
}

function caddySites(
  source: string,
): Array<{ header: number; opening: number; closing: number }> {
  const sites: Array<{ header: number; opening: number; closing: number }> = [];
  for (const match of source.matchAll(/^([^\n#{}]+)\{/gm)) {
    const header = match.index || 0;
    const opening = header + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (closing !== undefined) sites.push({ header, opening, closing });
  }
  return sites;
}

function siteHosts(
  caddyfile: string,
  header: number,
  opening: number,
): string[] {
  return caddyfile
    .slice(header, opening)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((address) =>
      address
        .replace(/^https?:\/\//i, "")
        .replace(/:443$/, "")
        .toLowerCase(),
    );
}

/** The Caddy site that serves `domain`, and whether Open Session's markers
 * are inside it. */
export function privateAppCaddySite(
  caddyfile: string,
  domain: string,
): { managed: boolean; usesCertificate: boolean } | null {
  const site = caddySites(caddyfile).find(({ header, opening }) =>
    siteHosts(caddyfile, header, opening).includes(domain.toLowerCase()),
  );
  if (!site) return null;
  const body = caddyfile.slice(site.opening + 1, site.closing);
  const paths = certificatePaths(domain);
  return {
    managed: body.includes(MANAGED_START),
    usesCertificate:
      body.includes(paths.certificate) && body.includes(paths.key),
  };
}

/** Update only Open Session's marked private-app site. Existing unmarked sites
 * are left alone because silently taking ownership could expose or break them.
 * With several marked sites (one per renewed domain) the one for `domain` is
 * updated; a lone marked site for another name is renamed, as before. */
export function upsertPrivateAppCaddy(
  caddyfile: string,
  domain: string,
  tailnetIpv4: string,
  upstream = "127.0.0.1:3850",
): string {
  const managed = new RegExp(
    `^[ \\t]*${MANAGED_START}[\\s\\S]*?^[ \\t]*${MANAGED_END}[ \\t]*(?:\\r?\\n)?`,
    "gm",
  );
  const marked = caddySites(caddyfile).filter(({ opening, closing }) =>
    caddyfile.slice(opening + 1, closing).includes(MANAGED_START),
  );
  const owned =
    marked.find(({ header, opening }) =>
      siteHosts(caddyfile, header, opening).includes(domain.toLowerCase()),
    ) ||
    (marked.length === 1 && !privateAppCaddySite(caddyfile, domain) // never create a duplicate site
      ? marked[0]
      : undefined);
  if (owned) {
    const body = caddyfile.slice(owned.opening + 1, owned.closing);
    const replacement = managedBlock(domain, tailnetIpv4, upstream)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    managed.lastIndex = 0;
    const nextBody = body.replace(managed, `${replacement}\n`);
    return `${caddyfile.slice(0, owned.header)}${domain} {${nextBody}${caddyfile.slice(owned.closing)}`;
  }
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(`^\\s*(?:https?://)?${escaped}(?::443)?\\s*\\{`, "m").test(
      caddyfile,
    )
  ) {
    throw new Error(
      `${domain} already has an unmanaged Caddy site. Use Advanced setup or remove that site first`,
    );
  }
  return `${caddyfile.trimEnd()}\n\n${privateAppCaddySnippet(domain, tailnetIpv4, certificatePaths(domain), upstream)}\n`;
}

function requirePrivateAppPlatform(): void {
  if (process.platform !== "linux") {
    throw new Error(
      "Automatic private-domain setup requires Linux with systemd. On this platform, use an externally managed certificate and reverse proxy; Open Session cannot manage certificate renewal.",
    );
  }
}

async function requireLego(): Promise<string> {
  const lego = Bun.which("lego");
  if (!lego) throw new Error("lego is not installed on this server");
  const version = await runCommand([lego, "--version"], commandEnvironment());
  if (version.code !== 0 || !/^lego version (?:v)?4\./m.test(version.stdout)) {
    throw new Error(
      "Automatic private-domain setup requires the official go-acme lego 4.x CLI. Re-run install.sh --caddy to install the pinned build, and ensure ~/.local/bin precedes other lego installations on the service PATH.",
    );
  }
  return lego;
}

async function issueCertificate(
  credential: PrivateAppCredential,
  lego: string,
  renew = false,
  domain = credential.domain,
): Promise<boolean> {
  mkdirSync(ACME_PATH(), { recursive: true, mode: 0o700 });
  chmodSync(ACME_PATH(), 0o700);
  const certificatePath = legoCertificatePaths(domain).certificate;
  const before = existsSync(certificatePath)
    ? readFileSync(certificatePath)
    : null;
  const args = [
    lego,
    "--path",
    ACME_PATH(),
    "--email",
    credential.email,
    "--accept-tos",
    "--dns",
    credential.provider,
    "--domains",
    domain,
    renew ? "renew" : "run",
  ];
  if (renew) args.push("--days", "30");
  const dnsEnvironment: Record<string, string> =
    credential.provider === "cloudflare"
      ? { CF_DNS_API_TOKEN: credential.apiToken }
      : {
          VERCEL_API_TOKEN: credential.apiToken,
          ...(credential.teamId ? { VERCEL_TEAM_ID: credential.teamId } : {}),
        };
  const result = await runCommand(args, commandEnvironment(dnsEnvironment));
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Let’s Encrypt certificate request failed",
    );
  }
  const after = existsSync(certificatePath)
    ? readFileSync(certificatePath)
    : null;
  return Boolean(after && (!before || !before.equals(after)));
}

async function caddyGroup(): Promise<string> {
  const id = Bun.which("id");
  if (!id) return "caddy";
  const caddy = await runCommand([id, "-gn", "caddy"], commandEnvironment());
  if (caddy.code === 0 && /^[a-z_][a-z0-9_-]*$/i.test(caddy.stdout.trim()))
    return caddy.stdout.trim();
  const current = await runCommand([id, "-gn"], commandEnvironment());
  return /^[a-z_][a-z0-9_-]*$/i.test(current.stdout.trim())
    ? current.stdout.trim()
    : "caddy";
}

/** The Caddyfile is often readable only by root and the caddy group. */
async function readCaddyfile(sudo: string | null): Promise<string | null> {
  try {
    return readFileSync(CADDYFILE(), "utf8");
  } catch {}
  if (!sudo) return null;
  const read = await runCommand(
    [sudo, "-n", "cat", CADDYFILE()],
    commandEnvironment(),
  );
  return read.code === 0 ? read.stdout : null;
}

/** Copy lego's certificate and key to the paths the Caddy site loads
 * (root:<caddy group>, certificate 0644, key 0640). */
async function installCertificateFiles(
  domain: string,
  sudo: string,
  group: string,
): Promise<void> {
  const source = legoCertificatePaths(domain);
  const target = certificatePaths(domain);
  const runSudo = (args: string[]) =>
    runCommand([sudo, "-n", ...args], commandEnvironment());
  for (const [from, to, mode] of [
    [source.certificate, target.certificate, "0644"],
    [source.key, target.key, "0640"],
  ] as const) {
    const result = await runSudo([
      "install",
      "-m",
      mode,
      "-o",
      "root",
      "-g",
      group,
      from,
      to,
    ]);
    if (result.code !== 0)
      throw new Error(
        `Could not install the private app certificate for ${domain}: ${result.stderr.trim() || `install exited ${result.code}`}`,
      );
  }
}

/** Make Caddy re-read certificate files without dropping runtime Portal
 * servers. The same tls config is PATCHed back with `Cache-Control:
 * must-revalidate` (what `caddy reload --force` sends), so Caddy reprovisions
 * its running config, Portal servers included, and loads the new files. A
 * `systemctl reload` replaces the config with the Caddyfile and drops Portal
 * servers until Open Session re-creates them, so it is only the fallback. */
async function reloadCaddyCertificates(sudo: string): Promise<string> {
  const admin = configuredServer().caddyAdmin.replace(/\/+$/, "");
  let adminError = "";
  try {
    const current = await fetch(`${admin}/config/apps/tls`, {
      signal: AbortSignal.timeout(5_000),
    });
    const tls = current.ok ? await current.text() : "";
    if (!tls.trim().startsWith("{"))
      throw new Error(`no tls app (${current.status})`);
    const patched = await fetch(`${admin}/config/apps/tls`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "must-revalidate",
      },
      body: tls,
      signal: AbortSignal.timeout(60_000),
    });
    if (patched.ok) return "admin API";
    throw new Error(
      `${patched.status} ${(await patched.text().catch(() => "")).trim()}`,
    );
  } catch (error) {
    adminError = error instanceof Error ? error.message : String(error);
  }
  const reload = await runCommand(
    [sudo, "-n", "systemctl", "reload", "caddy"],
    commandEnvironment(),
  );
  if (reload.code !== 0)
    throw new Error(
      `Caddy did not reload (admin API: ${adminError}; systemctl: ${reload.stderr.trim() || `exit ${reload.code}`})`,
    );
  console.warn(
    `[private-app] reloaded Caddy with systemctl (admin API: ${adminError}); Portal routes come back on their next status check`,
  );
  return "systemctl";
}

async function installCertificateAndCaddy(
  domain: string,
  tailnetIpv4: string,
  upstream = "127.0.0.1:3850",
): Promise<void> {
  requirePrivateAppPlatform();
  const caddy = Bun.which("caddy");
  const sudo = Bun.which("sudo");
  if (!caddy || !sudo)
    throw new Error(
      "Caddy and passwordless sudo are required for automatic setup",
    );
  const source = legoCertificatePaths(domain);
  if (!existsSync(source.certificate) || !existsSync(source.key)) {
    throw new Error(
      "Let’s Encrypt did not produce the expected certificate files",
    );
  }
  const caddyfile = CADDYFILE();
  const current = await readCaddyfile(sudo);
  if (current === null) throw new Error(`Could not read ${caddyfile}`);
  const next = upsertPrivateAppCaddy(current, domain, tailnetIpv4, upstream);
  const scratch = mkdtempSync(
    join(
      tmpdir(),
      `opensession-private-domain-${randomBytes(4).toString("hex")}-`,
    ),
  );
  const staged = join(scratch, "Caddyfile");
  const backup = `${caddyfile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const group = await caddyGroup();
  const runSudo = (args: string[]) =>
    runCommand([sudo, "-n", ...args], commandEnvironment());
  const rollback = async () => {
    await runSudo(["cp", "-p", backup, caddyfile]);
    await runSudo(["systemctl", "reload", "caddy"]);
  };
  try {
    await Bun.write(staged, next);
    if ((await runSudo(["cp", "-p", caddyfile, backup])).code !== 0)
      throw new Error("Could not back up the Caddyfile");
    if (
      (
        await runSudo([
          "install",
          "-d",
          "-m",
          "0750",
          "-o",
          "root",
          "-g",
          group,
          TLS_DIR(),
        ])
      ).code !== 0
    ) {
      throw new Error(`Could not create ${TLS_DIR()}`);
    }
    await installCertificateFiles(domain, sudo, group);
    if (
      (await runSudo(["install", "-m", "0644", staged, caddyfile])).code !== 0
    ) {
      await rollback();
      throw new Error(
        "Could not install the private app Caddy site; the prior Caddyfile was restored",
      );
    }
    const validation = await runSudo([
      caddy,
      "validate",
      "--config",
      caddyfile,
      "--adapter",
      "caddyfile",
    ]);
    if (validation.code !== 0) {
      await rollback();
      throw new Error(
        validation.stderr.trim() ||
          "Caddy rejected the private app configuration",
      );
    }
    const reload = await runSudo(["systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      throw new Error(reload.stderr.trim() || "Caddy reload failed");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function appHealth(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppHealth> {
  if (!origin || !origin.startsWith("https://")) return "not_configured";
  let domain = "";
  try {
    domain = new URL(origin).hostname;
  } catch {
    return "not_configured";
  }
  const records = await resolve4(domain).catch((): string[] => []);
  if (!tailnetIpv4 || !records.includes(tailnetIpv4)) return "waiting_dns";
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "ready" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function privateAppDomainStatus(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppDomainStatus> {
  let domain = "";
  try {
    domain = new URL(origin).hostname;
  } catch {}
  const credential = safeCredential();
  const renewal = readRenewalState();
  const domains =
    credential?.domain === domain
      ? privateAppCertificateDomains(credential)
      : domain
        ? [domain]
        : [];
  const certificates = domains.map((name) => {
    const recorded = renewal[name];
    return {
      domain: name,
      expiresAt: recorded?.expiresAt || certificateExpiry(name),
      checkedAt: recorded?.checkedAt || "",
      renewalError: recorded?.error || "",
    };
  });
  return {
    health: await appHealth(origin, tailnetIpv4),
    dnsProvider: credential?.domain === domain ? credential.provider : null,
    credentialConfigured: credential?.domain === domain,
    certificateEmailConfigured:
      credential?.domain === domain && Boolean(credential.email),
    certificateExpiresAt: certificates[0]?.expiresAt || "",
    certificates,
    legoInstalled: Bun.which("lego") !== null,
  };
}

export async function configurePrivateAppDomain(input: {
  domain: string;
  provider: PrivateAppDnsProvider;
  email?: string;
  apiToken?: string;
  teamId?: string;
  upstream?: string;
  tailnetIpv4: string | null;
}): Promise<void> {
  requirePrivateAppPlatform();
  if (!input.tailnetIpv4)
    throw new Error(
      "Connect this server to Tailscale before setting up a private domain",
    );
  if (!Bun.which("caddy"))
    throw new Error("Caddy is not installed on this server");
  const lego = await requireLego();
  const credential = validateCredentialInput(input);
  if (credential.provider === "cloudflare") {
    await upsertCloudflarePrivateRecord(
      credential.apiToken,
      credential.domain,
      input.tailnetIpv4,
    );
  } else {
    await upsertVercelPrivateRecord(
      credential.apiToken,
      credential.domain,
      input.tailnetIpv4,
      credential.teamId,
    );
  }
  await issueCertificate(
    credential,
    lego,
    existsSync(legoCertificatePaths(credential.domain).certificate),
  );
  await installCertificateAndCaddy(
    credential.domain,
    input.tailnetIpv4,
    credential.upstream,
  );
  writeJsonAtomic(CREDENTIAL_PATH(), credential, true, 0o600);
}

export async function testPrivateAppDomain(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppDomainStatus> {
  return privateAppDomainStatus(origin, tailnetIpv4);
}

interface RenewalRecord {
  checkedAt: string;
  expiresAt: string;
  error?: string;
}

function readRenewalState(): Record<string, RenewalRecord> {
  try {
    const parsed = JSON.parse(readFileSync(RENEWAL_PATH(), "utf8"));
    return parsed?.version === 1 && parsed.domains ? parsed.domains : {};
  } catch {
    return {};
  }
}

function writeRenewalState(domains: Record<string, RenewalRecord>): void {
  try {
    writeJsonAtomic(RENEWAL_PATH(), { version: 1, domains }, true, 0o600);
  } catch (error) {
    console.error("[private-app] could not save the renewal status:", error);
  }
}

/** The configured domain first, then any extra `domains`, deduplicated. */
export function privateAppCertificateDomains(credential: {
  domain: string;
  domains?: string[];
}): string[] {
  return [
    ...new Set(
      [credential.domain, ...(credential.domains || [])].map((domain) =>
        domain.toLowerCase(),
      ),
    ),
  ];
}

function readCertificate(path: string): X509Certificate | null {
  try {
    return new X509Certificate(readFileSync(path));
  } catch {
    return null;
  }
}

/** The leaf certificate Caddy serves for `domain` on its tailnet address, or
 * null when it cannot be reached (then the installed file stands in). */
async function servedCertificate(
  domain: string,
): Promise<X509Certificate | null> {
  const records = await resolve4(domain).catch((): string[] => []);
  const host = records.find(isTailnetIpv4) || records[0];
  if (!host) return null;
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      timeout: 5_000,
    });
    const done = (certificate: X509Certificate | null) => {
      socket.destroy();
      resolve(certificate);
    };
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate()?.raw;
      try {
        done(raw ? new X509Certificate(raw) : null);
      } catch {
        done(null);
      }
    });
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

function expiresAfter(
  candidate: X509Certificate,
  current: X509Certificate | null,
): boolean {
  return (
    !current ||
    new Date(candidate.validTo).getTime() > new Date(current.validTo).getTime()
  );
}

export interface PrivateAppRenewalOptions {
  /** Reads the certificate Caddy serves. Tests replace the TLS probe. */
  servedCertificate?: (domain: string) => Promise<X509Certificate | null>;
}

/** Renew one domain and make sure Caddy serves lego's newest certificate.
 * lego's own "changed" answer is not trusted: a failed install after a
 * successful renewal would otherwise never be retried, so every check
 * compares lego's certificate with the installed file and the served one. */
async function renewDomain(
  credential: PrivateAppCredential,
  domain: string,
  lego: string,
  probe: (domain: string) => Promise<X509Certificate | null>,
): Promise<X509Certificate | null> {
  const source = legoCertificatePaths(domain);
  if (!existsSync(source.certificate) || !existsSync(source.key))
    throw new Error(
      `lego has no certificate for ${domain} in ${ACME_PATH()}; set the domain up again`,
    );
  await issueCertificate(credential, lego, true, domain);
  const renewed = readCertificate(source.certificate);
  if (!renewed)
    throw new Error(`lego's certificate for ${domain} is unreadable`);
  const installed = readCertificate(certificatePaths(domain).certificate);
  const served = await probe(domain);
  const fileStale =
    installed?.fingerprint256 !== renewed.fingerprint256 &&
    expiresAfter(renewed, installed);
  const servedStale = served
    ? served.fingerprint256 !== renewed.fingerprint256 &&
      expiresAfter(renewed, served)
    : fileStale;
  if (!fileStale && !servedStale) return served || installed;

  const sudo = Bun.which("sudo");
  if (!sudo)
    throw new Error("Passwordless sudo is required to install certificates");
  if (fileStale)
    await installCertificateFiles(domain, sudo, await caddyGroup());
  const caddyfile = await readCaddyfile(sudo);
  const site =
    caddyfile === null ? null : privateAppCaddySite(caddyfile, domain);
  if (caddyfile === null)
    console.warn(
      `[private-app] could not read ${CADDYFILE()}; reloading Caddy for ${domain} anyway`,
    );
  else if (!site)
    console.warn(
      `[private-app] no Caddy site serves ${domain}; installed its certificate in ${TLS_DIR()} only`,
    );
  else if (!site.managed)
    console.warn(
      `[private-app] ${domain} has a Caddy site without the "${MANAGED_START}" markers; installed the renewed certificate it loads and left the site unchanged`,
    );
  if (site && !site.usesCertificate)
    console.warn(
      `[private-app] the Caddy site for ${domain} does not load ${certificatePaths(domain).certificate}; it keeps its own certificate`,
    );
  const how = await reloadCaddyCertificates(sudo);
  console.log(
    `[private-app] installed the certificate for ${domain} (expires ${new Date(renewed.validTo).toISOString()}) and reloaded Caddy via ${how}`,
  );
  if (!served) return renewed;
  const after = await probe(domain);
  if (after && after.fingerprint256 !== renewed.fingerprint256)
    throw new Error(
      `Caddy still serves the certificate that expires ${new Date(after.validTo).toISOString()}`,
    );
  return after || renewed;
}

/** Check every configured private app certificate. Returns true when all of
 * them are current; failures are recorded per domain for Settings. */
export async function renewPrivateAppCertificate(
  options: PrivateAppRenewalOptions = {},
): Promise<boolean> {
  // Externally managed macOS certificates must not be renewed behind the
  // operator's back when we cannot install and reload them.
  if (process.platform !== "linux" || runtime.__opensessionPrivateAppRenewing)
    return false;
  const credential = safeCredential();
  if (!credential || !Bun.which("lego") || !Bun.which("caddy")) return false;
  runtime.__opensessionPrivateAppRenewing = true;
  const domains = privateAppCertificateDomains(credential);
  const state = readRenewalState();
  const record = (
    domain: string,
    certificate: X509Certificate | null,
    error?: unknown,
  ) => {
    state[domain] = {
      checkedAt: new Date().toISOString(),
      expiresAt: certificate
        ? new Date(certificate.validTo).toISOString()
        : certificateExpiry(domain),
      ...(error
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    };
  };
  let ok = true;
  try {
    requirePrivateAppPlatform();
    const lego = await requireLego();
    for (const domain of domains) {
      try {
        record(
          domain,
          await renewDomain(
            credential,
            domain,
            lego,
            options.servedCertificate || servedCertificate,
          ),
        );
      } catch (error) {
        ok = false;
        console.error(
          `[private-app] certificate renewal failed for ${domain}:`,
          error,
        );
        record(domain, null, error);
      }
    }
  } catch (error) {
    ok = false;
    console.error("[private-app] certificate renewal failed:", error);
    for (const domain of domains) record(domain, null, error);
  } finally {
    runtime.__opensessionPrivateAppRenewing = false;
  }
  writeRenewalState(state);
  return ok;
}

/** Check at boot and every 24 hours. lego renews only inside the 30-day
 * window, and each check retries an install that has not reached Caddy. */
export function startPrivateAppCertificateRenewal(): void {
  if (runtime.__opensessionPrivateAppRenewal) return;
  void renewPrivateAppCertificate();
  runtime.__opensessionPrivateAppRenewal = setInterval(() => {
    void renewPrivateAppCertificate();
  }, DAY_MS);
}

/** "expires in N days" style summary for health output. */
export function privateAppCertificateHealth(now = Date.now()): Array<{
  domain: string;
  expiresAt: string;
  daysLeft: number | null;
  renewalError: string;
}> {
  const credential = safeCredential();
  if (!credential) return [];
  const state = readRenewalState();
  return privateAppCertificateDomains(credential).map((domain) => {
    const expiresAt = state[domain]?.expiresAt || certificateExpiry(domain);
    const time = expiresAt ? new Date(expiresAt).getTime() : NaN;
    return {
      domain,
      expiresAt,
      daysLeft: Number.isFinite(time)
        ? Math.floor((time - now) / DAY_MS)
        : null,
      renewalError: state[domain]?.error || "",
    };
  });
}
