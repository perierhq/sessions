// An error already logged with its stack where it happened is logged by
// later catchers as its message only, so one failure is one stack trace in
// the journal.
import { expect, test } from "bun:test";
import { alreadyReported, logDetail, reported } from "./reported-errors";

test("a reported error logs as its message; any other error logs whole", () => {
  const plain = new Error("Sandbox unavailable: acme is down");
  expect(alreadyReported(plain)).toBe(false);
  expect(logDetail(plain)).toBe(plain);
  const marked = reported(new Error("Sandbox unavailable: acme is down"));
  expect(alreadyReported(marked)).toBe(true);
  expect(logDetail(marked)).toBe("Sandbox unavailable: acme is down");
  expect(logDetail("text")).toBe("text");
});
