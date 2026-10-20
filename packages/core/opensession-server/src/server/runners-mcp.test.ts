import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerWsClose, runnerWsMessage, runnerWsOpen } from "./runner-ws";
import {
  createRunnerPairing,
  listRunners,
  registerRunner,
  removeRunner,
  reserveRunnerForIncidents,
} from "./runners";
import { createRunnersMcpServer } from "./runners-mcp";

const HOME = mkdtempSync(join(tmpdir(), "os-runners-mcp-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

function pair(name: string): string {
  const { code } = createRunnerPairing("Ada");
  const out = registerRunner({
    code,
    name,
    platform: "linux",
    arch: "x64",
    address: "100.101.102.110",
  });
  if (!out.ok) throw new Error(out.error);
  return out.runner.id;
}

/** A connected Runner that records every frame it is sent. */
function attach(id: string): { sent: any[]; close: () => void } {
  const sent: any[] = [];
  const ws = {
    data: { kind: "runner", runnerId: id },
    close() {},
    send(frame: string) {
      sent.push(JSON.parse(frame));
    },
  };
  runnerWsOpen(ws);
  runnerWsMessage(
    ws,
    JSON.stringify({ t: "hello", version: 1, execStdin: true }),
  );
  return { sent, close: () => runnerWsClose(ws) };
}

async function connect() {
  const server = createRunnersMcpServer({
    user: "Ada",
    sessionId: "sess-agent",
    repo: () => "acme",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("opensession-runners and production Runners", () => {
  test("an agent session in the project cannot use a reserved Runner", async () => {
    const prod = pair("prod-1");
    reserveRunnerForIncidents(prod, { repos: ["acme"] });
    const lab = pair("lab-1");
    const channel = attach(prod);
    try {
      const client = await connect();
      const listed = textOf(
        await client.callTool({ name: "list_runners", arguments: {} }),
      );
      expect(listed).toContain("lab-1");
      expect(listed).not.toContain("prod-1");
      for (const runner of ["prod-1", prod]) {
        const ran = textOf(
          await client.callTool({
            name: "run_on_runner",
            arguments: { runner, command: "cat /etc/passwd" },
          }),
        );
        expect(ran).toBe("prod-1 is reserved for incident response.");
      }
      expect(
        textOf(
          await client.callTool({
            name: "runner_status",
            arguments: { runner: "prod-1" },
          }),
        ),
      ).toBe("prod-1 is reserved for incident response.");
      expect(
        textOf(
          await client.callTool({
            name: "reserve_runner",
            arguments: { runner: "prod-1", reason: "build" },
          }),
        ),
      ).toBe("prod-1 is reserved for incident response.");
      expect(channel.sent.filter((f) => f.t === "exec")).toEqual([]);
      expect(lab).toBeString();
    } finally {
      channel.close();
    }
  });
});
