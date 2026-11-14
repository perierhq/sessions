// Settings, Members, Blob's card: the GitHub account section in each of its
// states. Not set up (purpose, steps, token field), set up (login link,
// expiry, repositories, public repositories, the switch, Remove token),
// expiring, a server error, and the non-owner, who sees nothing. Rendered to
// markup; no effects run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlobGithub } from "../../lib/blob-github";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  fetch: () => new Promise<Response>(() => {}),
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { BlobGithubSection, BlobGithubView } =
  await import("./BlobGithubSection");
const { BlobMemberCard } = await import("./BotsSection");

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 86_400_000;
const REPOS = ["acme/docs", "acme/widget"];

const notSetUp: BlobGithub = {
  login: null,
  expiresAt: null,
  repos: [],
  publicRepos: [],
  enabled: false,
  tokenSet: false,
};

const setUp: BlobGithub = {
  login: "acme-blob",
  expiresAt: new Date(NOW + 60 * DAY).toISOString(),
  repos: ["acme/widget", "acme/docs"],
  publicRepos: ["acme/docs"],
  enabled: true,
  tokenSet: true,
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|\u2019/g, "'")
    .replace(/\s+/g, " ");

const view = (
  settings: BlobGithub,
  extra: Partial<React.ComponentProps<typeof BlobGithubView>> = {},
) =>
  renderToStaticMarkup(
    <BlobGithubView settings={settings} repos={REPOS} now={NOW} {...extra} />,
  );

describe("BlobGithubSection", () => {
  test("not set up: what it is for, the steps, and a write-only token field", () => {
    const html = view(notSetUp);
    const shown = text(html);
    expect(shown).toContain("GitHub account");
    expect(shown).toContain(
      "Blob can comment, review and label on GitHub under its own account. It never pushes or merges.",
    );
    expect(html).toContain("<ol");
    expect(html).toContain(
      'href="https://github.com/perierhq/sessions/blob/main/docs/setup/github.md#blobs-github-account"',
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="Fine-grained token"');
    expect(shown).toContain("Save");
    expect(shown).not.toContain("Remove token");
    expect(shown).not.toContain("Post on GitHub");
  });

  test("not set up: Post as offers Blob's account or mine, each explained", () => {
    const own = view(notSetUp);
    const shown = text(own);
    expect(shown).toContain("Post as");
    expect(shown).toContain(
      "Blob's account A GitHub account of its own, so its posts show under Blob's name.",
    );
    expect(shown).toContain("My account");
    expect(shown).toContain("Your own comments stay yours.");
    expect(own.match(/role="radio"/g)).toHaveLength(2);
    expect(own).toMatch(/role="radio"[^>]*aria-checked="true"/);
    // Blob's own steps until the owner picks their account.
    expect(shown).toContain("Sign up a GitHub account for Blob");
  });

  test("my account: the owner's purpose, steps and token hint", () => {
    const html = view(notSetUp, { as: "owner" });
    const shown = text(html);
    expect(shown).toContain(
      "Blob can comment, review and label on GitHub under your account. Each post ends with a line saying Blob wrote it. It never closes, approves, pushes or merges.",
    );
    expect(shown).toContain(
      "On your GitHub account, create a fine-grained token limited to the repositories Blob may use",
    );
    expect(shown).not.toContain("Sign up a GitHub account for Blob");
    expect(shown).toContain(
      "A fine-grained token on your account, limited to the chosen repositories, with Issues and Pull requests read and write.",
    );
    expect(html).toMatch(/type="password"[^>]*aria-describedby="[^"]+"/);
    expect(html).toContain(
      'href="https://github.com/perierhq/sessions/blob/main/docs/setup/github.md#posting-as-your-own-account"',
    );
  });

  test("Blob's own recorded account offers Forget instead of Post as", () => {
    const shown = text(view({ ...notSetUp, login: "acme-blob" }));
    expect(shown).not.toContain("Post as");
    expect(shown).toContain(
      "To post as your own account instead, forget Blob's account first.",
    );
    expect(shown).toContain("Forget Blob's account");
  });

  test("Forget shows only for Blob's own recorded account with no token", () => {
    expect(text(view(notSetUp))).not.toContain("Forget Blob's account");
    expect(text(view(setUp))).not.toContain("Forget Blob's account");
    expect(text(view({ ...setUp, as: "owner", login: "ada" }))).not.toContain(
      "Forget Blob's account",
    );
  });

  test("set up with my account: says so, and the choice is gone", () => {
    const shown = text(view({ ...setUp, as: "owner", login: "ada" }));
    expect(shown).toContain("@ada");
    expect(shown).toContain("Your account. Each post is signed as Blob.");
    expect(shown).not.toContain("Post as");
    expect(text(view(setUp))).not.toContain("Each post is signed as Blob");
  });

  test("a removed token keeps the account's login and asks for a new one", () => {
    const shown = text(view({ ...notSetUp, login: "acme-blob" }));
    expect(shown).toContain("Blob's account is @acme-blob . Paste a new token");
  });

  test("set up: login, expiry, repositories, the switch and Remove token", () => {
    const html = view(setUp);
    const shown = text(html);
    expect(html).toContain('href="https://github.com/acme-blob"');
    expect(shown).toContain("@acme-blob");
    expect(shown).toContain("Expires in 60 days");
    expect(html).not.toContain("text-yellow");
    expect(html).not.toContain('type="password"');
    expect(shown).toContain("Post on GitHub");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(shown).toContain("Repositories");
    expect(shown).toContain("Public repositories");
    expect(shown).toContain("Blob's comments there are public.");
    expect(shown).toContain("Remove token");
    // Both repositories in the allowlist, only acme/docs public.
    expect(html.match(/role="checkbox"[^>]*aria-checked="true"/g)).toHaveLength(
      3,
    );
  });

  test("public repositories start off and list only Blob's repositories", () => {
    const html = view({ ...setUp, repos: ["acme/widget"], publicRepos: [] });
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(html.match(/role="checkbox"[^>]*aria-checked="true"/g)).toHaveLength(
      1,
    );
    const none = text(view({ ...setUp, repos: [], publicRepos: [] }));
    expect(none).toContain("Tick a repository above first.");
  });

  test("expiring: warns under 14 days and offers the token field", () => {
    const html = view({
      ...setUp,
      expiresAt: new Date(NOW + 5 * DAY + 3_600_000).toISOString(),
    });
    expect(text(html)).toContain(
      "Expires in 5 days. Paste a new token before then.",
    );
    expect(html).toContain("text-yellow");
    expect(html).toContain('type="password"');
  });

  test("expired: says so, without 'before then', and offers the token field", () => {
    const html = view({
      ...setUp,
      expiresAt: new Date(NOW - DAY).toISOString(),
    });
    const shown = text(html);
    expect(shown).toContain("Expired. Paste a new token.");
    expect(shown).not.toContain("before then");
    expect(html).toContain('type="password"');
  });

  test("labels: a field when the server sends the allowlist, else none", () => {
    const html = view({ ...setUp, labels: ["bug", "needs-info"] });
    expect(text(html)).toContain("Labels Blob may set");
    expect(html).toContain('value="bug, needs-info"');
    expect(text(html)).toContain("Save labels");
    const empty = text(view({ ...setUp, labels: [] }));
    expect(empty).toContain("Labels Blob may set");
    expect(text(view(setUp))).not.toContain("Labels Blob may set");
    expect(text(view({ ...notSetUp, labels: [] }))).not.toContain(
      "Labels Blob may set",
    );
  });

  test("server errors show inline in plain words", () => {
    const tokenError = view(notSetUp, {
      tokenError: "GitHub refused the token. Check it was copied whole.",
    });
    expect(tokenError).toContain('aria-invalid="true"');
    expect(tokenError).toMatch(/aria-describedby="[^"]+"/);
    expect(text(tokenError)).toContain("GitHub refused the token.");

    const saveError = text(
      view(setUp, { error: "acme/old is not a registered GitHub repository." }),
    );
    expect(saveError).toContain(
      "acme/old is not a registered GitHub repository.",
    );

    const loadError = text(
      renderToStaticMarkup(
        <BlobGithubSection load={{ kind: "error" }} repos={REPOS} />,
      ),
    );
    expect(loadError).toContain("Couldn't load Blob's GitHub account.");
  });

  test("a non-owner sees nothing, and nothing shows while it loads", () => {
    for (const load of [null, { kind: "hidden" as const }])
      expect(
        renderToStaticMarkup(<BlobGithubSection load={load} repos={REPOS} />),
      ).toBe("");
  });

  test("sits in Blob's card for the owner, and not otherwise", () => {
    const summary = { prefs: null, leads: [], needsYou: null };
    const owner = text(
      renderToStaticMarkup(
        <BlobMemberCard
          bot={{ kind: "bot", name: "Blob", fullName: "Blob" }}
          summary={summary}
          github={{ kind: "ready", settings: setUp }}
          repos={REPOS}
        />,
      ),
    );
    expect(owner).toContain("GitHub account");
    expect(owner).toContain("@acme-blob");

    const other = text(
      renderToStaticMarkup(
        <BlobMemberCard
          bot={{ kind: "bot", name: "Blob", fullName: "Blob" }}
          summary={summary}
          github={{ kind: "hidden" }}
          repos={REPOS}
        />,
      ),
    );
    expect(other).not.toContain("GitHub account");
  });
});
