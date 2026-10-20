import { expect, test } from "bun:test";
import {
  type ProjectAccessGrants,
  defaultProjectGrants,
} from "../../../shared/incident-access";
import {
  staticAccessEnvironment,
  useAccessTestEnv,
} from "../testing/access-fixture";
import { __setIdentitiesForTest } from "../../shared/user-mappings";
import { type AccessActor, validateGrants } from "./grants";

const t = useAccessTestEnv();
const env = () => staticAccessEnvironment(t.spec);
const base = (over: Partial<ProjectAccessGrants> = {}) => ({
  ...defaultProjectGrants("acme"),
  ...over,
});
const ada = { name: "Ada", login: "ada", verified: true },
  bo = { name: "Bo", login: "bo", verified: true },
  claimedAda = { name: "Ada", verified: false };
const ctx = (actor: AccessActor, previous = base()) => ({
  project: "acme",
  actor,
  previous,
  now: "2026-10-20T12:00:00.000Z",
});

test("the owner grants a personal credential; the stamp is server-side", () => {
  const out = validateGrants(
    {
      ...base(),
      credentials: [
        { credential: "proxy-api", mode: "standing", grantedBy: "Mallory" },
      ],
    },
    ctx(ada),
    env(),
  );
  expect(out).toEqual({
    grants: base({
      credentials: [
        {
          credential: "kc-proxy",
          mode: "standing",
          grantedBy: "Ada",
          grantedByLogin: "ada",
          grantedAt: "2026-10-20T12:00:00.000Z",
        },
      ],
    }),
    credentialChanges: [
      { credential: "kc-proxy", change: "granted", mode: "standing" },
    ],
  });
});
test("nobody else, and no claimed identity, can grant a personal credential", () => {
  expect(
    validateGrants(
      { ...base(), credentials: [{ credential: "kc-proxy", mode: "once" }] },
      ctx(bo),
      env(),
    ),
  ).toEqual({ error: "Only Ada can grant proxy-api to incident agents" });
  expect(
    validateGrants(
      { ...base(), credentials: [{ credential: "kc-proxy", mode: "once" }] },
      ctx(claimedAda),
      env(),
    ),
  ).toEqual({ error: "Sign in to grant credentials to incident agents" });
});
test("a workspace credential needs any signed-in teammate; logins never", () => {
  expect(
    "error" in
      validateGrants(
        { ...base(), credentials: [{ credential: "kc-shared", mode: "once" }] },
        ctx(ada),
        env(),
      ),
  ).toBe(false);
  expect(
    validateGrants(
      { ...base(), credentials: [{ credential: "kc-shared", mode: "once" }] },
      ctx(claimedAda),
      env(),
    ),
  ).toEqual({ error: "Sign in to grant credentials to incident agents" });
  expect(
    validateGrants(
      { ...base(), credentials: [{ credential: "kc-login", mode: "once" }] },
      ctx(ada),
      env(),
    ),
  ).toEqual({
    error: "admin-login is a login; logins are never lent to incident agents",
  });
});
test("carrying, narrowing and removing need no authority; widening does", () => {
  const prev = base({
    credentials: [
      {
        credential: "kc-proxy",
        mode: "once",
        grantedBy: "Ada",
        grantedAt: "2026-10-19T00:00:00.000Z",
      },
    ],
  });
  expect(
    validateGrants(
      { ...prev, credentials: [{ credential: "kc-proxy", mode: "once" }] },
      ctx(bo, prev),
      env(),
    ),
  ).toEqual({ grants: prev, credentialChanges: [] });
  expect(
    validateGrants({ ...prev, credentials: [] }, ctx(bo, prev), env()),
  ).toEqual({
    grants: base(),
    credentialChanges: [{ credential: "kc-proxy", change: "removed" }],
  });
  expect(
    validateGrants(
      { ...prev, credentials: [{ credential: "kc-proxy", mode: "standing" }] },
      ctx(bo, prev),
      env(),
    ),
  ).toEqual({ error: "Only Ada can grant proxy-api to incident agents" });
});
test("proxy egress credentials must fit the proxy", () => {
  const creds = [{ credential: "kc-fwd", mode: "standing" }];
  expect(
    "error" in
      validateGrants(
        {
          ...base(),
          credentials: creds,
          egress: [
            {
              route: "proxy",
              url: "http://proxy.example.test:8080",
              credential: "kc-fwd",
            },
          ],
        },
        ctx(ada),
        env(),
      ),
  ).toBe(false);
  expect(
    validateGrants(
      {
        ...base(),
        credentials: [],
        egress: [
          {
            route: "proxy",
            url: "http://proxy.example.test:8080",
            credential: "kc-fwd",
          },
        ],
      },
      ctx(ada),
      env(),
    ),
  ).toEqual({ error: expect.stringContaining("not in the project's grants") });
  expect(
    validateGrants(
      {
        ...base(),
        credentials: [{ credential: "kc-proxy", mode: "once" }],
        egress: [
          {
            route: "proxy",
            url: "http://proxy.example.test:8080",
            credential: "kc-proxy",
          },
        ],
      },
      ctx(ada),
      env(),
    ),
  ).toEqual({ error: "proxy-api is not for proxy.example.test" });
});
test("strict keys", () => {
  expect(validateGrants({ ...base(), admin: true }, ctx(ada), env())).toEqual({
    error: 'Unknown field "admin"',
  });
});

// Lending is decided on stable roster identities (the GitHub login of the
// verified sign-in), never on first names, which teammates can share.
const TWO_ADAS = [
  { name: "Ada Lovelace", github: "ada" },
  { name: "Ada Byron", github: "ada-byron" },
  { name: "Bo Example", github: "bo" },
];
const adaByron = { name: "Ada", login: "ada-byron", verified: true };
const lend = (actor: AccessActor) =>
  validateGrants(
    { ...base(), credentials: [{ credential: "kc-proxy", mode: "once" }] },
    ctx(actor),
    env(),
  );
test("a teammate who shares the owner's first name cannot lend the credential", () => {
  __setIdentitiesForTest(TWO_ADAS);
  t.spec.credentials[0].owner = "Ada Lovelace";
  expect(lend(adaByron)).toEqual({
    error: "Only Ada Lovelace can grant proxy-api to incident agents",
  });
  expect(lend(ada)).toMatchObject({
    grants: {
      credentials: [{ credential: "kc-proxy", grantedByLogin: "ada" }],
    },
  });
});
test("an owner name two teammates share lends to nobody", () => {
  __setIdentitiesForTest(TWO_ADAS);
  expect(lend(ada)).toEqual({
    error: "Only Ada can grant proxy-api to incident agents",
  });
  expect(lend(adaByron)).toEqual({
    error: "Only Ada can grant proxy-api to incident agents",
  });
});
test("a verified sign-in that is on no roster, or has no login, cannot lend a personal credential", () => {
  expect(lend({ name: "Ada", login: "stranger", verified: true })).toEqual({
    error: "Only Ada can grant proxy-api to incident agents",
  });
  expect(lend({ name: "Ada", verified: true })).toEqual({
    error: "Sign in to grant credentials to incident agents",
  });
});
test("the caller cannot set who granted a credential", () => {
  expect(
    validateGrants(
      {
        ...base(),
        credentials: [
          { credential: "kc-shared", mode: "once", grantedByLogin: "ada" },
        ],
      },
      ctx(bo),
      env(),
    ),
  ).toMatchObject({
    grants: {
      credentials: [
        { credential: "kc-shared", grantedBy: "Bo", grantedByLogin: "bo" },
      ],
    },
  });
});
test("an owner without a roster entry and GitHub login cannot lend a personal credential", () => {
  const missing = {
    error:
      "The owner needs a team roster entry with a GitHub login to lend this credential",
  };
  t.spec.credentials[0].owner = "Cy";
  expect(lend(ada)).toEqual(missing);
  __setIdentitiesForTest([
    { name: "Ada Lovelace" },
    { name: "Bo Example", github: "bo" },
  ]);
  t.spec.credentials[0].owner = "Ada";
  expect(lend(ada)).toEqual(missing);
});
