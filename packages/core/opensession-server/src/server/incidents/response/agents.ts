// The incident's agents: one built-in, disabled automation per project that
// owns them, one coordinator session per incident that parents them (it runs
// no turn), and the investigator and verifier as durable child sessions
// through the workflow session controller. Each child runs under plan 3's
// descendant policy, built from the access resolved for it
// (incidentDescendantPolicy) and passed through the controller's server-only
// argument; session creation re-resolves that access before the session
// exists. In This machine (container) the child asks for that sandbox by
// name; on the host path its policy names the incident agent user its bash
// runs as (host-agents.ts). Children never report back into the
// coordinator: the coordinator reads their status and final text, and
// what each child's run is bound to, so a child another session took over
// from is archived.
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { $ } from "bun";
import type { AgentAccess } from "../../../shared/incident-access";
import type {
  AgentRole,
  AgentWorkspace,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type {
  WorkflowAutomationSessionPolicy,
  WorkflowSessionState,
} from "../../../shared/workflow-types";
import {
  type Automation,
  createAutomation,
  listAutomations,
  saveAutomation,
} from "../../automations";
import { newSessionId } from "../../paths";
import { type PrInfo, getPrsByRepo } from "../../pr-cache";
import {
  type SessionControl,
  type SessionSummary,
  getSessionControl,
} from "../../session-control";
import { updateSessionFile } from "../../session-cache";
import type { AutomationDescendantPolicy } from "../../types";
import {
  type WorkflowSessionControllerDeps,
  branchPushed,
  createWorkflowSessionController,
  hasUncommittedChanges,
} from "../../workflow-sessions";
import { getRepo } from "../../worktree";
import type { IncidentRunBound } from "../access/resolve";
import {
  incidentDescendantPolicy,
  incidentRunBound,
} from "../access/session-policy";
import { startIncidentAccessGate } from "./access-gate";
import { patchProjectSettings } from "./project-settings";

const CREATED_BY = "Sessions (incidents)";
const MAX_DEPTH = 2;
const SUMMARY_CHARS = 120;

export function incidentAutomationName(project: string): string {
  return `Incidents · ${project}`;
}

/** The fields the incident automation always has. */
function automationShape(project: string) {
  return {
    enabled: false,
    schedule: "",
    mode: "code" as const,
    repo: project,
    mcpServers: [] as string[],
    workflows: true,
    workflowSessions: true,
    workflowSessionRepos: [project],
    workflowSessionRunners: [] as string[],
    webhookEnabled: false,
  };
}

function drifted(a: Automation, project: string): boolean {
  const want = automationShape(project);
  const same = (x: unknown, y: unknown) =>
    JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  return (
    a.enabled !== want.enabled ||
    (a.schedule || "") !== want.schedule ||
    !!a.runOnceAt ||
    a.webhookEnabled !== false ||
    !same(a.mcpServers, want.mcpServers) ||
    a.workflows !== true ||
    a.workflowSessions !== true ||
    !same(a.workflowSessionRepos, want.workflowSessionRepos) ||
    !same(a.workflowSessionRunners, want.workflowSessionRunners)
  );
}

export interface AutomationStore {
  list(): Promise<Automation[]>;
  create(
    input: Parameters<typeof createAutomation>[0],
  ): Promise<Automation | { error: string }>;
  save(a: Automation): Promise<void>;
}

const liveStore: AutomationStore = {
  list: listAutomations,
  create: createAutomation,
  save: saveAutomation,
};

/**
 * The project's incident automation, created on first use. Disabled, with
 * no schedule, webhook or MCP servers, it never runs as an automation; it
 * exists so incident agents have a settings-owned owner. A copy a person
 * edited is put back. Each agent's connections come from its access, never
 * from this automation.
 */
export async function ensureIncidentAutomation(
  project: string,
  store: AutomationStore = liveStore,
): Promise<Automation> {
  let a = (await store.list()).find(
    (x) => x.incidentResponse?.project === project,
  );
  if (!a) {
    const created = await store.create({
      name: incidentAutomationName(project),
      prompt: `Incident response for ${project}. Sessions starts these sessions itself; do not run this automation by hand.`,
      createdBy: CREATED_BY,
      ...automationShape(project),
    });
    if ("error" in created)
      throw new Error(
        `Could not create the incident automation: ${created.error}`,
      );
    a = { ...created, incidentResponse: { project } };
    await store.save(a);
  } else if (drifted(a, project)) {
    const { runOnceAt: _runOnceAt, ...rest } = a;
    a = { ...rest, ...automationShape(project), incidentResponse: { project } };
    await store.save(a);
  }
  const id = a.id;
  await patchProjectSettings(project, (s) =>
    s.automationId === id ? s : { ...s, automationId: id },
  );
  return a;
}

/** The controller's own repo and Runner check. The child's real policy is
 *  plan 3's, built from its access. */
export function incidentSessionPolicy(
  automation: Automation,
): WorkflowAutomationSessionPolicy {
  return {
    automationId: automation.id,
    automationName: automation.name,
    allowedRepos: [
      automation.incidentResponse?.project ?? automation.repo ?? "",
    ],
    allowedRunners: [],
  };
}

export interface AgentLive {
  status: WorkflowSessionState;
  costUsd: number;
  tokens: number;
  prUrl?: string;
  error?: string;
}

export interface AgentDeps {
  control: SessionControl;
  writeSessionFile: typeof updateSessionFile;
  repo: (id: string) => { path: string; defaultBranch: string };
  newSessionId: () => string;
  now: () => number;
  /** Archive a session the way a person does from the sidebar. */
  archive: (id: string, session: SessionSummary) => Promise<unknown>;
  /** The commit checked out in a host worktree; undefined when unreadable. */
  worktreeHead: (dir: string) => Promise<string | undefined>;
  /** The pull request the PR cache holds for a branch of a repo. */
  pullRequest: (
    repoId: string,
    branch: string,
  ) => Pick<PrInfo, "url" | "state" | "createdAt"> | undefined;
  controllerDeps?: Partial<WorkflowSessionControllerDeps>;
}

function agentDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    control: over.control ?? getSessionControl(),
    writeSessionFile: over.writeSessionFile ?? updateSessionFile,
    repo:
      over.repo ??
      ((id) => {
        const r = getRepo(id);
        return { path: r.repo, defaultBranch: r.defaultBranch };
      }),
    newSessionId: over.newSessionId ?? newSessionId,
    now: over.now ?? Date.now,
    archive:
      over.archive ??
      (async (id, session) =>
        (await import("../../session-archive")).archiveSession(id, session)),
    worktreeHead:
      over.worktreeHead ??
      (async (dir) => {
        const out = await $`git -C ${dir} rev-parse HEAD`.nothrow().quiet();
        const sha = out.exitCode === 0 ? out.stdout.toString().trim() : "";
        return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
      }),
    pullRequest:
      over.pullRequest ??
      ((repoId, branch) => getPrsByRepo().get(repoId)?.get(branch)),
    ...(over.controllerDeps ? { controllerDeps: over.controllerDeps } : {}),
  };
}

/**
 * The incident's coordinator session: the parent every agent is spawned
 * under (the session controller's ownership, spawn depth and automation
 * policy hang off it). Reused while it exists; otherwise written as an ask
 * session of the incident automation, when the incident's first agent
 * starts. It runs no turn: coordination is server code, so its transcript
 * stays empty and its children hold the work.
 */
export async function ensureCoordinatorSession(
  incident: Incident,
  automation: Automation,
  deps: Partial<AgentDeps> = {},
): Promise<string> {
  const d = agentDeps(deps);
  const existing = incident.response?.coordinatorSessionId;
  if (existing && d.control.getSession(existing)) return existing;
  const repo = d.repo(incident.project);
  const id = d.newSessionId();
  const at = new Date(d.now()).toISOString();
  await d.writeSessionFile(id, () => ({
    id,
    claudeSessionId: "",
    branch: repo.defaultBranch,
    worktreeDir: repo.path,
    createdBy: `${automation.name} (automation)`,
    createdAt: at,
    lastActivity: at,
    title: `Incident · ${incident.title}`,
    mode: "ask",
    repo: incident.project,
    automation: automation.name,
    automationId: automation.id,
    spawnDepth: 0,
  }));
  return id;
}

export interface SpawnAgentInput {
  role: AgentRole;
  round: number;
  attempt: number;
  prompt: string;
  model: string;
  /** The investigator's session, for a code-mode agent to branch from. */
  baseSessionId?: string;
  access: AgentAccess;
  workspace: AgentWorkspace;
}

export interface SessionWork {
  branch: string;
  checkpoint?: { ref: string; head: string };
}

export interface IncidentAgents {
  /** Start an agent session. It takes a branch the way every session does
   *  (session-control-wiring: named from the prompt, unique in the repo). */
  spawn(i: SpawnAgentInput): Promise<{ sessionId: string; branch: string }>;
  /** A session's branch and Sandbox checkpoint, from the session store;
   *  undefined when the session is gone. */
  work(id: string): Promise<SessionWork | undefined>;
  /** The last commit the session's own work reached: its Sandbox
   *  checkpoint's branch tip, or a host worktree's HEAD. Undefined when it
   *  can't be told. */
  head(id: string): Promise<string | undefined>;
  /** Whether a fresh session may branch from this one (`baseSessionId`):
   *  the controller's own checks, its branch pushed at its last commit and
   *  nothing left uncommitted. False when they can't be read. */
  stackable(id: string): Promise<boolean>;
  status(id: string): Promise<AgentLive>;
  /** What the session has cost so far, every turn in it counted (a
   *  person's own turns too); undefined when the session is gone. Cheap: it
   *  reads the session store only. */
  usage(id: string): Promise<{ costUsd: number; tokens: number } | undefined>;
  finalText(id: string, since: string): Promise<string | undefined>;
  send(id: string, message: string, requestId: string): Promise<void>;
  cancel(id: string, requestId: string): Promise<void>;
  /** What the agent's run is bound to (connections, mode, spawn
   *  snapshot); undefined when its session or binding is gone. */
  bound(id: string): Promise<IncidentRunBound | undefined>;
  /** Archive an agent's session another one took over from; one already
   *  archived is left alone. */
  retire(id: string): Promise<void>;
}

function summarise(entry: TranscriptEntry): string {
  const input =
    entry.toolInput && typeof entry.toolInput === "object"
      ? (entry.toolInput as Record<string, unknown>)
      : {};
  const pick = [input.command, input.path, input.file_path, input.url].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return (pick ?? entry.toolName ?? "tool").slice(0, SUMMARY_CHARS);
}

/** An agent's recent tool calls, each with a short summary of its input. */
export async function agentToolCalls(
  sessionId: string,
  limit: number,
  control: SessionControl = getSessionControl(),
): Promise<Array<{ at: string; tool: string; summary: string }>> {
  const tail = await control.transcriptTail(sessionId, limit);
  return tail
    .filter((e) => e.type === "tool_use")
    .map((e) => ({
      at: e.timestamp,
      tool: e.toolName ?? "tool",
      summary: summarise(e),
    }));
}

/** A pull request opened on a branch at most this long before its session
 *  started still counts as the session's: the two clocks differ. */
const PR_CLOCK_SKEW_MS = 60_000;

/**
 * The pull request an agent opened from its own session branch. An agent
 * opens it with `gh pr create`, which writes nothing to its session, so it is
 * looked up the way the session list finds a session's PR: in the PR cache,
 * by the session's repo and branch (a webhook puts a new PR there within
 * seconds). A closed one does not count, nor one opened before the session
 * started: an older release gave two incidents' agents one branch.
 */
function ownPullRequest(
  d: AgentDeps,
  session: SessionSummary | undefined,
): string | undefined {
  const branch = session?.branch;
  const repoId = session?.repo;
  if (!session || !branch || !repoId) return undefined;
  let defaultBranch: string | undefined;
  try {
    defaultBranch = d.repo(repoId).defaultBranch;
  } catch {
    return undefined;
  }
  if (branch === defaultBranch) return undefined;
  const pr = d.pullRequest(repoId, branch);
  if (!pr?.url || pr.state === "CLOSED") return undefined;
  const opened = Date.parse(pr.createdAt);
  const started = Date.parse(session.createdAt);
  if (opened < started - PR_CLOCK_SKEW_MS) return undefined;
  return pr.url;
}

export function createIncidentAgents(
  incident: Incident,
  ctx: { coordinatorSessionId: string; automation: Automation },
  deps: Partial<AgentDeps> = {},
): IncidentAgents {
  // The kill switch and budget refuse every incident agent from here on.
  startIncidentAccessGate();
  const d = agentDeps(deps);
  const controller = createWorkflowSessionController({
    parentSessionId: ctx.coordinatorSessionId,
    user: ctx.automation.name,
    allowSpawning: true,
    automationSessionPolicy: incidentSessionPolicy(ctx.automation),
    maxDepth: MAX_DEPTH,
    reportBack: false,
    deps: { ...d.controllerDeps, control: d.control },
  });
  // After a restart the controller knows nothing it spawned: adopt every
  // recorded agent that is still this coordinator's child.
  for (const run of incident.response?.agents ?? []) {
    const session = run.sessionId
      ? d.control.getSession(run.sessionId)
      : undefined;
    if (session?.parentSessionId === ctx.coordinatorSessionId)
      controller.adopt({
        id: session.id,
        url: "",
        repo: session.repo || incident.project,
        branch: session.branch || "",
        parentSessionId: session.parentSessionId,
      });
  }

  return {
    async spawn(input) {
      const { access, workspace } = input;
      if (access.incidentId !== incident.id || access.role !== input.role)
        throw new Error("The access is not for this incident and role");
      const code = access.mode === "code";
      const spawned = await controller.spawn(
        {
          prompt: input.prompt,
          repo: incident.project,
          mode: access.mode,
          model: input.model,
          // An ask child cannot hold an isolated worktree; the verifier
          // reads the candidate from its pull request.
          ...(code
            ? {
                workspace: {
                  type: "isolated-worktree" as const,
                  ...(input.baseSessionId
                    ? { baseSessionId: input.baseSessionId }
                    : {}),
                },
              }
            : {}),
        },
        `incident:${incident.id}:r${input.round}:${input.role}:a${input.attempt}`,
        {
          descendantPolicy: (base): AutomationDescendantPolicy => {
            const policy = incidentDescendantPolicy(access, base);
            return workspace.kind === "host"
              ? { ...policy, hostAgentUser: workspace.user }
              : policy;
          },
          // This machine (container) may be chosen without being the
          // session default, so the child asks for it by name; any other
          // sandbox is the project's default and the session resolves it
          // the same way.
          ...(workspace.kind === "sandbox" && workspace.provider === "podman"
            ? { sandbox: "podman" as const }
            : {}),
        },
      );
      return { sessionId: spawned.id, branch: spawned.branch };
    },

    async work(id) {
      const session = d.control.getSession(id);
      if (!session) return undefined;
      const checkpoint = session.sandboxCheckpoint;
      return {
        branch: session.branch || "",
        ...(checkpoint?.ref && checkpoint.head
          ? { checkpoint: { ref: checkpoint.ref, head: checkpoint.head } }
          : {}),
      };
    },

    async head(id) {
      const session = d.control.getSession(id);
      if (!session) return undefined;
      const checkpoint = session.sandboxCheckpoint?.head;
      if (checkpoint) return checkpoint;
      // A sandboxed session's host worktree is not where it works.
      const provider = session.sandbox?.provider;
      if ((provider && provider !== "local") || !session.worktreeDir)
        return undefined;
      return d.worktreeHead(session.worktreeDir).catch(() => undefined);
    },

    async stackable(id) {
      const session = d.control.getSession(id);
      if (!session?.branch) return false;
      const pushed = d.controllerDeps?.branchPushed ?? branchPushed;
      const dirty =
        d.controllerDeps?.hasUncommittedChanges ?? hasUncommittedChanges;
      try {
        return (await pushed(session)) && !(await dirty(session));
      } catch {
        return false;
      }
    },

    async status(id) {
      const s = await controller.status(id);
      const prUrl = s.prUrl || ownPullRequest(d, d.control.getSession(id));
      return {
        status: s.status,
        costUsd: s.costUsd ?? 0,
        tokens: s.tokens ?? 0,
        ...(prUrl ? { prUrl } : {}),
        ...(s.error ? { error: s.error } : {}),
      };
    },

    async usage(id) {
      const usage = d.control.getSession(id)?.usage;
      if (!usage) return undefined;
      return {
        costUsd: usage.costUsd,
        tokens:
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadTokens +
          usage.cacheCreationTokens,
      };
    },

    async finalText(id, since) {
      const after = Date.parse(since);
      const tail = await d.control.transcriptTail(id, 50);
      for (let i = tail.length - 1; i >= 0; i--) {
        const e = tail[i]!;
        if (
          e.type === "assistant" &&
          !e.isReasoning &&
          Date.parse(e.timestamp) > after
        )
          return e.content;
      }
      return undefined;
    },

    async send(id, message, requestId) {
      await controller.send(id, message, requestId);
    },

    async bound(id) {
      const session = d.control.getSession(id);
      return (session && incidentRunBound(session)) ?? undefined;
    },

    async retire(id) {
      const session = d.control.getSession(id);
      if (session && !session.archived && session.state !== "archived")
        await d.archive(id, session);
    },

    async cancel(id, requestId) {
      try {
        await controller.cancel(id, requestId);
      } catch (error) {
        // An agent that is already idle has nothing to cancel.
        if (
          !(error instanceof Error) ||
          !error.message.includes("could not be cancelled")
        )
          throw error;
      }
    },
  };
}
