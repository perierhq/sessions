/**
 * A `pinnedFetch` test double: resolution and the address check still run
 * for real (against whatever `dns.lookup` the test stubs), then the request
 * is answered by `globalThis.fetch`, so a test can keep stubbing fetch by
 * URL. Every request records the addresses it was pinned to.
 */
import {
  __setPinnedFetchSendForTest,
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
