import { mkdirSync } from "fs";
import type { RunAgentOpts } from "./agent-runner";
import { audit } from "./audit";
import { readModelProviderConfig } from "./model-providers";
import { pickAccount as pickClaudeCliAccount } from "./claude-accounts";
import { pickOpenaiAccount } from "./openai-auth";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import type { RemoteWorkspace } from "./remote-workspace";
import { PI_STATE_DIR } from "./pi-common";
import { piBashHomeEnv } from "./pi-bash-tool";
import { sessionOwnershipEnv } from "./session-ownership";

export function piCliPoolEnv(input: {
  opts: RunAgentOpts;
  remote: RemoteWorkspace | undefined;
  accountUser: string | undefined;
  runKey: string;
}): Record<string, string> {
  const { opts, remote, accountUser, runKey } = input;
  const { journal } = opts;
  // Optional pool credentials for tools the run itself spawns (currently
  // deepsec's Claude Agent SDK and Codex CLI workers). These are explicit
  // additions to the minimal environment, never inherited server secrets.
  const cliEnv: Record<string, string> = {};
  // Pool credentials never go into a Sandbox command.
  if (opts.claudeCliEnv && !remote) {
    const cliAccount = pickClaudeCliAccount(
      undefined,
      accountUser,
      undefined,
      opts.usageCredits,
    );
    if (cliAccount) {
      const cliCfgDir = `${PI_STATE_DIR}/cli/claude/${cliAccount.id}`;
      mkdirSync(cliCfgDir, { recursive: true, mode: 0o700 });
      cliEnv.CLAUDE_CODE_OAUTH_TOKEN = cliAccount.token;
      cliEnv.CLAUDE_CONFIG_DIR = cliCfgDir;
      audit({
        msg: "claude_cli_env_account",
        run_kind: journal?.kind,
        session_id: journal?.osSessionId,
        account: cliAccount.name,
        account_id: cliAccount.id.slice(0, 8),
        engine: "pi",
      });
    } else {
      console.warn(
        "[pi-runner] claudeCliEnv requested but no usable Claude account in the pool; run proceeds without it",
      );
    }
  }
  if (opts.codexCliEnv && !remote) {
    const cfg = readModelProviderConfig();
    const picked = pickOpenaiAccount(
      "",
      cfg?.openaiAccounts,
      journal?.osSessionId || runKey,
      undefined,
      accountUser,
    );
    if ("error" in picked) {
      console.warn(
        `[pi-runner] codexCliEnv requested but no usable Codex account (${picked.error}); run proceeds without it`,
      );
    } else {
      Object.assign(
        cliEnv,
        picked.kind === "home"
          ? { CODEX_HOME: picked.value }
          : { OPENAI_API_KEY: picked.value },
      );
      audit({
        msg: "codex_cli_env_account",
        run_kind: journal?.kind,
        session_id: journal?.osSessionId,
        account: picked.name,
        account_id: picked.id.slice(0, 8),
        engine: "pi",
      });
    }
  }
  return cliEnv;
}

export async function buildPiBashEnv(input: {
  opts: RunAgentOpts;
  remote: RemoteWorkspace | undefined;
  runKey: string;
  hostGithubLogin: boolean;
  agentGitEnv: Record<string, string>;
  githubEnv: Record<string, string>;
  cliEnv: Record<string, string>;
}): Promise<Record<string, string>> {
  const {
    opts,
    remote,
    runKey,
    hostGithubLogin,
    agentGitEnv,
    githubEnv,
    cliEnv,
  } = input;
  // Minimal bash env, the security invariant this engine hangs on. The
  // server env is NEVER inherited; every entry is explicit.
  // The AWS session file lives on this machine; a Sandbox never gets one.
  const awsEnv = opts.aws && !remote ? await ensureAgentAwsCredsFile() : {};
  const homeEnv = piBashHomeEnv({
    runKey,
    scratchDir: opts.scratchDir,
    isolated: Boolean(opts.publicationPolicy),
    hostHome: process.env.HOME,
    hostGithubLogin,
  });
  if (!remote && opts.publicationPolicy && homeEnv.HOME)
    mkdirSync(homeEnv.HOME, { recursive: true, mode: 0o700 });
  if (!remote && homeEnv.GH_CONFIG_DIR)
    mkdirSync(homeEnv.GH_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const bashEnv: Record<string, string> = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...homeEnv,
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    // Session-scoped scratch (session-scratch.ts): temp files follow the
    // session's lifecycle instead of accumulating in shared /tmp.
    ...(opts.scratchDir
      ? { TMPDIR: opts.scratchDir, OPENSESSION_SCRATCH: opts.scratchDir }
      : {}),
    ...agentGitEnv,
    ...githubEnv,
    ...awsEnv,
    ...cliEnv,
    // OPENSESSION_SESSION_ID, and the container shims first on PATH, so
    // what the agent leaves running stops with the session
    // (session-ownership.ts).
    ...sessionOwnershipEnv(opts.journal?.osSessionId, process.env.PATH, {
      shims: !remote,
    }),
  };
  return bashEnv;
}
