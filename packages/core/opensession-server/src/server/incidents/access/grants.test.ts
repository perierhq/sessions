import { expect, test } from "bun:test";
import {
  type ProjectAccessGrants,
  defaultProjectGrants,
} from "../../../shared/incident-access";
import {
  staticAccessEnvironment,
  useAccessTestEnv,
} from "../testing/access-fixture";
import { type AccessActor, validateGrants } from "./grants";

const t = useAccessTestEnv();
const env = () => staticAccessEnvironment(t.spec);
const base = (over: Partial<ProjectAccessGrants> = {}) => ({
  ...defaultProjectGrants("acme"),
  ...over,
});
const ada = { name: "Ada", verified: true },
  bo = { name: "Bo", verified: true },
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
