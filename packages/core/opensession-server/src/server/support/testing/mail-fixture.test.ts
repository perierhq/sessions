import { expect, test } from "bun:test";
import { connect } from "node:net";
import { startMailFixture } from "./mail-fixture";

test("close() doesn't wait on an SMTP client that keeps its connection open", async () => {
  const fixture = await startMailFixture();
  const socket = connect(fixture.smtpPort, "127.0.0.1");
  // Wait for the greeting: the server holds the connection from here on.
  await new Promise<void>((resolve) => socket.once("data", () => resolve()));
  const started = performance.now();
  await fixture.close();
  expect(performance.now() - started).toBeLessThan(2_000);
  socket.destroy();
});
