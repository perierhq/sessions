import { expect, test } from "bun:test";
import {
  defaultIncidentAccessSettings,
  defaultProjectGrants,
  defaultRoleProfile,
} from "../../../shared/incident-access";
import {
  staticAccessEnvironment,
  useAccessTestEnv,
} from "../testing/access-fixture";
import {
  checkWithinGrants,
  mergeProfile,
  parseStoredSettings,
  validateProfileFields,
} from "./fields";

const t = useAccessTestEnv();
const env = () => staticAccessEnvironment(t.spec);
const inv = {
  role: "investigator" as const,
  project: "acme",
  partial: false,
};

test("complete profile fills role defaults", () => {
  expect(
    validateProfileFields({ connections: ["sentry"] }, inv, env()),
  ).toEqual({
    ...defaultRoleProfile("investigator", "acme"),
    connections: ["sentry"],
  });
});
test("an override keeps only what it names", () => {
  expect(
    validateProfileFields(
      { hosts: [{ runner: "rn-prod", access: "read-only" }] },
      { ...inv, partial: true },
      env(),
    ),
  ).toEqual({ hosts: [{ runner: "rn-prod", access: "read-only" }] });
});
test.each([
  [{ sudo: true }, 'Unknown field "sudo"'],
  [
    { hosts: [{ runner: "rn-prod", access: "read-only", root: true }] },
    'Unknown host field "root"',
  ],
  [{ connections: ["nope"] }, 'Unknown connection "nope"'],
  [{ connections: ["opensession-admin"] }, "built in"],
  [{ connections: ["people-only"] }, "act as nobody"],
  [{ deniedTools: ["rm -rf"] }, 'Unknown tool name "rm -rf"'],
  [{ mode: "admin" }, "Mode must be ask or code"],
  [{ runners: ["rn-shared"] }, "isolated automation work"],
  [{ runners: ["rn-named"] }, "act as nobody"],
  [
    { hosts: [{ runner: "rn-prod", access: "read-write" }] },
    "Only read-only host access",
  ],
  [
    {
      hosts: [
        { runner: "rn-prod", ssh: "-oProxyCommand=x", access: "read-only" },
      ],
    },
    "Invalid SSH alias",
  ],
  [
    { credentials: [{ credential: "admin-login", mode: "once" }] },
    "never lent",
  ],
  [{ model: "gpt-0" }, 'Unknown model "gpt-0"'],
  [
    { egress: { route: "proxy", url: "http://u:p@proxy.example.test" } },
    "not the URL",
  ],
  [{ egress: { route: "server", hosts: ["10.0.0.1"] } }, "public host names"],
  [
    { egress: { route: "server", hosts: ["db.internal"] } },
    "public host names",
  ],
  [{ egress: { route: "server", hosts: ["0x7f.1"] } }, "public host names"],
  [
    { egress: { route: "proxy", url: "http://proxy.example.test/x?k=1" } },
    "path, query or fragment",
  ],
])("rejects %j", (input, message) => {
  expect(validateProfileFields(input, inv, env())).toEqual({
    error: expect.stringContaining(message),
  });
});
test("verifier is locked to ask", () => {
  expect(
    validateProfileFields(
      { mode: "code" },
      { ...inv, role: "verifier" },
      env(),
    ),
  ).toEqual({
    error: "The verifier cannot edit the candidate, so its mode must be ask",
  });
});
test("within grants: first violation wins, denials and model are free", () => {
  const grants = {
    ...defaultProjectGrants("acme"),
    connections: ["sentry"],
    credentials: [
      {
        credential: "kc-proxy",
        mode: "once" as const,
        grantedBy: "Ada",
        grantedAt: "2026-10-20T10:00:00Z",
      },
    ],
    egress: [
      {
        route: "runner" as const,
        runner: "rn-prod",
        hosts: ["search.example.test"],
      },
    ],
    maxMode: "ask" as const,
  };
  expect(
    checkWithinGrants(
      {
        connections: ["sentry"],
        deniedTools: ["bash"],
        model: "pi/openai/gpt-6.1",
        mode: "ask",
      },
      grants,
    ),
  ).toBeNull();
  expect(checkWithinGrants({ connections: ["logs"] }, grants)).toBe(
    'Connection "logs" is not in the project\'s grants',
  );
  expect(checkWithinGrants({ mode: "code" }, grants)).toBe(
    "Mode code is wider than the project's grants",
  );
  expect(
    checkWithinGrants(
      { credentials: [{ credential: "kc-proxy", mode: "standing" }] },
      grants,
    ),
  ).toBe(
    'Credential "kc-proxy" as standing is wider than the project\'s grant (once)',
  );
  expect(checkWithinGrants({ egress: { route: "server" } }, grants)).toBe(
    "Egress route server is not in the project's grants",
  );
  expect(
    checkWithinGrants(
      {
        egress: {
          route: "runner",
          runner: "rn-prod",
          hosts: ["other.example.test"],
        },
      },
      grants,
    ),
  ).toBe(
    "Egress host other.example.test is not in the project's grants for that route",
  );
});
test("merge replaces whole fields", () => {
  const base = {
    ...defaultRoleProfile("investigator", "acme"),
    connections: ["sentry", "logs"],
  };
  expect(mergeProfile(base, { connections: [] }).connections).toEqual([]);
  expect(mergeProfile(base, undefined)).toEqual(base);
});
test("stored documents parse strictly", () => {
  const good = defaultIncidentAccessSettings(
    "acme",
    "2026-10-20T10:00:00.000Z",
  );
  expect(parseStoredSettings(good)).toEqual(good);
  expect(parseStoredSettings({ ...good, extra: 1 })).toEqual({
    error: 'Unknown field "extra"',
  });
  expect(
    parseStoredSettings({
      ...good,
      profiles: {
        ...good.profiles,
        verifier: { ...good.profiles.verifier, sudo: true },
      },
    }),
  ).toEqual({ error: 'Unknown field "profiles.verifier.sudo"' });
  expect(
    parseStoredSettings({
      ...good,
      profiles: { investigator: good.profiles.investigator },
    }),
  ).toEqual({ error: expect.stringContaining("verifier") });
});
