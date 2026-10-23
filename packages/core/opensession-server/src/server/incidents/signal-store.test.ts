import { expect, test } from "bun:test";
import {
  createSignal,
  deleteSignal,
  getSignal,
  listSignals,
  setSignalRunOnCheck,
  signalWriteCount,
  updateSignal,
} from "./signal-store";
import { __setOwnerRosterForTest } from "./owner";
import { appendObservations, recentObservations } from "./observation-store";
import { redactSignal } from "./signal-validation";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
const person = { signedInPerson: true };
const machine = { automation: true };
const http = {
  name: "Search",
  project: "acme",
  source: {
    kind: "http",
    url: "https://acme.example.test/q",
    headers: { Authorization: "Bearer s3cret" },
  },
};

test("create, get, list", async () => {
  const a = await createSignal(http, "Ada");
  const b = await createSignal({ ...http, name: "Api" }, "Ada");
  if ("error" in a || "error" in b) throw new Error("create failed");
  expect(a.id).toMatch(/^sig-/);
  expect(a.hookSecret).toBeUndefined();
  expect(await getSignal(a.id)).toEqual(a);
  expect((await listSignals()).map((s) => s.name)).toEqual(["Api", "Search"]);
  expect(await getSignal("../etc")).toBeNull();
});

test("hook sources get a secret; switching to one creates it", async () => {
  const w = await createSignal(
    { name: "Errors", project: "acme", source: { kind: "webhook" } },
    "Ada",
  );
  if ("error" in w) throw new Error(w.error);
  expect(w.hookSecret).toMatch(/^[0-9a-f]{48}$/);
  const h = await createSignal(http, "Ada");
  if ("error" in h) throw new Error(h.error);
  const moved = await updateSignal(
    h.id,
    {
      source: { kind: "heartbeat" },
      rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
    },
    "Ada",
  );
  expect(moved && !("error" in moved) && moved.hookSecret).toMatch(
    /^[0-9a-f]{48}$/,
  );
});

test("partial update keeps the rest and the redacted header", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  const next = await updateSignal(
    s.id,
    {
      name: "Search API",
      source: {
        kind: "http",
        url: "https://acme.example.test/q",
        headers: { Authorization: "[redacted]" },
      },
    },
    "Bo",
  );
  expect(next).toMatchObject({
    name: "Search API",
    project: "acme",
    createdBy: "Ada",
    source: { headers: { Authorization: "Bearer s3cret" } },
  });
  expect(await updateSignal("sig-missing", { name: "x" }, "Bo")).toBeNull();
  expect(await updateSignal(s.id, { project: "globex" }, "Bo")).toEqual({
    error: expect.any(String),
  });
});

test("a redacted header does not follow the signal to another address", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  const moved = await updateSignal(
    s.id,
    {
      source: {
        kind: "http",
        url: "https://other.example.test/q",
        headers: { Authorization: "[redacted]" },
      },
    },
    "Bo",
  );
  expect(moved).toEqual({
    error: "Enter the Authorization value again for the new address",
  });
  expect(await getSignal(s.id)).toEqual(s);
  const retyped = await updateSignal(
    s.id,
    {
      source: {
        kind: "http",
        url: "https://other.example.test/q",
        headers: { Authorization: "Bearer other" },
      },
    },
    "Bo",
  );
  expect(retyped).toMatchObject({
    source: { headers: { Authorization: "Bearer other" } },
  });
});

test("a hook keeps its secret across a rename and a switch away and back", async () => {
  const w = await createSignal(
    { name: "Errors", project: "acme", source: { kind: "webhook" } },
    "Ada",
  );
  if ("error" in w) throw new Error(w.error);
  const renamed = await updateSignal(w.id, { name: "Errors API" }, "Ada");
  expect(renamed && !("error" in renamed) && renamed.hookSecret).toBe(
    w.hookSecret,
  );
  await updateSignal(w.id, { source: http.source }, "Ada");
  const back = await updateSignal(w.id, { source: { kind: "webhook" } }, "Ada");
  expect(back && !("error" in back) && back.hookSecret).toBe(w.hookSecret);
});

test("audits every write without secrets", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  await updateSignal(s.id, { name: "Search API", severity: "critical" }, "Bo");
  await deleteSignal(s.id, "Bo");
  expect(kit.audits).toEqual([
    {
      kind: "incident_signal_created",
      signalId: s.id,
      project: "acme",
      by: "Ada",
    },
    {
      kind: "incident_signal_updated",
      signalId: s.id,
      by: "Bo",
      fields: ["name", "severity"],
    },
    { kind: "incident_signal_deleted", signalId: s.id, by: "Bo" },
  ]);
  expect(JSON.stringify(kit.audits)).not.toContain("s3cret");
  expect(await getSignal(s.id)).toBeNull();
  expect(await deleteSignal(s.id, "Bo")).toBe(false);
});

test("writes bump the namespace counter", async () => {
  const before = signalWriteCount();
  await createSignal(http, "Ada");
  expect(signalWriteCount()).toBe(before + 1);
});

test("deleting a signal forgets its observations in memory", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  appendObservations(s.id, [
    { at: "2026-10-20T10:00:00.000Z", result: "ok", detail: "" },
  ]);
  expect(recentObservations(s.id)).toHaveLength(1);
  await deleteSignal(s.id, "Bo");
  expect(recentObservations(s.id)).toEqual([]);
});

test("an impact keeps its secret when sent back redacted", async () => {
  const impact = {
    kind: "http",
    url: "https://logs.example.test/c?since={{since}}",
    headers: { Authorization: "Bearer l0g" },
    countPath: "$.failed",
    noun: "searches failed",
    label: "the request log",
  } as const;
  const s = await createSignal({ ...http, impact }, "Ada");
  if ("error" in s) throw new Error(s.error);
  expect(s.impact).toEqual(impact);
  const view = redactSignal(s);
  expect(JSON.stringify(view)).not.toContain("l0g");
  const renamed = await updateSignal(
    s.id,
    { name: "Search API", impact: view.impact },
    "Bo",
  );
  expect(renamed).toMatchObject({ name: "Search API", impact });
  const reworded = await updateSignal(
    s.id,
    { impact: { ...view.impact, noun: "searches lost" } },
    "Bo",
  );
  expect(reworded).toMatchObject({
    impact: { noun: "searches lost", headers: { Authorization: "Bearer l0g" } },
  });
  const cleared = await updateSignal(s.id, { impact: null }, "Bo");
  expect(cleared && !("error" in cleared) && "impact" in cleared).toBe(false);
  const updates = kit.audits.filter(
    (a) => a.kind === "incident_signal_updated",
  );
  expect(updates.map((a) => a.fields)).toEqual([
    ["name"],
    ["impact"],
    ["impact"],
  ]);
  expect(JSON.stringify(kit.audits)).not.toContain("l0g");
});

test("an impact that copies the source's secrets is audited by field name", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  const impact = {
    kind: "http",
    url: "https://acme.example.test/count",
    headers: { Authorization: "[redacted]" },
    countPath: "$.failed",
    noun: "searches failed",
    label: "the request log",
  };
  const updated = await updateSignal(s.id, { impact }, "Bo");
  expect(updated).toMatchObject({
    impact: { headers: { Authorization: "Bearer s3cret" } },
  });
  // Sent back unchanged: the impact's own secret, nothing from the source.
  await updateSignal(
    s.id,
    { name: "Search API", impact: redactSignal(updated as never).impact },
    "Bo",
  );
  const updates = kit.audits.filter(
    (a) => a.kind === "incident_signal_updated",
  );
  expect(updates).toEqual([
    {
      kind: "incident_signal_updated",
      signalId: s.id,
      by: "Bo",
      fields: ["impact"],
      impactSecrets: { from: "source", fields: ["headers.Authorization"] },
    },
    {
      kind: "incident_signal_updated",
      signalId: s.id,
      by: "Bo",
      fields: ["name"],
    },
  ]);
  expect(JSON.stringify(kit.audits)).not.toContain("s3cret");
});

test("a runOn check can refuse a signal", async () => {
  const seen: string[] = [];
  setSignalRunOnCheck(async (s) => {
    seen.push(`${s.project}:${s.runOn}`);
    return s.runOn === "runner-prod" && s.project === "acme"
      ? null
      : `${s.runOn} is not a production Runner for ${s.project}`;
  });
  try {
    expect(
      await createSignal({ ...http, runOn: "runner-lab" }, "Ada", person),
    ).toEqual({ error: "runner-lab is not a production Runner for acme" });
    const ok = await createSignal(
      { ...http, runOn: "runner-prod" },
      "Ada",
      person,
    );
    if ("error" in ok) throw new Error(ok.error);
    expect(
      await updateSignal(ok.id, { runOn: "runner-lab" }, "Ada", person),
    ).toEqual({
      error: "runner-lab is not a production Runner for acme",
    });
    expect(
      await updateSignal(ok.id, { project: "acme-api" }, "Ada", person),
    ).toEqual({
      error: "runner-prod is not a production Runner for acme-api",
    });
    expect((await getSignal(ok.id))?.project).toBe("acme");
    const plain = await createSignal(http, "Ada");
    expect("error" in plain).toBe(false);
    expect(seen).not.toContain("acme:undefined");
  } finally {
    setSignalRunOnCheck(undefined);
  }
});

test("runOn is refused while no Runner check is installed", async () => {
  expect(
    await createSignal({ ...http, runOn: "runner-prod" }, "Ada", person),
  ).toEqual({ error: "Runner checks are not available on this server yet" });
  const plain = await createSignal(http, "Ada", person);
  if ("error" in plain) throw new Error(plain.error);
  expect(
    await updateSignal(plain.id, { runOn: "runner-prod" }, "Ada", person),
  ).toEqual({ error: "Runner checks are not available on this server yet" });
});

test("only a signed-in person decides where a signal runs and what it fetches", async () => {
  setSignalRunOnCheck(async () => null);
  try {
    const refused = {
      error:
        "Only a signed-in person can change a signal that runs from a production Runner",
    };
    expect(await createSignal({ ...http, runOn: "runner-prod" }, "Bo")).toEqual(
      refused,
    );
    const plain = await createSignal(http, "Bo");
    if ("error" in plain) throw new Error(plain.error);
    expect(
      await updateSignal(plain.id, { runOn: "runner-prod" }, "Bo"),
    ).toEqual(refused);
    const prod = await createSignal(
      { ...http, runOn: "runner-prod" },
      "Ada",
      person,
    );
    if ("error" in prod) throw new Error(prod.error);
    for (const change of [
      { source: { kind: "http", url: "http://10.0.0.9/admin" } },
      { project: "acme-api" },
      { runOn: "runner-other" },
      { runOn: null },
    ])
      expect([change, await updateSignal(prod.id, change, "Bo")]).toEqual([
        change,
        refused,
      ]);
    // Anything else stays open to everyone who could edit it before.
    const renamed = await updateSignal(prod.id, { name: "Search API" }, "Bo");
    expect(renamed).toMatchObject({ name: "Search API", runOn: "runner-prod" });
    const moved = await updateSignal(
      prod.id,
      { source: { kind: "http", url: "https://acme.example.test/v2" } },
      "Ada",
      person,
    );
    expect(moved).toMatchObject({ runOn: "runner-prod" });
    // Without a check, a Runner signal can still be renamed or turned off,
    // but not moved.
    setSignalRunOnCheck(undefined);
    expect(
      await updateSignal(prod.id, { enabled: false }, "Ada", person),
    ).toMatchObject({ enabled: false, runOn: "runner-prod" });
    expect(
      await updateSignal(prod.id, { runOn: "runner-other" }, "Ada", person),
    ).toEqual({ error: "Runner checks are not available on this server yet" });
  } finally {
    setSignalRunOnCheck(undefined);
  }
});

test("a signal is owned by a person, never by the automation principal", async () => {
  __setOwnerRosterForTest([
    { name: "Ada Lovelace", aliases: ["ada"], github: "ada-acme" },
    { name: "Bo Diddley" },
  ]);
  try {
    // The person who creates it owns it, keyed by their first name.
    const mine = await createSignal(http, "ada lovelace", person);
    expect(mine).toMatchObject({ owner: "Ada", createdBy: "ada lovelace" });
    // The automation principal never owns one: the instance owner does,
    // unless it names a person.
    const made = await createSignal(http, "Automation", machine);
    expect(made).toMatchObject({ owner: "Ada", createdBy: "Automation" });
    const named = await createSignal(
      { ...http, owner: "bo diddley" },
      "Automation",
      machine,
    );
    if ("error" in named) throw new Error(named.error);
    expect(named).toMatchObject({ owner: "Bo", createdBy: "Automation" });
    expect(
      await createSignal(
        { ...http, owner: "Automation" },
        "Automation",
        machine,
      ),
    ).toEqual({ error: "The owner must be a person" });
    // A name nobody on the team goes by is refused, not taken as given.
    expect(
      await createSignal({ ...http, owner: "Adaa" }, "ada lovelace", person),
    ).toEqual({ error: 'Nobody on the team is called "Adaa"' });
    // Edits keep the owner; naming another person moves it.
    expect(
      await updateSignal(
        named.id,
        { name: "Search API" },
        "Automation",
        machine,
      ),
    ).toMatchObject({ owner: "Bo" });
    expect(
      await updateSignal(named.id, { owner: "ada-acme" }, "Bo", person),
    ).toMatchObject({ owner: "Ada" });
    expect(
      await updateSignal(named.id, { owner: "Automation" }, "Bo", person),
    ).toEqual({ error: "The owner must be a person" });
  } finally {
    __setOwnerRosterForTest(undefined);
  }
});

test("an edit gives a signal without an owner the person it falls back to", async () => {
  __setOwnerRosterForTest([{ name: "Ada Lovelace" }, { name: "Bo Diddley" }]);
  try {
    const legacy = await createSignal(http, "Automation", machine);
    if ("error" in legacy) throw new Error(legacy.error);
    // Stored before signals had owners.
    const { owner: _owner, ...stored } = legacy;
    const before = kit
      .store()
      .catalogDocumentGet("incident-signals", legacy.id);
    const put = kit.store().putCatalogDocument({
      op: "put",
      namespace: "incident-signals",
      key: legacy.id,
      expectedRev: before?.rev ?? null,
      value: JSON.stringify(stored),
      requestId: crypto.randomUUID(),
    });
    if (put.status !== "committed") throw new Error(put.status);
    expect((await getSignal(legacy.id))?.owner).toBeUndefined();
    expect(
      await updateSignal(legacy.id, { name: "Search API" }, "Bo", person),
    ).toMatchObject({ owner: "Ada", createdBy: "Automation" });
  } finally {
    __setOwnerRosterForTest(undefined);
  }
});

test("with nobody to fall back to, the automation principal names the owner", async () => {
  __setOwnerRosterForTest([]);
  try {
    expect(await createSignal(http, "Automation", machine)).toEqual({
      error: "Name a person to own this signal",
    });
    expect(
      await createSignal({ ...http, owner: "Ada" }, "Automation", machine),
    ).toMatchObject({ owner: "Ada" });
  } finally {
    __setOwnerRosterForTest(undefined);
  }
});
