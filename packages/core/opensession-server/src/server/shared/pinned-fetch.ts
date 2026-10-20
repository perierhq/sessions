/**
 * HTTP requests that dial only addresses already checked as public.
 *
 * Checking a URL and then handing it to `fetch` resolves the host twice: once
 * for the check and again for the connection. A DNS answer that changes in
 * between (DNS rebinding) moves the request to whatever the second answer
 * names, private addresses included. Here each request resolves its host once,
 * refuses it if any address is private, and connects through node:http(s) with
 * a `lookup` that answers only with those checked addresses. The Host header
 * and the TLS server name still name the original host, so virtual hosting
 * and certificate checks work as with a normal fetch.
 *
 * Connections are direct: HTTP_PROXY/HTTPS_PROXY are not consulted, because a
 * proxy would resolve the name again and undo the pin.
 */
import type { LookupAddress } from "dns";
import { lookup } from "dns/promises";
import type { ClientRequest, IncomingMessage } from "http";
import { request as httpRequest } from "http";
import type { RequestOptions } from "https";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import type { Transform } from "stream";
import {
  brotliDecompressSync,
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from "zlib";
import { isBlockedAddress } from "./network-address";

/** Names that only ever mean something private. */
const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|home\.arpa)$/i;

/** Resolve a hostname to every address it currently has. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveWithDns: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/** A refusal by address policy, as opposed to a network failure. */
export class BlockedAddressError extends Error {}

/** A URL whose host has been resolved and checked. `addresses` is the only
 *  set the connection may dial: the request never resolves the name again,
 *  so a DNS answer that changes between the check and the connect (DNS
 *  rebinding) cannot reach a private address. */
export interface FetchTarget {
  url: URL;
  /** Hostname without IPv6 brackets. Sent as Host and TLS servername. */
  host: string;
  addresses: string[];
}

/** Parse, resolve, and prove every resolved address is public. Throws
 *  otherwise. The returned addresses are the ones the request must dial. */
export async function resolvePinnedTarget(
  raw: string,
  deps: {
    resolve: ResolveHost;
    isBlocked: (address: string) => boolean;
  },
): Promise<FetchTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(
      `Only http and https are fetchable (got ${url.protocol})`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`No host in ${raw}`);
  // `localhost.` is `localhost`: test the name without its root dot.
  if (BLOCKED_NAMES.test(host.replace(/\.+$/, ""))) {
    throw new BlockedAddressError(`Refusing to fetch a private name: ${host}`);
  }
  const addresses = isIP(host) ? [host] : await deps.resolve(host);
  if (!addresses.length) throw new Error(`Could not resolve ${host}`);
  for (const address of addresses) {
    if (deps.isBlocked(address)) {
      throw new BlockedAddressError(
        `Refusing to fetch ${host}: it resolves to the private address ${address}`,
      );
    }
  }
  return { url, host, addresses };
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A `lookup` for node:http that answers only with already-checked
 *  addresses, re-checking each, and never consults DNS. */
export function pinnedLookup(
  target: Pick<FetchTarget, "host" | "addresses">,
  isBlocked: (address: string) => boolean,
) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: LookupCallback,
  ): void => {
    const fail = (message: string) =>
      callback(Object.assign(new Error(message), { code: "ENOTFOUND" }), "");
    const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (name !== target.host.toLowerCase())
      return fail(`Unexpected lookup for ${hostname}`);
    const blocked = target.addresses.find(isBlocked);
    if (blocked)
      return fail(`Refusing to connect to the private address ${blocked}`);
    const family =
      options?.family === "IPv4" || options?.family === 4
        ? 4
        : options?.family === "IPv6" || options?.family === 6
          ? 6
          : 0;
    const addresses = target.addresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((entry) => entry.family && (!family || entry.family === family));
    if (!addresses.length) return fail(`No checked address for ${hostname}`);
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}

/** Reject with the signal's reason as soon as it aborts. */
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const megabytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)}MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)}KB`
      : `${bytes} bytes`;

/** A body over the request's byte limit, before or after decoding. */
export class BodyTooLargeError extends Error {}

export const tooLarge = (url: URL, limit: number, bytes?: number) =>
  new BodyTooLargeError(
    bytes === undefined
      ? `${url} exceeded the ${megabytes(limit)} body limit`
      : `${url} is ${megabytes(bytes)}, over the ${megabytes(limit)} limit`,
  );

/** Undo a content-encoding without letting a small compressed body expand
 *  past `limit`. */
export function decodeBody(
  url: URL,
  encoding: string,
  body: Buffer,
  limit: number,
): Buffer {
  const options = { maxOutputLength: limit };
  try {
    switch (encoding.trim().toLowerCase()) {
      case "":
      case "identity":
        return body;
      case "gzip":
      case "x-gzip":
        return gunzipSync(body, options);
      case "deflate":
        // RFC 9110 deflate is zlib-wrapped, but some servers send a raw
        // deflate stream under the same name; browsers accept both.
        try {
          return inflateSync(body, options);
        } catch (error) {
          if ((error as { code?: string }).code !== "Z_DATA_ERROR") throw error;
          return inflateRawSync(body, options);
        }
      case "br":
        return brotliDecompressSync(body, options);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw tooLarge(url, limit);
    throw error;
  }
  throw new Error(`${url} used an unsupported content-encoding: ${encoding}`);
}

/** Decoders for a cut body: each flushes what it has at the end of its
 *  input instead of failing on the missing rest. Deflate tries zlib, then
 *  raw, as `decodeBody` does. */
function prefixDecoders(encoding: string): Array<() => Transform> | null {
  const sync = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return [() => createGunzip(sync)];
    case "deflate":
      return [() => createInflate(sync), () => createInflateRaw(sync)];
    case "br":
      return [
        () =>
          createBrotliDecompress({
            finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
          }),
      ];
  }
  return null;
}

/** Run one decoder until `limit` bytes are out or the input runs dry. It is
 *  stopped at the limit, so a small body cannot inflate past it. */
function inflatePrefix(
  decoder: Transform,
  body: Buffer,
  limit: number,
): Promise<{ bytes: Buffer; failed: boolean }> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      decoder.destroy();
      resolve({ bytes: Buffer.concat(out).subarray(0, limit), failed });
    };
    decoder.on("data", (chunk: Buffer) => {
      if (settled) return;
      out.push(chunk);
      size += chunk.length;
      if (size >= limit) finish(false);
    });
    decoder.on("error", () => finish(size === 0));
    decoder.on("end", () => finish(false));
    decoder.end(body);
  });
}

/**
 * The first `limit` bytes of a body that is cut short or decodes past the
 * limit: as much as its encoding gives up, possibly nothing. Null for an
 * encoding `decodeBody` does not take.
 */
export async function decodeBodyPrefix(
  encoding: string,
  body: Buffer,
  limit: number,
): Promise<Buffer | null> {
  const kind = encoding.trim().toLowerCase();
  if (kind === "" || kind === "identity") return body.subarray(0, limit);
  const decoders = prefixDecoders(kind);
  if (!decoders) return null;
  for (const make of decoders) {
    const { bytes, failed } = await inflatePrefix(make(), body, limit);
    if (!failed) return bytes;
  }
  return Buffer.alloc(0);
}

/** Encodings `decodeBody` undoes. */
function isDecodable(encoding: string): boolean {
  return ["", "identity", "gzip", "x-gzip", "deflate", "br"].includes(
    encoding.trim().toLowerCase(),
  );
}

type RequestFn = (
  options: RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => ClientRequest;

/** The node:http(s) `request` functions a pinned request uses. A seam for
 *  tests that need to see the options without a real TLS peer. */
export interface PinnedTransport {
  http: RequestFn;
  https: RequestFn;
}

export const nodeTransport: PinnedTransport = {
  http: httpRequest,
  https: httpsRequest,
};

export interface PinnedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Uint8Array;
  signal: AbortSignal;
  /** Largest body accepted, before and after decoding. */
  maxBodyBytes: number;
  /** What a longer body does: "reject" (the default) fails the request;
   *  "truncate" stops reading at `maxBodyBytes` and answers with what was
   *  read and `truncated` set, so the status is still known. A cut encoded
   *  body is decoded as far as it goes. A body in an encoding that cannot
   *  be decoded comes back raw, over the limit or not, with `undecodable`
   *  set. */
  overflow?: "reject" | "truncate";
}

export interface PinnedResponse {
  status: number;
  headers: Headers;
  /** Decoded body bytes; empty for a redirect, which is never read. */
  body: Uint8Array;
  /** Set when `overflow: "truncate"` cut the body short. */
  truncated?: boolean;
  /** Set when `overflow: "truncate"` could not decode the body: `body` is
   *  the raw bytes (or nothing, if decoding a cut body failed). */
  undecodable?: true;
}

/** One request over node:http(s), dialling only the target's checked
 *  addresses. A redirect is returned unread, never followed. */
export function pinnedHttpRequest(
  target: FetchTarget,
  init: PinnedRequestInit,
  isBlocked: (address: string) => boolean,
  transport: PinnedTransport = nodeTransport,
): Promise<PinnedResponse> {
  const { url, host } = target;
  const { signal, maxBodyBytes } = init;
  const truncate = init.overflow === "truncate";
  const secure = url.protocol === "https:";
  if (signal.aborted) return Promise.reject(signal.reason);
  const payload =
    init.body === undefined
      ? undefined
      : typeof init.body === "string" || init.body instanceof URLSearchParams
        ? Buffer.from(init.body.toString())
        : Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    let res: IncomingMessage | undefined;
    const onAbort = () => {
      res?.destroy();
      req.destroy();
      reject(signal.reason);
    };
    const done = () => signal.removeEventListener("abort", onAbort);
    const req = (secure ? transport.https : transport.http)(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: {
          ...init.headers,
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
        lookup: pinnedLookup(target, isBlocked),
        // SNI never carries an IP literal or the root dot.
        ...(secure && !isIP(host)
          ? { servername: host.replace(/\.$/, "") }
          : {}),
        // No pooled sockets: each request dials its own checked address.
        agent: false,
      },
      (response) => {
        res = response;
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value])
            headers.append(name, item);
        }
        if (status >= 300 && status < 400 && headers.get("location")) {
          done();
          res.destroy();
          return resolve({ status, headers, body: new Uint8Array() });
        }
        const declared = Number(headers.get("content-length"));
        if (!truncate && Number.isFinite(declared) && declared > maxBodyBytes) {
          done();
          res.destroy();
          return reject(tooLarge(url, maxBodyBytes, declared));
        }
        const chunks: Buffer[] = [];
        const encoding = headers.get("content-encoding") ?? "";
        let size = 0;
        let finished = false;
        /** Answer with the first decoded bytes of `raw`, marked cut. */
        const resolvePrefix = (raw: Buffer) =>
          decodeBodyPrefix(encoding, raw, maxBodyBytes).then(
            (body) =>
              resolve({
                status,
                headers,
                body: body ?? raw.subarray(0, maxBodyBytes),
                truncated: true,
                ...(body === null ? { undecodable: true as const } : {}),
              }),
            () =>
              resolve({
                status,
                headers,
                body: new Uint8Array(),
                truncated: true,
                undecodable: true,
              }),
          );
        const cutShort = () => {
          finished = true;
          done();
          res?.destroy();
          void resolvePrefix(Buffer.concat(chunks));
        };
        res.on("data", (chunk: Buffer) => {
          if (finished) return;
          if (size + chunk.length > maxBodyBytes) {
            if (truncate) {
              chunks.push(chunk.subarray(0, maxBodyBytes - size));
              size = maxBodyBytes;
              return cutShort();
            }
            finished = true;
            done();
            res?.destroy();
            reject(tooLarge(url, maxBodyBytes));
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on("error", (error) => {
          done();
          reject(error);
        });
        res.on("end", () => {
          done();
          if (finished) return;
          finished = true;
          const raw = Buffer.concat(chunks);
          // Undecodable but whole: the raw bytes, as over the limit.
          if (truncate && !isDecodable(encoding))
            return resolve({ status, headers, body: raw, undecodable: true });
          try {
            const body = decodeBody(url, encoding, raw, maxBodyBytes);
            resolve({ status, headers, body });
          } catch (error) {
            if (truncate && error instanceof BodyTooLargeError)
              return void resolvePrefix(raw);
            reject(error);
          }
        });
      },
    );
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => {
      done();
      reject(error);
    });
    req.end(payload);
  });
}

/** The seams of `pinnedFetch`. Production uses the defaults; tests swap
 *  `send` to answer without a network. */
export interface PinnedFetchDeps {
  resolve: ResolveHost;
  isBlocked: (address: string) => boolean;
  send: (
    target: FetchTarget,
    init: PinnedRequestInit,
    isBlocked: (address: string) => boolean,
  ) => Promise<PinnedResponse>;
}

const defaultDeps: PinnedFetchDeps = {
  resolve: resolveWithDns,
  isBlocked: isBlockedAddress,
  send: (target, init, isBlocked) => pinnedHttpRequest(target, init, isBlocked),
};

let testSend: PinnedFetchDeps["send"] | undefined;

/** Answer `pinnedFetch` requests from a test double instead of the network.
 *  Resolution and the address check still run. Pass undefined to restore. */
export function __setPinnedFetchSendForTest(
  send: PinnedFetchDeps["send"] | undefined,
): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("pinned fetch test seam used outside tests");
  testSend = send;
}

export const PINNED_FETCH_TIMEOUT_MS = 15_000;

/** Sent unless the caller sets its own: node:http adds no User-Agent or
 *  Accept, and some servers behind a firewall refuse requests without one. */
export const PINNED_FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; OpenSession/1.0; +https://github.com/perierhq/sessions)";

function withDefaultHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  const has = (name: string) =>
    Object.keys(out).some((key) => key.toLowerCase() === name);
  if (!has("user-agent")) out["user-agent"] = PINNED_FETCH_USER_AGENT;
  if (!has("accept")) out.accept = "*/*";
  return out;
}
const PINNED_FETCH_MAX_BODY_BYTES = 1024 * 1024;

export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Uint8Array;
  /** "error" (the default) refuses a redirect; "manual" returns it unread.
   *  A followed redirect would need its own check, and would carry a POST
   *  body (an authorization code, a refresh token) to wherever it pointed,
   *  so following is not offered. */
  redirect?: "error" | "manual";
  /** Covers DNS, the connection and the body. Defaults to 15 seconds. */
  signal?: AbortSignal;
  maxBodyBytes?: number;
}

/**
 * `fetch` for a URL that must not reach a private address: resolve, check
 * every address, and connect only to those, in one step at request time.
 * The body is read in full (up to `maxBodyBytes`, default 1MB) before the
 * Response is returned.
 */
export async function pinnedFetch(
  raw: string | URL,
  init: PinnedFetchInit = {},
  deps: PinnedFetchDeps = defaultDeps,
): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(PINNED_FETCH_TIMEOUT_MS);
  const target = await untilAborted(
    resolvePinnedTarget(String(raw), deps),
    signal,
  );
  const send = deps === defaultDeps && testSend ? testSend : deps.send;
  const response = await untilAborted(
    send(
      target,
      {
        method: init.method,
        headers: withDefaultHeaders(init.headers),
        body: init.body,
        signal,
        maxBodyBytes: init.maxBodyBytes ?? PINNED_FETCH_MAX_BODY_BYTES,
      },
      deps.isBlocked,
    ),
    signal,
  );
  const { status } = response;
  // The body is already decoded and fully read.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  if (
    status >= 300 &&
    status < 400 &&
    headers.has("location") &&
    (init.redirect ?? "error") === "error"
  )
    throw new TypeError(
      `Refusing to follow a redirect (HTTP ${status}) from ${target.url.origin}`,
    );
  if (status < 200 || status > 599)
    throw new TypeError(
      `Unexpected HTTP status ${status} from ${target.url.origin}`,
    );
  const nullBody = [204, 205, 304].includes(status);
  return new Response(nullBody ? null : new Uint8Array(response.body), {
    status,
    headers,
  });
}
