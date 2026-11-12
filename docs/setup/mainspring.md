# Mainspring

Mainspring is a self-hosted
gateway that pools Claude, Codex and other subscriptions behind one
Anthropic- and OpenAI-compatible endpoint. With it connected, Claude turns run
on the accounts in Mainspring instead of the Claude accounts connected to this
server, and any model Mainspring serves can run as `pi/mainspring/<model>`.

Mainspring picks the account for each request. This server sends each
session's id with every request, so Mainspring keeps a session on one account
and its prompt cache stays warm.

## Set it up

You need Mainspring running somewhere this server can reach, for example
`https://mainspring.example.test`.

1. In Mainspring, open **Keys** and create a key for this server. It starts
   with `sk-ms-`. Mainspring shows it once.
2. Here, as the instance owner, open **Settings → Providers → Mainspring**.
3. Enter Mainspring's address (`https://mainspring.example.test`, with or
   without `/v1`) and paste the key. Choose **Save**.
4. Choose **Test**. It calls `GET /v1/models` with the key and lists the
   models Mainspring serves.
5. Turn on **Route Claude through Mainspring**.

New turns pick up the change; running turns finish where they started.

## What the settings do

| Setting                         | Effect                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Address                         | `https://` anywhere. Plain `http://` only for a tailnet, private or loopback host (`*.ts.net`, `100.64.0.0/10`, RFC 1918, `localhost`), because the key travels in a header. A new host needs the key pasted again.            |
| Key                             | Stored as a workspace secret. Only its last four characters are ever shown.                                                                                                                                                    |
| Route Claude through Mainspring | `pi/anthropic/*` turns go to `<address>/v1/messages` with the key. The Claude account walk and OAuth binding are skipped. Off by default.                                                                                      |
| Fall back to direct accounts    | When Mainspring can't serve a Claude turn (429, 401, 502/503), the turn moves to the Claude accounts connected here and says so. Off by default: without it, the turn ends with Mainspring's error and nothing moves silently. |
| Models                          | What the last **Test** listed. They appear in the model picker as `pi/mainspring/<model>`. While Claude is routed through Mainspring, Claude models stay under their usual names.                                              |

A session pinned to one subscription (`fixedSubscription`) keeps its pinned
account: Mainspring can't honour the pin.

## Models

- `pi/anthropic/<model>` with the switch on, and `pi/mainspring/claude-…`,
  use Mainspring's Anthropic Messages endpoint. Pricing, limits and thinking
  levels come from the same Claude model table direct turns use.
- Any other `pi/mainspring/<model>` (Codex/GPT, Grok, …) uses Mainspring's
  OpenAI Chat Completions endpoint at `<address>/v1/chat/completions`, with
  the context size Mainspring lists for it.

## Session affinity

Every request carries the session id twice:

- `X-Session-ID: <session>` as a header, on both endpoints.
- `metadata.user_id: <session>` in the Anthropic Messages body.

Mainspring keeps a session on the account it last used while the session
sends a request within its affinity window (an hour by default).

## Errors

| Mainspring answers | The turn                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `429`              | A usage limit: "Every Claude account in Mainspring is resting until …", with `Retry-After` as the time. The model fallback takes over as it does for an exhausted local pool. A key's used-up daily cap is a usage limit too, with its own message. |
| `401`              | "Mainspring key was refused." The turn stops; paste a new key.                                                                                                                                                                                      |
| `502`, `503`       | A retryable provider error: pi retries, then the model fallback treats it as transient.                                                                                                                                                             |

## Who served a turn

With **Share pool with keys** on in Mainspring (its default), each answer says
which account served it. The turn's audit line (`pi_turn`, `direction: "out"`)
then carries `via: "mainspring"`, `mainspring_account`, `mainspring_provider`
and `mainspring_limits`, plus `mainspring_moved_from` and
`mainspring_moved_reason` when Mainspring just moved the session. The key is
never logged.

## Where it is stored

The settings live in `~/.opensession/model-providers.json` (mode 0600) under
`mainspring`:

```json
{
  "mainspring": {
    "url": "https://mainspring.example.test",
    "keyRef": "wssec-…",
    "keyHint": "wxyz",
    "routeClaude": true,
    "fallbackDirect": false,
    "models": {
      "at": "2026-11-12T10:00:00.000Z",
      "models": { "claude-sonnet-5-5": { "id": "claude-sonnet-5-5" } }
    }
  }
}
```

The key itself is in `~/.opensession/workspace-secrets.json` under `keyRef`.
Edit these through Settings; the API is
`GET`/`PUT /api/settings/mainspring`, `DELETE /api/settings/mainspring/key`
and `POST /api/settings/mainspring/test`, all owner only.

## Not yet

- Account headroom from Mainspring's `GET /v1/pool` in Settings → Providers.
- Mainspring's MCP `web_search` and `web_fetch`. Web search keeps its own
  setting under Settings → Models; a Claude side request follows the routing
  switch.

`src/server/mainspring.ts` exports `mainspringConfig()` and
`mainspringFetch()` for that work.
