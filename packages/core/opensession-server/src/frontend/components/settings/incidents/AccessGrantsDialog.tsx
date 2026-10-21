import type * as React from "react";
import { useId, useState } from "react";
import useSWR from "swr";
import {
  type EgressGrant,
  type HostGrant,
  type IncidentAccessSettingsView,
  type ProjectAccessGrants,
} from "../../../../shared/incident-access";
import { fetchConnections } from "../../../lib/api/automations";
import { apiStatus, putAccessGrants } from "../../../lib/api/incidents";
import { fetchRepos } from "../../../lib/api/repos";
import { fetchRunners } from "../../../lib/api/runners";
import { fetchKeychain } from "../../../lib/api/settings";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_LIST,
  CHECK_ROW,
  CREDENTIAL_LINE,
  DIALOG_INPUT,
  FIELD_HINT,
  GRANT_ROW,
  GRANT_ROW_LINE,
} from "../../../lib/incident-settings-classes";
import {
  GRANT_MODE_LABELS,
  MODE_LABELS,
  toggleIn,
} from "../../../lib/incidents/access-form";
import { repoLabel } from "../../../lib/repo-label";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { cn } from "../../../ui/cn";
import { Input } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { OptionSelect } from "../../../ui/select";
import { SkeletonBar } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { IconPlus, IconX } from "../../icons";
import { FormField, FormSection, ListInput } from "./FormParts";
import { SettingsDialog } from "./SettingsDialog";

const NO_CREDENTIAL = "none";
const ROUTE_LABELS: Record<EgressGrant["route"], string> = {
  server: "Server",
  runner: "Runner",
  proxy: "Proxy",
};

/** Why a connection cannot be granted, or null. Mirrors the server: built
 *  in servers and servers limited to named people never reach an agent. */
function connectionProblem(server: {
  name: string;
  allowedUsers?: string[];
}): string | null {
  if (server.name.startsWith("opensession-")) return "Built in";
  if (server.allowedUsers?.length) return "Limited to named people";
  return null;
}

/** Every name in `available`, then the granted ones it no longer lists, so
 *  a grant can always be removed. */
function withGranted(available: string[], granted: string[]): string[] {
  return [...available, ...granted.filter((g) => !available.includes(g))];
}

/**
 * The project's grants: the most any incident agent of the project can
 * get. Profiles and overrides pick from these; narrowing a grant a profile
 * still uses is refused until the profile is narrowed first.
 */
export function AccessGrantsDialog({
  open,
  onClose,
  project,
  label,
  view,
  onSaved,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  label: string;
  view: IncidentAccessSettingsView;
  onSaved: (next: IncidentAccessSettingsView) => void;
  onConflict: () => Promise<IncidentAccessSettingsView | null>;
}) {
  const [grants, setGrants] = useState<ProjectAccessGrants>(() =>
    structuredClone(view.grants),
  );
  // Bumped when fresh values replace the draft, so typed fields re-seed.
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connections = useSWR(
    ["api", "connections-for-incident-grants"],
    fetchConnections,
  );
  const repos = useSWR(["api", "repos-for-incident-grants"], fetchRepos);
  const runners = useSWR(["api", "runners-for-incident-access"], fetchRunners);
  const keychain = useSWR(
    ["api", "keychain-for-incident-grants"],
    fetchKeychain,
  );

  const set = (patch: Partial<ProjectAccessGrants>) =>
    setGrants({ ...grants, ...patch });
  const allRunners = runners.data?.runners ?? [];
  const runnerName = (id: string) => {
    const runner = allRunners.find((r) => r.id === id);
    return runner ? runner.label || runner.name : id;
  };
  // Hosts and routes run commands: Linux or macOS Runners only.
  const commandRunners = allRunners
    .filter((r) => r.platform !== "win32")
    .map((r) => ({ value: r.id, label: r.label || r.name }));
  const credentials = (keychain.data?.credentials ?? []).filter(
    (c) => c.kind !== "login",
  );
  const credentialName = (id: string) =>
    credentials.find((c) => c.id === id)?.service ??
    view.credentialInfo[id]?.service ??
    id;

  const save = () => {
    setBusy(true);
    setError(null);
    putAccessGrants(project, grants, view.revision).then(
      (next) => {
        setBusy(false);
        onSaved(next);
        toast("Access saved");
        onClose();
      },
      (cause) => {
        setBusy(false);
        if (apiStatus(cause) !== 409)
          return setError(errorMessage(cause, "Couldn't save access"));
        void onConflict().then((fresh) => {
          if (!fresh) return;
          setGrants(structuredClone(fresh.grants));
          setGeneration(generation + 1);
        });
      },
    );
  };

  const loading = (swr: { data?: unknown; error?: unknown }) =>
    swr.error ? (
      <p className={FIELD_HINT}>
        {errorMessage(swr.error, "Couldn't load the choices")}
      </p>
    ) : !swr.data ? (
      <SkeletonBar className="w-[52%]" />
    ) : null;

  const checkList = (
    items: Array<{ id: string; name: string; problem?: string | null }>,
    picked: string[],
    onToggle: (id: string) => void,
    empty: string,
  ) =>
    items.length ? (
      <div className={CHECK_LIST}>
        {items.map((item) => {
          const on = picked.includes(item.id);
          return (
            <label key={item.id} className={CHECK_ROW}>
              <Checkbox
                checked={on}
                // A problem blocks a new grant, never removing one.
                disabled={!on && !!item.problem}
                onCheckedChange={() => onToggle(item.id)}
              />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.problem && (
                <span className="shrink-0 text-meta text-dim">
                  {item.problem}
                </span>
              )}
            </label>
          );
        })}
      </div>
    ) : (
      <p className={FIELD_HINT}>{empty}</p>
    );

  const servers = connections.data?.mcpServers ?? [];
  const toggle = (list: string[], id: string) => toggleIn(list, id, (s) => s);

  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="What this project may grant"
      error={error}
      busy={busy}
      onSave={save}
      wide
    >
      <p className={FIELD_HINT}>
        {`The most any incident agent in ${label} can get. Each role picks from these`}
      </p>
      <FormSection title="Highest mode">
        <Segmented
          className="self-start"
          label="Highest mode"
          value={grants.maxMode}
          onValueChange={(mode) =>
            set({ maxMode: mode === "code" ? "code" : "ask" })
          }
        >
          <SegmentedOption value="ask" className="phone:min-h-11">
            {MODE_LABELS.ask}
          </SegmentedOption>
          <SegmentedOption value="code" className="phone:min-h-11">
            {MODE_LABELS.code}
          </SegmentedOption>
        </Segmented>
      </FormSection>
      <FormSection title="Connections">
        {loading(connections) ??
          checkList(
            withGranted(
              servers.map((s) => s.name),
              grants.connections,
            ).map((name) => {
              const server = servers.find((s) => s.name === name);
              return {
                id: name,
                name,
                problem: server ? connectionProblem(server) : "Not configured",
              };
            }),
            grants.connections,
            (id) => set({ connections: toggle(grants.connections, id) }),
            "No connections are set up",
          )}
      </FormSection>
      <FormSection title="Repositories">
        {loading(repos) ??
          checkList(
            withGranted(
              (repos.data ?? []).map((r) => r.id),
              grants.repos,
            ).map((id) => ({ id, name: repoLabel(id) })),
            grants.repos,
            (id) => set({ repos: toggle(grants.repos, id) }),
            "No repositories",
          )}
      </FormSection>
      <FormSection title="Runners">
        <p className={FIELD_HINT}>Where an agent may open a session</p>
        {loading(runners) ??
          checkList(
            withGranted(
              allRunners.map((r) => r.id),
              grants.runners,
            ).map((id) => {
              const runner = allRunners.find((r) => r.id === id);
              return {
                id,
                name: runnerName(id),
                problem: !runner
                  ? "Not paired"
                  : runner.incidentReserved
                    ? "Reserved for incidents"
                    : null,
              };
            }),
            grants.runners,
            (id) => set({ runners: toggle(grants.runners, id) }),
            "No Runners are paired",
          )}
      </FormSection>
      <FormSection title="Hosts">
        <p className={FIELD_HINT}>
          Machines an agent may read through a Runner. Changes go through
          actions, never a host
        </p>
        <HostRows
          key={`hosts-${generation}`}
          hosts={grants.hosts}
          runners={commandRunners}
          onChange={(hosts) => set({ hosts })}
        />
      </FormSection>
      <FormSection title="Credentials">
        <p className={FIELD_HINT}>
          Only a credential's owner can lend a personal credential. Once lends
          it for one use; standing lends it for the whole incident
        </p>
        {loading(keychain) ??
          (credentials.length || grants.credentials.length ? (
            <div className={CHECK_LIST}>
              {withGranted(
                credentials.map((c) => c.id),
                grants.credentials.map((c) => c.credential),
              ).map((id) => {
                const info = credentials.find((c) => c.id === id);
                const granted = grants.credentials.find(
                  (c) => c.credential === id,
                );
                const pick = (mode: "once" | "standing" | null) =>
                  set({
                    credentials: [
                      ...grants.credentials.filter((c) => c.credential !== id),
                      ...(mode
                        ? [
                            granted
                              ? { ...granted, mode }
                              : // Stamped by the server; never taken from here.
                                {
                                  credential: id,
                                  mode,
                                  grantedBy: "",
                                  grantedAt: "",
                                },
                          ]
                        : []),
                    ],
                  });
                return (
                  <div key={id} className={CREDENTIAL_LINE}>
                    <label className={cn(CHECK_ROW, "min-w-0 flex-1")}>
                      <Checkbox
                        checked={!!granted}
                        onCheckedChange={(on) => pick(on ? "once" : null)}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{credentialName(id)}</span>
                        <span className="truncate text-meta text-dim">
                          {info
                            ? `${info.owner} · ${info.scope === "workspace" ? "workspace" : "personal"}`
                            : granted
                              ? `Lent by ${granted.grantedBy}`
                              : ""}
                        </span>
                      </span>
                    </label>
                    {granted && (
                      <Segmented
                        label={`How ${credentialName(id)} is lent`}
                        value={granted.mode}
                        size="sm"
                        onValueChange={(mode) =>
                          pick(mode === "standing" ? "standing" : "once")
                        }
                      >
                        <SegmentedOption
                          value="once"
                          className="phone:min-h-11"
                        >
                          {GRANT_MODE_LABELS.once}
                        </SegmentedOption>
                        <SegmentedOption
                          value="standing"
                          className="phone:min-h-11"
                        >
                          {GRANT_MODE_LABELS.standing}
                        </SegmentedOption>
                      </Segmented>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={FIELD_HINT}>The keychain has no credentials</p>
          ))}
      </FormSection>
      <FormSection title="Network routes">
        <p className={FIELD_HINT}>
          How an agent's requests leave: from this server, through a Runner, or
          through a proxy. Without allowed hosts a route reaches only the
          signal's own hosts
        </p>
        <RouteRows
          key={`routes-${generation}`}
          routes={grants.egress}
          runners={commandRunners}
          credentials={grants.credentials.map((c) => ({
            value: c.credential,
            label: credentialName(c.credential),
          }))}
          onChange={(egress) => set({ egress })}
        />
      </FormSection>
    </SettingsDialog>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      icon={<IconX size={18} />}
      className="size-11 shrink-0 justify-center p-0 desktop:size-8"
      onClick={onClick}
    />
  );
}

function AddButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div>
      <Button
        type="button"
        variant="soft"
        size="sm"
        icon={<IconPlus size={16} />}
        className="phone:min-h-11"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </div>
  );
}

/** Granted hosts: a Runner, optionally an SSH alias it reaches, always
 *  read-only. */
function HostRows({
  hosts,
  runners,
  onChange,
}: {
  hosts: HostGrant[];
  runners: Array<{ value: string; label: string }>;
  onChange: (hosts: HostGrant[]) => void;
}) {
  const setAt = (i: number, host: HostGrant) =>
    onChange(hosts.map((h, j) => (j === i ? host : h)));
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((host, i) => {
        const options = runners.some((r) => r.value === host.runner)
          ? runners
          : [...runners, { value: host.runner, label: host.runner }];
        return (
          // Rows have no identity of their own; position is the identity.
          <div key={i} className={GRANT_ROW}>
            <div className={GRANT_ROW_LINE}>
              <OptionSelect
                label="Runner"
                value={host.runner}
                options={options}
                onChange={(runner) => setAt(i, { ...host, runner })}
                className="min-w-0 flex-1 justify-between phone:min-h-11"
              />
              <span className="shrink-0 text-meta text-dim">Read-only</span>
              <RemoveButton
                label="Remove this host"
                onClick={() => onChange(hosts.filter((_, j) => j !== i))}
              />
            </div>
            <Input
              aria-label="SSH alias"
              placeholder="SSH alias, optional"
              value={host.ssh ?? ""}
              autoComplete="off"
              spellCheck={false}
              className={cn("font-mono", DIALOG_INPUT)}
              onChange={(event) => {
                const ssh = event.currentTarget.value.trim();
                const next: HostGrant = {
                  runner: host.runner,
                  access: "read-only",
                };
                if (ssh) next.ssh = ssh;
                setAt(i, next);
              }}
            />
          </div>
        );
      })}
      <AddButton
        disabled={!runners.length}
        onClick={() =>
          onChange([
            ...hosts,
            { runner: runners[0]?.value ?? "", access: "read-only" },
          ])
        }
      >
        Add a host
      </AddButton>
    </div>
  );
}

/** A route of the kind picked, keeping the allowed hosts. */
function routeOf(
  kind: EgressGrant["route"],
  from: EgressGrant,
  runner: string,
): EgressGrant {
  const next: EgressGrant =
    kind === "server"
      ? { route: "server" }
      : kind === "runner"
        ? {
            route: "runner",
            runner: from.route === "runner" ? from.runner : runner,
          }
        : { route: "proxy", url: from.route === "proxy" ? from.url : "" };
  if (from.hosts?.length) next.hosts = from.hosts;
  return next;
}

/** Granted network routes: server, a Runner, or a proxy with an optional
 *  credential, each with its allowed hosts. */
function RouteRows({
  routes,
  runners,
  credentials,
  onChange,
}: {
  routes: EgressGrant[];
  runners: Array<{ value: string; label: string }>;
  /** The granted credentials, for a proxy's sign-in. */
  credentials: Array<{ value: string; label: string }>;
  onChange: (routes: EgressGrant[]) => void;
}) {
  const idBase = useId();
  const setAt = (i: number, route: EgressGrant) =>
    onChange(routes.map((r, j) => (j === i ? route : r)));
  return (
    <div className="flex flex-col gap-2">
      {routes.map((route, i) => (
        // Rows have no identity of their own; position is the identity.
        <div key={i} className={GRANT_ROW}>
          <div className={GRANT_ROW_LINE}>
            <Segmented
              label="Route"
              value={route.route}
              onValueChange={(kind) =>
                setAt(
                  i,
                  routeOf(
                    kind === "runner" || kind === "proxy" ? kind : "server",
                    route,
                    runners[0]?.value ?? "",
                  ),
                )
              }
            >
              {(["server", "runner", "proxy"] as const).map((kind) => (
                <SegmentedOption
                  key={kind}
                  value={kind}
                  className="phone:min-h-11"
                >
                  {ROUTE_LABELS[kind]}
                </SegmentedOption>
              ))}
            </Segmented>
            <span className="flex-1" />
            <RemoveButton
              label="Remove this route"
              onClick={() => onChange(routes.filter((_, j) => j !== i))}
            />
          </div>
          {route.route === "runner" && (
            <OptionSelect
              label="Runner"
              value={route.runner}
              options={
                runners.some((r) => r.value === route.runner)
                  ? runners
                  : [...runners, { value: route.runner, label: route.runner }]
              }
              onChange={(runner) => setAt(i, { ...route, runner })}
              className="w-full justify-between phone:min-h-11"
            />
          )}
          {route.route === "proxy" && (
            <div className={GRANT_ROW_LINE}>
              <Input
                aria-label="Proxy URL"
                placeholder="https://proxy.example.test:8080"
                type="url"
                inputMode="url"
                value={route.url}
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "min-w-0 flex-[2] basis-56 font-mono",
                  DIALOG_INPUT,
                )}
                onChange={(event) =>
                  setAt(i, { ...route, url: event.currentTarget.value.trim() })
                }
              />
              <OptionSelect
                label="Proxy sign-in"
                value={route.credential ?? NO_CREDENTIAL}
                options={[
                  { value: NO_CREDENTIAL, label: "No proxy sign-in" },
                  ...credentials.map((c) => ({
                    value: c.value,
                    label: `Sign in with ${c.label}`,
                  })),
                ]}
                onChange={(credential) => {
                  const next: EgressGrant = { route: "proxy", url: route.url };
                  if (credential !== NO_CREDENTIAL)
                    next.credential = credential;
                  if (route.hosts?.length) next.hosts = route.hosts;
                  setAt(i, next);
                }}
                className="min-w-0 flex-1 basis-40 justify-between phone:min-h-11"
              />
            </div>
          )}
          <FormField label="Allowed hosts" htmlFor={`${idBase}-hosts-${i}`}>
            <ListInput
              id={`${idBase}-hosts-${i}`}
              placeholder="api.example.test"
              value={route.hosts ?? []}
              onChange={(hosts) => {
                const next = { ...route };
                if (hosts.length) next.hosts = hosts;
                else delete next.hosts;
                setAt(i, next);
              }}
            />
          </FormField>
        </div>
      ))}
      <AddButton onClick={() => onChange([...routes, { route: "server" }])}>
        Add a route
      </AddButton>
    </div>
  );
}
