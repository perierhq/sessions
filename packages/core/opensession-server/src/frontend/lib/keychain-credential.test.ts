import { expect, test } from "bun:test";
import {
  credentialForm,
  credentialSpec,
  expiryNote,
  formChanged,
  testOutcome,
} from "./keychain-credential";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

test("expiry reads as days left, today, or expired", () => {
  expect(expiryNote(undefined, NOW)).toBeNull();
  expect(expiryNote("2026-11-07", NOW)).toEqual({
    text: "Expires in 10 days",
    expired: false,
  });
  expect(expiryNote("2026-10-29", NOW)).toEqual({
    text: "Expires tomorrow",
    expired: false,
  });
  expect(expiryNote("2026-10-28", NOW)).toEqual({
    text: "Expires today",
    expired: false,
  });
  expect(expiryNote("2026-10-27", NOW)).toEqual({
    text: "Expired on 2026-10-27",
    expired: true,
  });
  expect(expiryNote("2026-10-28", NOW + DAY)?.expired).toBe(true);
});

test("an edit form starts from the credential and sends every field", () => {
  const form = credentialForm({
    id: "kc-1",
    owner: "Alex",
    service: "acme-api",
    host: "api.example.test",
    description: "Orders",
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/v1/orders", "/v1/items"],
    statusOnly: true,
    scope: "workspace",
    expiresOn: "2027-01-01",
    testPath: "/v1/orders",
    createdAt: "",
    updatedAt: "",
  });
  expect(form).toMatchObject({
    service: "acme-api",
    prefixes: "/v1/orders, /v1/items",
    methods: ["GET"],
    workspace: true,
  });
  expect(formChanged(form, form)).toBe(false);
  const cleared = {
    ...form,
    description: "",
    methods: [],
    prefixes: "",
    statusOnly: false,
    workspace: false,
    expiresOn: "",
    testPath: "",
  };
  expect(formChanged(form, cleared)).toBe(true);
  // Cleared fields are sent as clears, so an edit can remove a limit.
  expect(credentialSpec(cleared)).toEqual({
    service: "acme-api",
    host: "api.example.test",
    description: "",
    injection: {},
    allowedMethods: [],
    allowedPathPrefixes: [],
    statusOnly: false,
    scope: "personal",
    expiresOn: null,
    testPath: null,
  });
});

test("a test result says what came back, never more", () => {
  expect(testOutcome({ status: 200, reason: "OK" }, "/v1/me")).toEqual({
    text: "GET /v1/me answered 200 OK",
    tone: "success",
  });
  expect(
    testOutcome({ status: 401, reason: "Unauthorized" }, "/v1/me"),
  ).toEqual({
    text: "GET /v1/me answered 401 Unauthorized. Check the secret and the header",
    tone: "warning",
  });
  expect(testOutcome({ status: 404, reason: "Not Found" }, "/")).toEqual({
    text: "GET / answered 404 Not Found",
    tone: "warning",
  });
  expect(testOutcome({ error: "the request timed out" }, "/")).toEqual({
    text: "The request timed out",
    tone: "danger",
  });
});
