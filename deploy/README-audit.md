# Open Session audit logs

Open Session writes security, agent-run, and operational audit events as JSONL
(`packages/core/opensession-server/src/server/audit.ts`): one JSON object per
line in a daily UTC `audit-YYYY-MM-DD.jsonl` file. Every event gets an ISO
timestamp and `service: "opensession"`; the remaining fields depend on the
emitter.

## Location and retention

On a fresh installation, logs are under the Open Session service user's
`~/.opensession/audit/`. An upgraded installation continues using
`~/.opensession-audit/` when that legacy directory exists and the new directory
does not. With `OPENSESSION_STATE_DIR` set, the directory is
`$OPENSESSION_STATE_DIR/.opensession-audit/`. These rules come from
`packages/core/opensession-server/src/server/paths.ts`. Use
`systemctl cat opensession` to identify the installed service user and
`EnvironmentFile`, then inspect that environment file before configuring a file
collector.

The server prunes dated local files after 400 days. The example CloudWatch
configuration uses the same retention.

## What gets logged

All production model turns run through Pi
(`packages/core/opensession-server/src/server/pi-runner.ts`). Current runner
events include:

- `pi_turn` `in` and `out` events mark each attempt. They carry request and run
  identity, run kind, model, and mode. Input events include a bounded prompt
  summary and, for unattended runs, denied tools. Output events include the
  outcome, duration, usage, cost, or error when available. An early setup
  failure can produce only an `out` event. Retries and account or model
  fallbacks can produce multiple attempts for one logical turn.
- `pi_gate_denied` when the run-kind gate refuses a turn. Account switches and
  queued, injected, retracted, or undelivered steering are also recorded.
- `pi_mcp_call` for each bridged MCP call, with server, tool, outcome, and
  duration. Arguments and results are not included.
- Paired `pi_command_start` / `pi_command_finish` events for each local bash
  command that reaches execution. These contain a full SHA-256, byte count,
  safe command category, timeout, parseable literal `sleep` totals, duration,
  and outcome. They do not contain command text or output. A separate
  `command_policy` denial event can include up to 300 characters of the
  rejected command.
- `session_turn_metric` for the settled logical turn, plus audit events from
  authentication, setup, session state, agents, sandboxes, and other sensitive
  server operations.

Text-bearing runner events use a full SHA-256, UTF-8 byte count, and a bounded
snippet (normally 300 characters). This is not a complete copy of the engine
transcript or every local tool call. Use the on-disk engine transcript when the
full authorized record is required.

Audit writes are best-effort: a write failure is reported to journald but does
not fail the run it was observing.

## Reading locally

The read-only viewer is at **Settings → Audit log**. It reads the same daily
files, shows newest events first, and defaults to hiding noisy historical
turn-stream events. The authenticated `GET <base-path>/api/audit/digest` endpoint
returns yesterday's UTC log as a compact roll-up; pass `?date=YYYY-MM-DD`, and
optionally `&section=name,name`, for another day or selected sections.

For raw local queries, point `jq` at the resolved directory described above:

```bash
jq -c 'select(.msg == "pi_turn" and .direction == "out")' \
  /absolute/audit-dir/audit-YYYY-MM-DD.jsonl
```

## Shipping to CloudWatch (optional, one-time setup, needs admin)

The Open Session systemd unit denies access to EC2 IMDS
(`opensession.service`), so it cannot obtain instance-role credentials from
IMDS. A standalone amazon-cloudwatch-agent service can use the instance role and
tail the files instead.

`deploy/cloudwatch-agent-opensession.json` ships to `/opensession/prod` and sets
400-day retention. Its `/var/lib/opensession/audit/` `file_path` is an example,
not the application default. Before starting the agent, replace `file_path` with
the resolved absolute audit path and choose the desired log group. The path must
end in `audit-*.jsonl`.

Pre-create the log group when possible. The agent role needs
`logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DescribeLogStreams`, and
`logs:DescribeLogGroups`. The example's `retention_in_days` also requires
`logs:PutRetentionPolicy`; add `logs:CreateLogGroup` if the group is not
pre-created. Scope resource-level permissions to this log group where AWS
supports it.

Then install and start the agent on the host:

```bash
wget https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/$(dpkg --print-architecture)/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb
sudo cp deploy/cloudwatch-agent-opensession.json \
  /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/opensession.json
sudoedit /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/opensession.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/opensession.json
```

Verify from a shell with AWS read access. The agent ships to the instance's own
region; replace `/opensession/prod` if you changed the group:

```bash
aws logs tail /opensession/prod --region <instance-region> --since 10m
```

## CloudWatch Logs Insights examples

```text
# Completed Pi attempts and recorded cost by run kind
filter msg = "pi_turn" and direction = "out" and ispresent(total_cost_usd)
| stats count(*) as attempts, sum(total_cost_usd) as cost_usd by run_kind

# Audited MCP calls and local bash command events for one session
filter (msg = "pi_mcp_call" and session = "...") or
       (msg in ["pi_command_start", "pi_command_finish"] and session_id = "...")
| sort @timestamp asc
| display @timestamp, msg, server, tool, command_kind, command_sha256, outcome, ok, duration_ms, ms
```
