/**
 * A `pinnedFetch` test double: resolution and the address check still run
 * for real (against whatever `dns.lookup` the test stubs), then the request
 * is answered by `globalThis.fetch`, so a test can keep stubbing fetch by
 * URL. Every request records the addresses it was pinned to.
 */
import {
  __setPinnedFetchSendForTest,
  isDecodableEncoding,
  type PinnedFetchDeps,
} from "../shared/pinned-fetch";

export interface PinnedCall {
  url: string;
  method: string;
  addresses: string[];
}

export function installPinnedFetchDouble(): {
  calls: PinnedCall[];
  restore: () => void;
} {
  const calls: PinnedCall[] = [];
  const send: PinnedFetchDeps["send"] = async (target, init) => {
    calls.push({
      url: target.url.href,
      method: init.method ?? "GET",
      addresses: [...target.addresses],
    });
    const response = await globalThis.fetch(target.url.href, {
      method: init.method,
      headers: init.headers,
      body:
        init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body,
      signal: init.signal,
      redirect: "manual",
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  __setPinnedFetchSendForTest(send);
  return { calls, restore: () => __setPinnedFetchSendForTest(undefined) };
}

/** A public address from a documentation range: not blocked, never dialled. */
export const TEST_PUBLIC_ADDRESS = "203.0.113.10";

/**
 * Pinned-fetch seams for code that takes them (`net`): every name resolves
 * to `addresses` and the address check runs for real, then `fetchImpl`
 * answers the request in place of the network. Like the real transport, a
 * redirect comes back unread, a body over `maxBodyBytes` is cut short when
 * the caller asked for `overflow: "truncate"`, and with `overflow:
 * "truncate"` a body in an encoding the transport can't decode comes back
 * raw and marked `undecodable`.
 */
export function fetchBackedNet(
  fetchImpl: (url: URL, init: RequestInit) => Promise<Response>,
  addresses: string[] = [TEST_PUBLIC_ADDRESS],
): Partial<PinnedFetchDeps> {
  return {
    resolve: async () => [...addresses],
    send: async (target, init) => {
      const response = await fetchImpl(new URL(target.url.href), {
        method: init.method,
        headers: init.headers,
        body:
          init.body instanceof Uint8Array
            ? new Uint8Array(init.body)
            : init.body,
        signal: init.signal,
        redirect: "manual",
      });
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.length > init.maxBodyBytes) {
        if (init.overflow !== "truncate")
          throw new Error(`${target.url} is over the body limit`);
        return {
          status: response.status,
          headers: response.headers,
          body: body.subarray(0, init.maxBodyBytes),
          truncated: true,
        };
      }
      const encoding = response.headers.get("content-encoding") ?? "";
      if (init.overflow === "truncate" && !isDecodableEncoding(encoding))
        return {
          status: response.status,
          headers: response.headers,
          body,
          undecodable: true,
        };
      return { status: response.status, headers: response.headers, body };
    },
  };
}
