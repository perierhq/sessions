# Knowledge

Each project can have a private knowledge base for support: articles people
wrote, answers people sent, the project's docs, releases and website, and
imported files. The support agent searches and cites it. Nothing written
before a change in the world can back an automatic reply: freshness is
computed from what changed, and every citation is checked again at the
moment a reply is sent.

Knowledge is on only when email support is enabled. The code lives in
`packages/core/opensession-server/src/server/knowledge/`; the shared types
and the exact copy people see are in `src/shared/knowledge.ts`.

## Repositories

Every project gets one bare git repository, `knowledge-<project>`, next to the
[memory repositories](memory-repos.md) and built on the same machinery
(`GitRepoStore`: a bare repository, a locked service checkout, history, diff
and revert). It runs on the memory worker thread, so git and the index never
block the gateway.

```text
<memory dir>/
  repos/knowledge-<project>.git   canonical bare repository
  repo-work/knowledge-<project>   the service's own checkout
  knowledge-index.sqlite          derived full-text index; delete it and it rebuilds
```

Only the server writes to a knowledge repository: people through the
Knowledge page and its API, imports and capture as "Pat". Agents never get a
checkout, file tools or a write tool, and there is no Dreaming. A knowledge
repository has no remote and is never pushed anywhere; it never lands in the
code repository or on GitHub. Backup is the server state directory.

| Path                                     | Holds                                                                     | Default trust |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| `KNOWLEDGE.md`                           | Starter readme, written when the repository is created                    | not an item   |
| `articles/<slug>.md`                     | Articles people wrote or approved                                         | trusted       |
| `suggestions/<slug>.md`                  | Proposals from imports; approving moves them to `articles/`               | reference     |
| `sources/mail/<yyyy-mm>/<message id>.md` | Questions and the replies people sent, customer data stripped             | time rule     |
| `sources/repo/<repo path>.md`            | `docs/**`, `README.md` and `docs/incidents/**` at a default-branch commit | trusted       |
| `sources/releases/<tag>.md`              | Release notes                                                             | trusted       |
| `sources/web/<host>/<path>.md`           | Text of a page on the project's Support websites, with its hash           | trusted       |
| `sources/issues/<n>.md`                  | Open issues labelled `bug` ("known problem")                              | reference     |
| `sources/files/<slug>.md`                | Text of an uploaded PDF, Markdown file or export                          | reference     |
| `attachments/<slug>/<name>`              | The uploaded files themselves                                             | not an item   |

Every change is a commit. Its author is the signed-in person; imports are
authored by `Pat` with a `Suggested-by: Pat` trailer, and approving a
suggestion is a commit by the person, subject `Approve <title>`, with the same
trailer.

Before a commit the server checks every changed file: items are Markdown with
valid front matter in the folder their `origin` names, at most 256 KB;
attachments live under `attachments/`, at most 10 MB; symbolic links,
submodules and executable files are refused; and anything that looks like a
credential is refused ("Knowledge never stores credentials").

A person attaches files to an article or a suggestion: an article's files go
in `attachments/<slug>/`, a suggestion's in `attachments/suggestion+<slug>/`
(so the two never share a folder), and the editor links them relatively
(`../attachments/…`). Approving a suggestion moves its files to the new
article's folder and rewrites those links, also when the article gets a `-2`
name; discarding a suggestion deletes its files.

## Items

An item is a Markdown file with YAML front matter between `---` lines. The
server writes the keys in this order and refuses unknown keys:

```yaml
title: Exporting a project as CSV # required, at most 200 characters
kind: answer # answer | internal
trust: trusted # trusted | reference
status: active # active | needs-check | retired
origin: article # article | suggestion | mail | repo | release | web | issue | file
topics: [export, csv] # at most 12
sources:
  [
    mail:sm_0192ab,
    "repo:docs/export.md@<sha>",
    "url:https://help.acme.example.test/export#sha256=<hex>",
    issue:42,
    release:v1.4.0,
    file:handbook.pdf,
  ]
dependsOn:
  [
    repo:docs/export.md,
    repo:docs/,
    url:https://help.acme.example.test/export,
    issue:42,
    pr:57,
    release:v1.4.0,
  ]
validAsOf: 2026-10-20 # required: the day the content was last confirmed true
validAsOfCommit: <sha> # the code repository's default-branch commit it was checked against
reviewBy: 2027-01-31 # optional, for prices, deadlines and other volatile facts
check: {
    reason: "docs/export.md changed in 9c1d2e0",
    since: 2026-10-26,
    source: "repo:docs/export.md@<sha>",
  } # only with needs-check
suggestedBy: Pat
approvedBy: Ada
answeredAt: 2026-10-19T08:12:00Z # mail items only
```

- `answer` may be paraphrased or quoted to a customer. `internal` steers the
  agent and is never quoted.
- `dependsOn` lists what would make the item wrong. `repo:docs/` (trailing
  slash) covers everything under that folder.
- When a person sets an item back to `active`, `check` goes away.
- `origin`, `suggestedBy` and `approvedBy` are set by the server, never by
  the editor: `origin` follows the folder, `suggestedBy` keeps what ingestion
  wrote, and an article is approved by the person who saved or approved it.

## Trust

There are two tiers.

- **Trusted** items may back an automatic reply while they are fresh: replies
  a person sent after the latest relevant change, the project's docs and
  README at the default-branch commit, its own website pages, release notes,
  and approved articles. A draft a person approved without editing counts as
  a reply a person sent.
- **Reference** items can be searched and read but never back a reply on
  their own: older mail, uploaded files, Plain history exports, open bug
  issues, and suggestions nobody approved. Reference material produces
  suggestions; a person approves them.

An item backs a reply only when it is `trusted`, `active` and not past its
`reviewBy` date. An open bug issue alone never lets the agent tell a customer
"known, we're on it"; that needs a person, unless an approved article links
the issue.

## Freshness

1. Every item records when it was true: `validAsOf`, the code commit it was
   checked against, the page's content hash, the message date.
2. A re-validation run flips an item to `needs-check`, with a one-line reason,
   when something it depends on changed: a default-branch commit after
   `validAsOfCommit` touches a `dependsOn` path, a page's content hash
   changed, a new release's notes mention the item's topics, or an issue or
   pull request it references was closed or merged. The item is kept, never
   deleted, and its text is not touched. When a check can't tell (the code
   checkout is gone, GitHub can't list releases or say whether an issue is
   open, a page has no recorded hash or has been unreadable for 3 runs in a
   row, the code repository hasn't been fetched for 3 days, the run used up
   its 20 release checks), the item becomes `needs-check` with "Knowledge
   couldn't be checked"; it is never read as unchanged. A page that is gone
   (404, 410) or no longer on the project's websites counts as changed. A
   release check shows the small model the notes around each match and the
   item's matching section; a trusted item whose own topic the notes name
   stays only on a confident "unrelated", and a cleared release isn't asked
   about again for the same item text. Items already waiting for a check
   aren't checked again. Mirrors of the code repository and the website are
   rewritten from their changed source instead (a deleted file retires its
   mirror); the articles that depend on the same path or page are what flip.
   Each run is one commit by Pat:
   `Knowledge check: <n> need a check, <m> refreshed`.
3. Newer beats older. When two trusted items answer the same question and the
   small model finds they disagree, the article or mail answer of the pair
   becomes `needs-check` with "Disagrees with <other title>" and a link to
   the other item, and a person sees them side by side. Mirrors of the code
   repository, the website and releases never flip (they follow their
   source), and two mirrors are never compared with each other. Reference
   material is never compared.
   - The daily run examines each trusted item whose text changed since the
     knowledge commit the last check listed (a status change alone doesn't
     count), plus what earlier runs left unfinished. The first run examines
     the articles; when that commit is no longer in the history, every
     trusted item is examined. At most 50 items a run: 10 of the oldest unfinished, then
     the newest changed; the rest waits for the next run.
   - Each item is compared with the trusted items one search for its title
     and topics finds (any of their words, at most 4), at most 20
     comparisons per project per run, as one commit by Pat:
     `Knowledge conflicts: <n> need a check`.
   - A mail item is compared on its answer only. The model sees the first
     3,500 characters of each side; a disagreement further down a long item
     isn't seen.
   - When the model gives no answer, nothing flips and the item is compared
     again on the next run.
   - When a person clears a conflict check without changing either text,
     that pair is not compared again until one of the two texts changes.
4. Imported mail is time-aware. A question-and-reply pair older than the
   latest change to what it touches (the newest release, or a default-branch
   commit touching those paths, committed up to 2 days before the reply,
   since a commit can land later than it was made) is imported as
   reference. When the pair's touched paths can't be told, it counts as
   touching all of `docs/` and `README.md`. When the history can't be read
   (GitHub down, the reply's time is in the future), it is reference with
   "History couldn't be read".

   The mailbox import reads the inbox's `INBOX` and Sent folders over its
   own read-only connection (no flags change; the inbox's live connection,
   position and conversations stay as they are) for the last 12 months by
   default (at most 36). Only mail in the Sent folder from this inbox's own
   addresses is ours; mail in `INBOX` from any of our addresses is a loop or
   a spoof and is dropped, and an inbox without a Sent folder gives no
   answers. A reply of ours pairs with the customer message it answers (not
   a follow-up to our own message); automatic replies and machine mail are
   left out. A reply's time is the earlier of its arrival and its Date
   header; when the two are more than a day apart, or the default branch
   couldn't be fetched, the pair is reference. Envelopes are read first and
   the full mail only of paired messages; a run looks at up to 20,000
   messages and imports the newest 500 pairs (a run cut short is marked
   so), and fails after 30 minutes. A reference item's first line says
   why: `> Imported as reference: <reason>`. Items already imported are
   skipped, so running it again adds only new pairs. Commits go in batches
   of 50 by Pat: `Import mail: <n> answers (<trusted> trusted)`. One import
   of a kind runs per project at a time and a person may cancel a running
   one (`POST /api/knowledge/<project>/jobs/<id>/cancel`); an import a
   restart cut off shows "Interrupted by a restart. Start it again."

   The repository import mirrors `README.md`, `docs/**/*.md` and everything
   under `docs/incidents/` at the fetched default-branch head as trusted
   `sources/repo/` items (runbooks under `docs/incidents/` are `internal`:
   they steer, and are never quoted), then the newest 30 GitHub releases as
   `sources/releases/<tag>.md`. Text is copied as written: a file that looks
   like it holds a credential, is binary, empty or over the article size is
   skipped and counted, never redacted. A doc deleted upstream retires its
   item (text kept); an unchanged item is left alone, so running it again at
   the same head commits nothing. One commit each by Pat: `Import
repository docs: <n> files` and `Import releases: <n>`.

   The website import crawls the exact hosts of the project's Support
   websites (wildcard entries never), over https only. Per host it reads
   `robots.txt` first and honours its `Disallow` and `Allow` rules for every
   agent (`*`); a host whose `robots.txt` can't be read is skipped. It then
   reads `/sitemap.xml` and nested sitemap indexes two levels deep; a host
   without a sitemap is walked from `/` along its own links, three links
   deep. Pages already mirrored are fetched again too. At most 200 pages per
   run, one request per second per host; a run cut short at the limit is
   marked so. Each page becomes a trusted `sources/web/<host>/` item with its
   content hash; an unchanged page is left alone, a page that answers 404 or
   410 is retired (text kept), and a page that looks like it holds a
   credential is skipped, never stored. One commit by Pat: `Import website:
<n> pages`. The import needs at least one exact Support website.

5. A `reviewBy` date in the past makes an item `needs-check`; the day itself
   still counts as active.
6. The run happens daily, after a push to the default branch, and on demand
   from the Knowledge page. The daily run re-fetches trusted pages, re-checks
   dependent paths and re-runs the conflict check on changed items; an hourly
   tick starts it for each project whose last full run is a day old (a failed
   run is tried again the next hour). A push re-checks only what depends on
   the code repository, a minute after the first push (later pushes in that
   minute ride along). One run per project goes at a time; a request while
   another waits to start joins it. Nothing runs while email support is off.
   The small model may
   draft updated text for a `needs-check` item; a person still approves it.
7. Only fresh, trusted, active items back a reply. Anything else makes the
   draft wait for a person with "Knowledge may be out of date: <article
   title>".

## Using it

The support agent has two tools, only in a support session:
`search_knowledge(query)` (ranked, this project only) and
`read_knowledge(path)`. Both print the knowledge commit they read, and a draft
cites an item as `knowledge:<path>@<commit>`. Search only lists items;
`read_knowledge` prints an item's trust, status, any check note and the ref to
cite first, then its text inside a wrapper the text can't close. An item that
can't back a reply says so next to its ref ("can't back a reply alone").

When an agent's draft is checked, and again when it is about to be sent
automatically (at the end of the veto window and on every retry), the server
checks each knowledge citation. A person sending a draft is not gated. The
draft waits for a person when:

- the citation names nothing in knowledge: a path that isn't an item at the
  cited commit, or a commit that isn't in the repository ("Not found in
  knowledge");
- the item changed after the agent read it ("Changed since the agent read
  it");
- it is reference material ("Reference material, not approved for replies");
- it is `needs-check` (its check reason), past its review date ("Review date
  passed (<date>)") or `retired` ("Retired");
- a default-branch commit after its `validAsOfCommit` (or from its
  `validAsOf` day on) touches one of its `repo:` dependencies ("<path> changed
  in <sha>"), read from the local `origin/<default branch>` with no fetch at
  send time, or an `issue:`/`pr:` dependency closed or merged after
  `validAsOf`, read from GitHub without the cache ("Issue #42 was closed").
  Changed pages and new releases are left to the daily run;
- this session didn't open it with `read_knowledge` ("This session didn't read
  it"); a search listing is not enough;
- the session read an item that can't back a reply and the draft doesn't cite
  it: the reply may rest on it, so it waits too (that item's reason), whatever
  else the draft cites;
- the knowledge service, the index, the code repository or GitHub can't answer
  ("Knowledge couldn't be checked"). This also applies to a draft that cites
  nothing on a project that has a knowledge repository: the server never sends
  on data it couldn't check;
- the draft contains 12 or more consecutive words of an `internal` article
  ("The reply quotes an internal note").

The headline people see on such a draft is "Knowledge may be out of date:
<article title>" (or the internal-note line), with the reasons per citation
underneath.

## Customer data

Mail is stripped before anything is committed: addresses, the customer's
display-name tokens, phone numbers and long tokens or secrets. When the strip
can't show the text is clean, the pair is skipped. Items taken from a
conversation stay after the conversation's retention ends, since they hold no
customer data.

## Erasure

Deleting or retiring an item is a normal commit; history keeps it. The
credential check and the mail strip prevent the common leak. If something that
must not be kept reaches a knowledge repository anyway, an operator removes it
by hand, as for memory:

1. Stop the server, or turn email support off and restart, so nothing writes
   to knowledge.
2. Rewrite history in a clone of `repos/knowledge-<project>.git` (for example
   with `git filter-repo`), then replace the bare repository with the
   rewritten one.
3. Delete `repo-work/knowledge-<project>`. There is no remote to force-push
   and no session checkout to delete.
4. Delete `knowledge-index.sqlite` so it rebuilds, and start the server.

Agents never rewrite history, and the server has no button for it. Remember
the server state directory backups: they hold the old history too.
