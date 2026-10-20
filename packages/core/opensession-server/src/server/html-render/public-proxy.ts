/**
 * A loopback SOCKS5 proxy that only connects to public addresses. The
 * headless browser that previews agent HTML sends every connection through
 * it, so a page can load a chart library from a CDN but never reach this
 * machine, its private networks, or a cloud metadata endpoint. It carries
 * bytes only, so HTTP, TLS and WebSockets pass through unchanged, and it
 * connects to the addresses it checked, so DNS rebinding changes nothing.
 *
 * Started per preview by `startPublicProxy` and closed with it; nothing here
 * binds at import time.
 */

import { lookup } from "node:dns/promises";
import {
  BlockList,
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import { networkInterfaces } from "node:os";
import { embeddedIpv4, isBlockedAddress } from "../shared/network-address";

function ownAddresses(): BlockList {
  const own = new BlockList();
  for (const entry of Object.values(networkInterfaces()).flat())
    if (entry)
      own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  return own;
}

/** This machine or a local network, including a public address one of its
 *  own interfaces holds. The ranges are the shared private-address list
 *  (`isBlockedAddress`, which also judges IPv4 carried inside IPv6); this
 *  adds only the machine's own interface addresses, embedded forms
 *  included. */
export function isLocalAddress(address: string, family: number): boolean {
  if (isBlockedAddress(address)) return true;
  const own = ownAddresses();
  if (own.check(address, family === 6 ? "ipv6" : "ipv4")) return true;
  const embedded = family === 6 ? embeddedIpv4(address) : undefined;
  return embedded !== undefined && own.check(embedded, "ipv4");
}

async function publicAddresses(
  host: string,
): Promise<Array<{ address: string; family: number }> | undefined> {
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  return addresses.some(({ address, family }) =>
    isLocalAddress(address, family),
  )
    ? undefined
    : addresses;
}

// SOCKS5 replies: success, refused by rule, unsupported command.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
const MAX_EARLY_BYTES = 64 * 1024;

function readRequest(data: Buffer) {
  if (data.length < 5) return "short" as const;
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end =
    type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, i) =>
            data.readUInt16BE(4 + i * 2).toString(16),
          ).join(":");
  return {
    command: data[1],
    host,
    port: data.readUInt16BE(end - 2),
    rest: data.subarray(end),
  };
}

export interface PublicProxy {
  port: number;
  close(): Promise<void>;
}

export function startPublicProxy(): Promise<PublicProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const refuse = (client: Socket, code: number) =>
    client.end(reply(code), () => client.destroy());
  const server: Server = createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0))
          return void client.end(Buffer.from([5, 0xff]));
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (!request || request.command !== 1 || request.port === 0)
        return refuse(client, 7);
      const early: Buffer[] = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (chunk: Buffer) => {
        earlyBytes += chunk.length;
        if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
        early.push(chunk);
      };
      client.on("data", holdEarly);
      void publicAddresses(request.host).then((addresses) => {
        if (client.destroyed) return;
        client.off("data", holdEarly);
        if (!addresses) return refuse(client, 2);
        client.pause();
        const upstream = track(
          connect({
            host: request.host,
            port: request.port,
            autoSelectFamily: true,
            lookup: (_host, options, callback) =>
              options.all
                ? (callback as (e: null, a: typeof addresses) => void)(
                    null,
                    addresses,
                  )
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          }),
        );
        upstream.once("connect", () => {
          client.write(reply(0));
          for (const chunk of early) upstream.write(chunk);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
        });
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    let listening = false;
    server.on("error", (error) => {
      if (!listening) reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
