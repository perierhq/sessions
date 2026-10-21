import { useAgentAudit } from "../../hooks/useIncidents";
import { useIsPhone } from "../../hooks/useIsPhone";
import type { AgentAuditAgent } from "../../lib/api/incidents";
import { formatUsd } from "../../lib/incidents/copy";
import { AUDIT_ROW, AUDIT_SECTION_LABEL } from "../../lib/incident-classes";
import { clockTime } from "../../lib/time";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { DetailKey } from "../../ui/detail-key";
import { ResponsiveDialog } from "../../ui/sheet";
import { InlineAlert, ListSkeleton } from "../../ui/state";
import { IconX } from "../icons";
import type { LedgerEntry } from "../../../shared/incident-response";

const TITLE = "What the agents did";
/** Tool calls shown per agent, newest last. */
const TOOL_CALLS_SHOWN = 8;

const ACTOR: Record<LedgerEntry["actor"], string> = {
  sessions: "Sessions",
  investigator: "Investigator",
  verifier: "Verifier",
  owner: "You",
};

const ROLE: Record<AgentAuditAgent["role"], string> = {
  investigator: "Investigator",
  verifier: "Verifier",
};

function Agent({
  agent,
  onOpen,
}: {
  agent: AgentAuditAgent;
  onOpen: () => void;
}) {
  const meta = [
    agent.model,
    agent.independenceLabel,
    agent.access,
    formatUsd(agent.costUsd),
  ].filter(Boolean);
  const calls = agent.toolCalls.slice(-TOOL_CALLS_SHOWN);
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-item-title font-medium text-fg">
          {ROLE[agent.role]} · round {agent.round}
        </span>
        <Button
          size="sm"
          variant="soft"
          className="phone:min-h-11"
          onClick={onOpen}
        >
          Open session
        </Button>
      </div>
      <p className="m-0 text-meta text-dim [overflow-wrap:anywhere]">
        {meta.join(" · ")}
      </p>
      {agent.workspace.kind === "host" && (
        <p className="m-0 text-meta text-yellow">{agent.workspaceLabel}</p>
      )}
      {calls.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {calls.map((call, i) => (
            <li key={`${call.at}:${i}`} className={AUDIT_ROW}>
              <DetailKey>{clockTime(call.at)}</DetailKey>
              <span className="min-w-0 text-label text-fg [overflow-wrap:anywhere]">
                <span className="font-medium">{call.tool}</span>{" "}
                <span className="text-dim">{call.summary}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * "What the agents did" (spec 3.8): the incident's ledger, newest first,
 * then each agent with its model, independence, access, cost and last tool
 * calls. Loads only while open.
 */
export function AgentAuditSheet({
  incidentId,
  open,
  onClose,
  onOpenSession,
}: {
  incidentId: string;
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const phone = useIsPhone();
  const audit = useAgentAudit(open ? incidentId : null);
  const data = audit.data;
  const ledger = data ? [...data.ledger].reverse() : [];
  const empty = !data || (ledger.length === 0 && data.agents.length === 0);

  let body: React.ReactNode;
  if (audit.error)
    body = (
      <InlineAlert onRetry={() => void audit.mutate()}>
        Couldn't load what the agents did
      </InlineAlert>
    );
  else if (data === undefined)
    body = <ListSkeleton variant="bare" rows={4} label={`Loading ${TITLE}`} />;
  else if (empty)
    body = <p className="m-0 text-body text-faint">Nothing yet</p>;
  else
    body = (
      <>
        {ledger.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className={AUDIT_SECTION_LABEL}>Ledger</h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {ledger.map((entry) => (
                <li key={entry.id} className={AUDIT_ROW}>
                  <DetailKey>{clockTime(entry.at)}</DetailKey>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-label">
                    <span className="text-dim">{ACTOR[entry.actor]}</span>
                    <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
                      {entry.detail}
                    </span>
                    {entry.secretTouched && (
                      <Badge tone="warning">Secret used</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.agents.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className={AUDIT_SECTION_LABEL}>Agents</h3>
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {data.agents.map((agent) => (
                <Agent
                  key={`${agent.sessionId}:${agent.round}`}
                  agent={agent}
                  onOpen={() => {
                    onClose();
                    onOpenSession(agent.sessionId);
                  }}
                />
              ))}
            </ul>
          </section>
        )}
      </>
    );

  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      phone={phone}
      label={TITLE}
      sheetClassName="max-h-[88dvh]"
      modalClassName="w-[min(640px,calc(100vw-32px))] max-h-[min(720px,calc(100dvh-32px))]"
    >
      {(dismiss) => (
        <div className="flex min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-2 phone:px-4">
            <h2 className="m-0 min-w-0 flex-1 truncate text-dialog-title font-semibold text-fg">
              {TITLE}
            </h2>
            <Button
              variant="ghost"
              size="lg"
              className="phone:min-h-11 phone:min-w-11"
              aria-label="Close"
              icon={<IconX />}
              onClick={dismiss}
            />
          </header>
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain px-5 pb-5 phone:px-4">
            {body}
          </div>
        </div>
      )}
    </ResponsiveDialog>
  );
}
