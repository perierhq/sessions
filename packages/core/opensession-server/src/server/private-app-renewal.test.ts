import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { X509Certificate } from "crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  privateAppCaddySite,
  privateAppCertificateDomains,
  privateAppCertificateHealth,
  privateAppDomainStatus,
  renewPrivateAppCertificate,
  upsertPrivateAppCaddy,
} from "./private-app-domain";
import { NEW_CERT, OLD_CERT } from "./private-app-renewal.fixtures";

/**
 * Renewal of private app certificates with lego, sudo and the Caddy admin API
 * replaced by stubs. The regression: lego renewed its own copy, the install
 * into Caddy failed, and because lego then reported "unchanged" every day the
 * install was never retried while Caddy served the old certificate.
 */

const DOMAIN = "os.example.test";
const SECOND = "os2.example.test";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_STATE_DIR",
  "OPENSESSION_TLS_DIR",
  "OPENSESSION_CADDYFILE",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

interface AdminRequest {
  method: string;
  path: string;
  cacheControl: string | null;
}
let admin: ReturnType<typeof Bun.serve>;
let adminRequests: AdminRequest[] = [];
let adminFails = false;
let root: string;
let scratch: string;
let which: ReturnType<typeof spyOn<typeof Bun, "which">>;
let logs: string[] = [];
const consoleSpies: Array<{ mockRestore(): void }> = [];

beforeAll(async () => {
  admin = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      adminRequests.push({
        method: request.method,
        path,
        cacheControl: request.headers.get("cache-control"),
      });
      if (adminFails) return new Response("down", { status: 500 });
      if (path === "/config/apps/tls" && request.method === "GET")
        return Response.json({ certificates: { load_files: [] } });
      if (path === "/config/apps/tls" && request.method === "PATCH")
        return new Response(null, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  root = await mkdtemp(join(tmpdir(), "private-app-renewal-config-"));
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ repos: {}, server: { caddyAdmin: admin.url.href } }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  await getConfigAsync();
});

afterAll(async () => {
  admin.stop(true);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(root, { recursive: true, force: true });
});

const paths = () => ({
  state: join(scratch, "state"),
  acme: join(scratch, "state", ".opensession-private-app-acme", "certificates"),
  tls: join(scratch, "tls"),
  bin: join(scratch, "bin"),
  calls: join(scratch, "calls"),
  caddyfile: join(scratch, "Caddyfile"),
});

async function stub(name: string, body: string) {
  const file = join(paths().bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "private-app-renewal-"));
  const p = paths();
  await mkdir(p.acme, { recursive: true });
  await mkdir(p.tls, { recursive: true });
  await mkdir(p.bin, { recursive: true });
  process.env.OPENSESSION_STATE_DIR = p.state;
  process.env.OPENSESSION_TLS_DIR = p.tls;
  process.env.OPENSESSION_CADDYFILE = p.caddyfile;
  // lego: `renew` copies a staged certificate (if any) into its state.
  await stub(
    "lego",
    `printf 'lego %s\\n' "$*" >> '${p.calls}'
case "$*" in --version) echo 'lego version 4.26.0 linux/amd64'; exit 0;; esac
domain=""; prev=""
for arg in "$@"; do [ "$prev" = "--domains" ] && domain="$arg"; prev="$arg"; done
if [ -f '${scratch}/next-'"$domain"'.crt' ]; then
  mv '${scratch}/next-'"$domain"'.crt' '${p.acme}/'"$domain"'.crt'
fi
exit 0`,
  );
  // sudo: run as the test user; drop install's owner/group flags.
  await stub(
    "sudo",
    `[ "$1" = "-n" ] && shift
printf 'sudo %s\\n' "$*" >> '${p.calls}'
case "$1" in
  install) shift; args=""
    while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args="$args $1"; shift;; esac; done
    exec install $args;;
  systemctl) exit 0;;
  # Root reads files the service user cannot.
  cat) [ -r "$2" ] && exec cat "$2"
    chmod u+r "$2"; cat "$2"; status=$?; chmod u-r "$2"; exit $status;;
  *) exec "$@";;
esac`,
  );
  await stub("id", "echo caddy");
  Object.defineProperty(process, "platform", { value: "linux" });
  which = spyOn(Bun, "which").mockImplementation((name) =>
    ["lego", "sudo", "id"].includes(name)
      ? join(paths().bin, name)
      : `/synthetic/${name}`,
  );
  adminRequests = [];
  adminFails = false;
  logs = [];
  for (const method of ["log", "warn", "error"] as const)
    consoleSpies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
});

afterEach(async () => {
  which.mockRestore();
  while (consoleSpies.length) consoleSpies.pop()!.mockRestore();
  Object.defineProperty(process, "platform", platform);
  await rm(scratch, { recursive: true, force: true });
});

async function configure(options: {
  domains?: string[];
  lego: Record<string, string>;
  installed?: Record<string, string>;
  caddyfile?: string;
}) {
  const p = paths();
  await writeFile(
    join(p.state, ".opensession-private-app-dns.json"),
    JSON.stringify({
      version: 1,
      provider: "cloudflare",
      domain: DOMAIN,
      email: "acme@example.test",
      apiToken: "synthetic-token",
      ...(options.domains ? { domains: options.domains } : {}),
    }),
    { mode: 0o600 },
  );
  for (const [domain, pem] of Object.entries(options.lego)) {
    await writeFile(join(p.acme, `${domain}.crt`), pem);
    await writeFile(join(p.acme, `${domain}.key`), `synthetic key ${domain}`);
  }
  for (const [domain, pem] of Object.entries(options.installed || {})) {
    await writeFile(join(p.tls, `${domain}.crt`), pem);
    await writeFile(join(p.tls, `${domain}.key`), "synthetic old key");
  }
  await writeFile(
    p.caddyfile,
    options.caddyfile ?? unmarkedSite(DOMAIN, p.tls),
  );
}

function unmarkedSite(domain: string, tls: string): string {
  return `${domain} {\n\tbind 100.64.0.10\n\ttls ${tls}/${domain}.crt ${tls}/${domain}.key\n\treverse_proxy 100.64.0.10:3850\n}\n`;
}

const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;
const installed = async (domain: string) =>
  readFile(join(paths().tls, `${domain}.crt`), "utf8");
const patches = () =>
  adminRequests.filter(
    (request) =>
      request.method === "PATCH" && request.path === "/config/apps/tls",
  );
const renewalState = async () =>
  JSON.parse(
    await readFile(
      join(paths().state, ".opensession-private-app-renewal.json"),
      "utf8",
    ),
  ).domains;
const noServedProbe = { servedCertificate: async () => null };

describe("private app certificate renewal", () => {
  test("installs lego's renewed certificate even when lego reports no change, into an unmarked site", async () => {
    // lego renewed on an earlier day; the install never reached Caddy.
    await configure({
      lego: { [DOMAIN]: NEW_CERT },
      installed: { [DOMAIN]: OLD_CERT },
    });
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(true);
    expect(fingerprint(await installed(DOMAIN))).toBe(fingerprint(NEW_CERT));
    expect(await readFile(join(paths().tls, `${DOMAIN}.key`), "utf8")).toBe(
      `synthetic key ${DOMAIN}`,
    );
    // The Caddyfile is not taken over; Caddy re-reads the files in place,
    // keeping runtime Portal servers.
    expect(await readFile(paths().caddyfile, "utf8")).toBe(
      unmarkedSite(DOMAIN, paths().tls),
    );
    expect(patches()).toEqual([
      {
        method: "PATCH",
        path: "/config/apps/tls",
        cacheControl: "must-revalidate",
      },
    ]);
    expect(await readFile(paths().calls, "utf8")).not.toContain("systemctl");
    expect(logs.join("\n")).toContain("without the");
    const state = await renewalState();
    expect(state[DOMAIN].error).toBeUndefined();
    expect(state[DOMAIN].expiresAt).toBe(
      new Date(new X509Certificate(NEW_CERT).validTo).toISOString(),
    );
  });

  test("does nothing when Caddy already has lego's certificate", async () => {
    await configure({
      lego: { [DOMAIN]: NEW_CERT },
      installed: { [DOMAIN]: NEW_CERT },
    });
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(true);
    expect(adminRequests).toEqual([]);
    expect(await readFile(paths().calls, "utf8")).not.toContain("sudo");
  });

  test.skipIf(process.getuid?.() === 0)(
    "does nothing when the installed certificate is readable only through sudo",
    async () => {
      // The TLS directory is root:caddy 0750: the service user cannot read
      // the installed file, which read as "missing" and reinstalled it and
      // reloaded Caddy on every check.
      await configure({
        lego: { [DOMAIN]: NEW_CERT },
        installed: { [DOMAIN]: NEW_CERT },
      });
      await chmod(join(paths().tls, `${DOMAIN}.crt`), 0o200);
      const current = {
        servedCertificate: async () => new X509Certificate(NEW_CERT),
      };
      expect(await renewPrivateAppCertificate(current)).toBe(true);
      expect(patches()).toEqual([]);
      expect(await readFile(paths().calls, "utf8")).not.toContain(
        "sudo install",
      );
    },
  );

  test("never replaces a certificate with one that expires sooner", async () => {
    await configure({
      lego: { [DOMAIN]: OLD_CERT },
      installed: { [DOMAIN]: NEW_CERT },
    });
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(true);
    expect(fingerprint(await installed(DOMAIN))).toBe(fingerprint(NEW_CERT));
    expect(adminRequests).toEqual([]);
  });

  test("reloads when the file is current but Caddy still serves the old certificate, and keeps retrying", async () => {
    await configure({
      lego: { [DOMAIN]: NEW_CERT },
      installed: { [DOMAIN]: NEW_CERT },
    });
    const stale = {
      servedCertificate: async () => new X509Certificate(OLD_CERT),
    };
    expect(await renewPrivateAppCertificate(stale)).toBe(false);
    expect(patches()).toHaveLength(1);
    expect((await renewalState())[DOMAIN].error).toContain(
      "Caddy still serves the certificate that expires",
    );
    // The next daily check tries again instead of trusting lego's "unchanged".
    expect(await renewPrivateAppCertificate(stale)).toBe(false);
    expect(patches()).toHaveLength(2);
    let served = OLD_CERT;
    const recovering = {
      servedCertificate: async () => {
        const certificate = new X509Certificate(served);
        served = NEW_CERT; // the reload took
        return certificate;
      },
    };
    expect(await renewPrivateAppCertificate(recovering)).toBe(true);
    expect((await renewalState())[DOMAIN].error).toBeUndefined();
  });

  test("falls back to systemctl when the Caddy admin API refuses", async () => {
    adminFails = true;
    await configure({
      lego: { [DOMAIN]: NEW_CERT },
      installed: { [DOMAIN]: OLD_CERT },
    });
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(true);
    expect(await readFile(paths().calls, "utf8")).toContain(
      "sudo systemctl reload caddy",
    );
    expect(logs.join("\n")).toContain("reloaded Caddy with systemctl");
  });

  test("renews every configured domain and records failures per domain", async () => {
    const p = paths();
    await configure({
      domains: [SECOND, "os3.example.test"],
      lego: { [DOMAIN]: OLD_CERT, [SECOND]: OLD_CERT },
      installed: { [DOMAIN]: OLD_CERT, [SECOND]: OLD_CERT },
      caddyfile:
        unmarkedSite(DOMAIN, p.tls) + "\n" + unmarkedSite(SECOND, p.tls),
    });
    // lego renews the second domain during this check.
    await writeFile(join(scratch, `next-${SECOND}.crt`), NEW_CERT);
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(false);
    const calls = await readFile(p.calls, "utf8");
    expect(calls).toContain(`--domains ${DOMAIN} renew --days 30`);
    expect(calls).toContain(`--domains ${SECOND} renew --days 30`);
    expect(fingerprint(await installed(DOMAIN))).toBe(fingerprint(OLD_CERT));
    expect(fingerprint(await installed(SECOND))).toBe(fingerprint(NEW_CERT));
    const state = await renewalState();
    expect(state[DOMAIN].error).toBeUndefined();
    expect(state[SECOND].error).toBeUndefined();
    expect(state["os3.example.test"].error).toContain(
      "lego has no certificate",
    );

    const status = await privateAppDomainStatus(`https://${DOMAIN}`, null);
    expect(status.certificates.map((entry) => entry.domain)).toEqual([
      DOMAIN,
      SECOND,
      "os3.example.test",
    ]);
    expect(status.certificates[2].renewalError).toContain(
      "lego has no certificate",
    );
    const health = privateAppCertificateHealth(
      new Date(new X509Certificate(NEW_CERT).validTo).getTime() -
        3 * 86_400_000,
    );
    expect(health[1]).toMatchObject({ domain: SECOND, daysLeft: 3 });
    expect(health[2].renewalError).toContain("lego has no certificate");
  });

  test("records a failure that stops every domain", async () => {
    await configure({ domains: [SECOND], lego: { [DOMAIN]: NEW_CERT } });
    await stub("lego", "echo 'lego version 5.0.0 linux/amd64'; exit 0");
    expect(await renewPrivateAppCertificate(noServedProbe)).toBe(false);
    const state = await renewalState();
    expect(state[DOMAIN].error).toContain("lego 4.x");
    expect(state[SECOND].error).toContain("lego 4.x");
  });
});

describe("private app Caddy sites", () => {
  test("finds the site for a domain and whether it is managed", () => {
    const tls = paths().tls;
    const source = `os.example.test {\n    # BEGIN OPENSESSION PRIVATE APP\n    tls ${tls}/os.example.test.crt ${tls}/os.example.test.key\n    # END OPENSESSION PRIVATE APP\n}\n\nhttps://os2.example.test:443 {\n    tls /other.crt /other.key\n}\n`;
    expect(privateAppCaddySite(source, "os.example.test")).toEqual({
      managed: true,
      usesCertificate: true,
    });
    expect(privateAppCaddySite(source, "os2.example.test")).toEqual({
      managed: false,
      usesCertificate: false,
    });
    expect(privateAppCaddySite(source, "os3.example.test")).toBeNull();
  });

  test("with several marked sites, updates the one for the domain", () => {
    const marked = (domain: string) =>
      `${domain} {\n    # BEGIN OPENSESSION PRIVATE APP\n    bind 100.64.0.10\n    # END OPENSESSION PRIVATE APP\n}\n`;
    const source = `${marked("os2.example.test")}\n${marked("os.example.test")}`;
    const next = upsertPrivateAppCaddy(
      source,
      "os.example.test",
      "100.64.0.20",
    );
    expect(next.match(/^os\.example\.test \{/gm)).toHaveLength(1);
    expect(next.match(/^os2\.example\.test \{/gm)).toHaveLength(1);
    expect(next.split("os.example.test {")[1]).toContain("bind 100.64.0.20");
    expect(next.split("os.example.test {")[0]).toContain("bind 100.64.0.10");
  });

  test("never renames a marked site onto a name another site already has", () => {
    const source =
      "os2.example.test {\n    # BEGIN OPENSESSION PRIVATE APP\n    bind 100.64.0.10\n    # END OPENSESSION PRIVATE APP\n}\n\nos.example.test {\n    respond ok\n}\n";
    expect(() =>
      upsertPrivateAppCaddy(source, "os.example.test", "100.64.0.10"),
    ).toThrow("unmanaged Caddy site");
  });

  test("lists the primary domain first, without duplicates", () => {
    expect(
      privateAppCertificateDomains({
        domain: "os.example.test",
        domains: ["OS2.example.test", "os.example.test"],
      }),
    ).toEqual(["os.example.test", "os2.example.test"]);
  });
});
