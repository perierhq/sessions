import { expect, test } from "bun:test";
import {
  canLend,
  credentialForm,
  credentialSpec,
  editEffect,
  expiryNote,
  formChanged,
  injectionPreview,
  lendingRoles,
  serviceIdError,
  serviceSlug,
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
    name: "",
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

test("an edit that widens the limits names how, and counts approved grants", () => {
  const before = credentialForm({
    id: "kc-1",
    owner: "Alex",
    service: "acme-api",
    host: "api.example.test",
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/v1"],
    createdAt: "",
    updatedAt: "",
  });
  expect(editEffect(before, before, [])).toBeNull();
  const wider = { ...before, methods: [], prefixes: "/v1/, /v2" };
  const grants = [
    { status: "active", mode: "standing" },
    { status: "active", mode: "workspace", implicit: true },
    { status: "active", mode: "standing", incident: { incidentId: "i" } },
    { status: "used", mode: "once" },
    { status: "active", mode: "once" },
  ] as const;
  expect(editEffect(before, wider, grants)).toEqual({
    kind: "widened",
    text: "Saving widens the limits: any method is allowed; paths now include /v2. 2 grants approved under the old limits pause until you allow them again",
  });
  // Narrower: nothing to say.
  expect(
    editEffect(before, { ...before, prefixes: "/v1/orders" }, grants),
  ).toBeNull();
  // Wider with nobody holding a grant: nothing pauses.
  expect(editEffect(before, wider, [])).toBeNull();
  expect(
    editEffect(before, { ...before, host: "api2.example.test" }, grants),
  ).toEqual({
    kind: "moved",
    text: "Saving moves it to a new host, so its 4 active grants end",
  });
});

test("only your own credentials and workspace ones can be lent, never a login", () => {
  const base = {
    id: "kc",
    owner: "Alex",
    service: "acme",
    host: "api.example.test",
    createdAt: "",
    updatedAt: "",
  };
  expect(canLend({ ...base, mine: true })).toBe(true);
  expect(canLend({ ...base, mine: false, scope: "workspace" })).toBe(true);
  expect(canLend({ ...base, mine: false })).toBe(false);
  expect(canLend({ ...base, mine: true, kind: "login" })).toBe(false);
});

test("a lending says which roles, and how", () => {
  expect(lendingRoles({ investigator: "standing", verifier: "once" })).toBe(
    "investigator always, verifier ask once",
  );
});

test("header and scheme: defaults are sent as nothing, the rest as set", () => {
  const form = credentialForm();
  expect(form).toMatchObject({ header: "", scheme: "Bearer" });
  expect(credentialSpec(form).injection).toEqual({});
  expect(
    credentialSpec({ ...form, header: "authorization", scheme: "Bearer" })
      .injection,
  ).toEqual({});
  expect(credentialSpec({ ...form, scheme: "Basic" }).injection).toEqual({
    header: "Authorization",
    scheme: "Basic",
  });
  expect(credentialSpec({ ...form, scheme: "" }).injection).toEqual({
    header: "Authorization",
    scheme: "",
  });
  expect(
    credentialSpec({ ...form, header: "X-Api-Key", scheme: "" }).injection,
  ).toEqual({ header: "X-Api-Key" });
  expect(
    credentialSpec({ ...form, header: "X-Api-Key", scheme: "Token" }).injection,
  ).toEqual({ header: "X-Api-Key", scheme: "Token" });
});

test("an edit opens with the stored header and scheme", () => {
  const base = {
    id: "kc",
    owner: "Alex",
    service: "acme",
    host: "api.example.test",
    createdAt: "",
    updatedAt: "",
  };
  expect(credentialForm(base)).toMatchObject({ header: "", scheme: "Bearer" });
  expect(
    credentialForm({ ...base, injection: { header: "X-Api-Key" } }),
  ).toMatchObject({ header: "X-Api-Key", scheme: "" });
  expect(
    credentialForm({
      ...base,
      injection: { header: "Authorization", scheme: "Basic" },
    }),
  ).toMatchObject({ header: "Authorization", scheme: "Basic" });
});

test("the preview line is what goes out, with the secret masked", () => {
  const form = credentialForm();
  expect(injectionPreview(form)).toBe("Authorization: Bearer ••••");
  expect(injectionPreview({ ...form, header: "X-Api-Key", scheme: "" })).toBe(
    "X-Api-Key: ••••",
  );
  expect(injectionPreview({ ...form, scheme: "Token" })).toBe(
    "Authorization: Token ••••",
  );
});

test("a service ID is the server's slug, made from what a person types", () => {
  expect(serviceSlug("Betterbahn Search Status")).toBe(
    "betterbahn-search-status",
  );
  expect(serviceSlug("  Acme: orders / v2!  ")).toBe("acme-orders-v2");
  expect(serviceSlug("acme--orders")).toBe("acme--orders");
  expect(serviceSlug("-_.acme.orders_v2")).toBe("acme.orders_v2");
  expect(serviceSlug("Café")).toBe("caf");
  expect(serviceSlug("!!!")).toBe("");
  // While typing, the "-" a space made stays for the next word.
  expect(serviceSlug("acme ", true)).toBe("acme-");
  expect(serviceSlug("acme- ", true)).toBe("acme-");
  for (const raw of ["A b", " x ", "Ünïcode name", "a__b", "9 lives"])
    expect(serviceSlug(raw)).toMatch(/^([a-z0-9][a-z0-9._-]*)?$/);
});

test("the server's ID refusals are worded for the ID field", () => {
  expect(
    serviceIdError(
      "service must be a short lowercase slug (letters, digits, . _ -)",
    ),
  ).toContain("lowercase letters, digits");
  expect(
    serviceIdError('a credential for service "acme-orders" already exists'),
  ).toBe("A credential with the ID acme-orders already exists. Choose another");
  expect(serviceIdError("host must be a public host name")).toBeNull();
});
