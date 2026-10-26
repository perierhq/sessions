import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type {
  KnowledgeImportJob,
  KnowledgeImportKind,
} from "../../../../shared/knowledge";
import { useKnowledgeLiveConnected } from "../../../hooks/useKnowledgeLive";
import { useProjectSettings } from "../../../hooks/useProjects";
import { apiSWRKey, knowledgeKeyFilter } from "../../../lib/api-swr";
import { routePath } from "../../../lib/app-route";
import {
  type KnowledgeImportOptions,
  cancelKnowledgeJob,
  fetchKnowledgeJobs,
  startKnowledgeImport,
  uploadKnowledgeFiles,
} from "../../../lib/api/knowledge";
import { relativeTime } from "../../../lib/api/request";
import { fetchInboxes } from "../../../lib/api/support";
import {
  IMPORT_HOST,
  IMPORT_HOST_SKIPPED,
  IMPORT_HOSTS,
  IMPORT_JOB,
  IMPORT_JOB_CANCEL,
  IMPORT_JOB_ERROR,
  IMPORT_JOB_FOOT,
  IMPORT_JOB_LINE,
  IMPORT_JOB_META,
  IMPORT_JOB_PHASE,
  IMPORT_JOB_SKIPS,
  IMPORT_JOB_TRACK,
  IMPORT_MAILBOX_PICKS,
  IMPORT_REFUSED,
  IMPORT_SELECT,
  IMPORT_SOURCE,
  IMPORT_SOURCE_ACTION,
  IMPORT_SOURCE_DROP,
  IMPORT_SOURCE_LINE,
  IMPORT_SOURCE_TEXT,
  IMPORT_SOURCE_TITLE,
} from "../../../lib/knowledge-import-classes";
import {
  DEFAULT_IMPORT_MONTHS,
  FILE_ACCEPT,
  TRUNCATED_COPY,
  checkFiles,
  importChoices,
  isActiveJob,
  jobError,
  jobPhase,
  jobProgress,
  jobSkips,
  jobTitle,
  monthOptions,
  pollJobs,
  websiteCardLine,
  websiteHosts,
} from "../../../lib/knowledge/import-model";
import {
  importLabel,
  knowledgeAlert,
  knowledgeErrorMessage,
  knowledgeNotSetUp,
} from "../../../lib/knowledge/models";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { MeterTrack } from "../../../ui/meter";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { TextLink } from "../../../ui/text-link";
import { toast } from "../../../ui/toast";

/**
 * Knowledge → Import: the sources a project's knowledge can be filled from
 * (the mailbox's past replies, the Support websites, the repository's docs
 * and release notes, open bug issues, uploaded files), each with the button
 * that starts it, then the imports with what each is doing and its
 * progress. The jobs list is read again on each knowledge_changed message
 * (lib/knowledge/live.ts), and every 2 s while one is under way only when
 * the socket is down. One column at both widths: each source's button goes
 * under its words on a phone.
 */
export function KnowledgeImport({ project }: { project: string }) {
  const { mutate } = useSWRConfig();
  const live = useKnowledgeLiveConnected();
  const jobs = useSWR(
    apiSWRKey.knowledgeJobs(project),
    () => fetchKnowledgeJobs(project),
    { refreshInterval: (latest) => pollJobs(latest, live) },
  );
  const inboxes = useSWR(apiSWRKey.supportInboxes(), fetchInboxes);
  const settings = useProjectSettings(project);
  const [inboxId, setInboxId] = useState<string | null>(null);
  const [months, setMonths] = useState(String(DEFAULT_IMPORT_MONTHS));
  const [starting, setStarting] = useState<KnowledgeImportKind | null>(null);
  const [refused, setRefused] = useState<
    Array<{ name: string; reason: string }>
  >([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A job that finished since the last read changed the lists and counts.
  const active = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(
      (jobs.data ?? []).filter(isActiveJob).map((job) => job.id),
    );
    const ended = [...active.current].some((id) => !now.has(id));
    active.current = now;
    if (ended) void mutate(knowledgeKeyFilter(project));
  }, [jobs.data, mutate, project]);

  const choices = importChoices(inboxes.data?.inboxes ?? [], project);
  const inbox =
    choices.find((c) => c.value === inboxId)?.value ?? choices[0]?.value;
  const hosts = websiteHosts(settings.data?.document.access.websites ?? []);
  const crawlable = hosts.some((h) => h.skipped === null);
  const siteLine = websiteCardLine(settings.data ? hosts.length : null);
  const running = (kind: KnowledgeImportKind) =>
    (jobs.data ?? []).some((job) => job.kind === kind && isActiveJob(job));

  const started = (job: KnowledgeImportJob) => {
    setStarting(null);
    void jobs.mutate(
      (list) => [job, ...(list ?? []).filter((j) => j.id !== job.id)],
      { revalidate: true },
    );
  };
  const refusedStart = (cause: unknown) => {
    setStarting(null);
    // An import this server hasn't wired (501) is a notice, not a failure.
    toast(knowledgeErrorMessage(cause, "Couldn't start the import"), {
      variant: knowledgeNotSetUp(cause) ? "default" : "error",
    });
  };

  const start = (
    kind: Exclude<KnowledgeImportKind, "files">,
    options: KnowledgeImportOptions = {},
  ) => {
    setStarting(kind);
    startKnowledgeImport(project, kind, options).then(started, refusedStart);
  };

  const upload = (picked: File[]) => {
    if (!picked.length) return;
    const checked = checkFiles(picked);
    setRefused(checked.refused);
    if (checked.error) {
      toast(checked.error, { variant: "error" });
      return;
    }
    if (!checked.accepted.length) return;
    setStarting("files");
    uploadKnowledgeFiles(project, checked.accepted).then(started, refusedStart);
  };

  const openAccess = () =>
    window.location.assign(
      routePath({ view: "projectSettings", project, section: "access" }),
    );

  const busy = (kind: KnowledgeImportKind) =>
    starting === kind || running(kind);
  const actionLabel = (kind: KnowledgeImportKind, idle: string) =>
    running(kind) ? "Importing" : starting === kind ? "Starting" : idle;

  return (
    <>
      <SettingCard>
        <div className={IMPORT_SOURCE}>
          <div className={IMPORT_SOURCE_TEXT}>
            <div className={IMPORT_SOURCE_TITLE}>Mailbox</div>
            <div className={IMPORT_SOURCE_LINE}>
              Replies your team sent. Answers older than the latest change to
              the docs or a release come in as reference
            </div>
            {inboxes.data && !choices.length ? (
              <div className={IMPORT_SOURCE_LINE}>
                No inbox answers mail for this project yet. Connect one under
                Settings → Inboxes
              </div>
            ) : (
              <div className={IMPORT_MAILBOX_PICKS}>
                <OptionSelect
                  label="Inbox"
                  className={IMPORT_SELECT}
                  value={inbox ?? ""}
                  options={
                    choices.length
                      ? choices
                      : [{ value: "", label: "Loading inboxes" }]
                  }
                  disabled={!choices.length}
                  onChange={setInboxId}
                />
                <OptionSelect
                  label="How far back"
                  className={IMPORT_SELECT}
                  value={months}
                  options={monthOptions()}
                  onChange={setMonths}
                />
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="soft"
            className={IMPORT_SOURCE_ACTION}
            disabled={!inbox || busy("mailbox")}
            onClick={() =>
              inbox &&
              start("mailbox", { inboxId: inbox, months: Number(months) })
            }
          >
            {actionLabel("mailbox", "Import")}
          </Button>
        </div>

        <div className={IMPORT_SOURCE}>
          <div className={IMPORT_SOURCE_TEXT}>
            <div className={IMPORT_SOURCE_TITLE}>Website</div>
            <div className={IMPORT_SOURCE_LINE}>
              {siteLine.text}
              {siteLine.link ? (
                <>
                  {" "}
                  <TextLink onClick={openAccess}>{siteLine.link}</TextLink>
                </>
              ) : null}
            </div>
            {hosts.length ? (
              <ul className={IMPORT_HOSTS}>
                {hosts.map((h) => (
                  <li key={h.host}>
                    <span
                      className={cn(
                        IMPORT_HOST,
                        h.skipped && IMPORT_HOST_SKIPPED,
                      )}
                    >
                      {h.host}
                    </span>
                    {h.skipped ? (
                      <span className={IMPORT_HOST_SKIPPED}>
                        {" "}
                        · {h.skipped}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Button
            type="button"
            variant="soft"
            className={IMPORT_SOURCE_ACTION}
            disabled={!crawlable || busy("website")}
            onClick={() => start("website")}
          >
            {actionLabel("website", "Import")}
          </Button>
        </div>

        <div className={IMPORT_SOURCE}>
          <div className={IMPORT_SOURCE_TEXT}>
            <div className={IMPORT_SOURCE_TITLE}>
              Repository docs and releases
            </div>
            <div className={IMPORT_SOURCE_LINE}>
              README and docs on the default branch. Release notes come in as
              reference, incident notes stay internal
            </div>
          </div>
          <Button
            type="button"
            variant="soft"
            className={IMPORT_SOURCE_ACTION}
            disabled={busy("repo")}
            onClick={() => start("repo")}
          >
            {actionLabel("repo", "Import")}
          </Button>
        </div>

        <div className={IMPORT_SOURCE}>
          <div className={IMPORT_SOURCE_TEXT}>
            <div className={IMPORT_SOURCE_TITLE}>Known problems</div>
            <div className={IMPORT_SOURCE_LINE}>
              Open issues labelled bug, as reference. Kept in step every day
            </div>
          </div>
          <Button
            type="button"
            variant="soft"
            className={IMPORT_SOURCE_ACTION}
            disabled={busy("known-problems")}
            onClick={() => start("known-problems")}
          >
            {actionLabel("known-problems", "Import")}
          </Button>
        </div>

        <div
          className={cn(IMPORT_SOURCE, dragging && IMPORT_SOURCE_DROP)}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            const to = e.relatedTarget;
            if (!(to instanceof Node) || !e.currentTarget.contains(to))
              setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            setDragging(false);
            if (!busy("files")) upload([...e.dataTransfer.files]);
          }}
        >
          <div className={IMPORT_SOURCE_TEXT}>
            <div className={IMPORT_SOURCE_TITLE}>Files</div>
            <div className={IMPORT_SOURCE_LINE}>
              {dragging
                ? "Drop to import"
                : "Markdown, text, HTML or PDF, up to 20 files of 10 MB each. Drop them here or choose them. They come in as reference"}
            </div>
            {refused.length ? (
              <InlineAlert
                variant="warn"
                className="mt-2"
                title={
                  refused.length === 1
                    ? "1 file wasn't imported"
                    : `${refused.length} files weren't imported`
                }
                onDismiss={() => setRefused([])}
              >
                <ul className={IMPORT_REFUSED}>
                  {refused.map((r) => (
                    <li key={r.name}>
                      {r.name}: {r.reason}
                    </li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              upload(picked);
            }}
          />
          <Button
            type="button"
            variant="soft"
            className={IMPORT_SOURCE_ACTION}
            disabled={busy("files")}
            onClick={() => fileRef.current?.click()}
          >
            {actionLabel("files", "Choose files")}
          </Button>
        </div>
      </SettingCard>

      <SettingsGroupLabel>Imports</SettingsGroupLabel>
      <Jobs project={project} jobs={jobs} />
    </>
  );
}

function Jobs({
  project,
  jobs,
}: {
  project: string;
  jobs: ReturnType<typeof useSWR<KnowledgeImportJob[]>>;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  if (jobs.error && !jobs.data)
    return (
      <InlineAlert
        {...knowledgeAlert(
          jobs.error,
          "Couldn't load the imports",
          () => void jobs.mutate(),
        )}
      />
    );
  if (!jobs.data) return <SettingCardSkeleton rows={2} />;
  if (!jobs.data.length)
    return <EmptyState placement="card">No imports yet</EmptyState>;

  const cancel = (job: KnowledgeImportJob) => {
    setCancelling(job.id);
    cancelKnowledgeJob(project, job.id).then(
      (stopped) => {
        setCancelling(null);
        void jobs.mutate(
          (list) => list?.map((j) => (j.id === stopped.id ? stopped : j)),
          { revalidate: true },
        );
      },
      (cause) => {
        setCancelling(null);
        toast(knowledgeErrorMessage(cause, "Couldn't stop the import"), {
          variant: "error",
        });
        void jobs.mutate();
      },
    );
  };

  return (
    <SettingCard>
      {jobs.data.map((job) => {
        const pct = jobProgress(job);
        const active = isActiveJob(job);
        const phase = jobPhase(job);
        const skips = jobSkips(job);
        return (
          <div key={job.id} className={IMPORT_JOB}>
            <div className={IMPORT_JOB_LINE}>{jobTitle(job)}</div>
            {phase ? <div className={IMPORT_JOB_PHASE}>{phase}</div> : null}
            {job.state === "running" ? (
              <MeterTrack
                pct={pct}
                indeterminate={pct === null}
                tone="normal"
                className={IMPORT_JOB_TRACK}
                aria-label={`${importLabel(job.kind)} import`}
                aria-valuetext={phase ?? undefined}
              />
            ) : null}
            {skips ? <div className={IMPORT_JOB_SKIPS}>{skips}</div> : null}
            {jobError(job) ? (
              <div className={IMPORT_JOB_ERROR}>{jobError(job)}</div>
            ) : null}
            {job.truncated ? (
              <div className={IMPORT_JOB_META}>{TRUNCATED_COPY}</div>
            ) : null}
            <div className={IMPORT_JOB_FOOT}>
              <span className={IMPORT_JOB_META}>
                {job.finishedAt
                  ? `Finished ${relativeTime(job.finishedAt)}`
                  : `Started ${relativeTime(job.startedAt)}`}
              </span>
              {active ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={IMPORT_JOB_CANCEL}
                  disabled={cancelling === job.id}
                  aria-label={`Cancel the ${importLabel(job.kind).toLowerCase()} import`}
                  onClick={() => cancel(job)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </SettingCard>
  );
}
