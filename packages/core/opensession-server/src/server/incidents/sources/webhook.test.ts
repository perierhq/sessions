import { expect, test } from "bun:test";
import type { Signal } from "../../../shared/incidents";
import { runSignalSource } from "./index";
import { webhookObservations } from "./webhook";

const AT = "2026-10-20T10:00:00.000Z";

test("without a mapping every event is a failure", () => {
  expect(
    webhookObservations({ kind: "webhook" }, "Error: boom\n  at x", AT)
      .observations,
  ).toEqual([{ at: AT, result: "fail", detail: "Error: boom" }]);
  expect(
    webhookObservations({ kind: "webhook" }, "", AT).observations[0].detail,
  ).toBe("Webhook received");
});

test("a mapping can report recovery", () => {
  const source = {
    kind: "webhook" as const,
    mapping: {
      result: { path: "$.status", ok: ["resolved"], fail: ["firing"] },
      detail: "$.title",
    },
  };
  expect(
    webhookObservations(
      source,
      JSON.stringify({ status: "resolved", title: "Error rate" }),
      AT,
    ).observations[0],
  ).toMatchObject({ result: "ok", detail: "Error rate" });
  expect(
    webhookObservations(
      source,
      JSON.stringify({ status: "firing", title: "Error rate" }),
      AT,
    ).observations[0].result,
  ).toBe("fail");
  expect(
    webhookObservations(source, "<html>", AT).observations[0],
  ).toMatchObject({ result: "fail", detail: "<html>" });
});

test("dispatcher: pushed sources produce nothing when polled", async () => {
  const s = { id: "sig-a", source: { kind: "heartbeat" } } as Signal;
  expect(await runSignalSource(s)).toEqual({ observations: [] });
});
