import {
  type CompareSide,
  type FindingBlock,
  FINDINGS_COPY,
  type SignalMarker,
  type SignalWindow,
} from "../../../../shared/findings";
import type {
  Incident,
  StripLane,
  StripResponse,
} from "../../../../shared/incidents";
import {
  useSessionPrDiffResource,
  useSessionPrResource,
} from "../../../hooks/useApiResources";
import {
  useIncidentCommit,
  useSignalWindow,
} from "../../../hooks/useIncidents";
import {
  FINDINGS_COMPARE,
  FINDINGS_CHANGE_FILE,
  FINDINGS_CHANGE_HUNK,
  FINDINGS_CHANGE_LINK,
  FINDINGS_CHANGE_TITLE,
  FINDINGS_LABEL,
  FINDINGS_PROSE_QUIET,
  FINDINGS_STRIP_SUMMARY,
} from "../../../lib/incident-classes";
import { ApiError } from "../../../lib/api/request";
import {
  type FindingItem,
  FINDINGS_MARKDOWN,
  localizeTimes,
} from "../../../lib/incidents/findings";
import {
  changeMoreCopy,
  citedHunk,
  patchFileStats,
  shownFiles,
} from "../../../lib/incidents/change";
import { fixPrNumber } from "../../../lib/incidents/details";
import { httpUrl } from "../../../lib/incidents/links";
import type { PrFile } from "../../../lib/types";
import type { StripLaneMeta } from "../../../lib/incidents/strip-layout";
import {
  stripSummary,
  windowStrip,
} from "../../../lib/incidents/strip-summary";
import { renderMarkdown } from "../../../lib/markdown";
import { cn } from "../../../ui/cn";
import { InlineAlert } from "../../../ui/state";
import { useResolvedTheme } from "../../CodeHighlight";
import { PatchDiffs } from "../../DeferredDiff";
import { MarkdownBody } from "../../MarkdownBody";
import { CommitDiff } from "../../settings/CommitDiff";
import { SignalStrip } from "../SignalStrip";
import { LogLines } from "./TextBlocks";

type Meta = (lane: StripLane) => StripLaneMeta;
type ChangeBlockOf = Extract<FindingBlock, { kind: "change" }>;
type ChangeRef = ChangeBlockOf["change"];

/**
 * A signal window as a block: the strip the page already draws, narrowed to
 * the window's lane, with the agent's markers among its own, and under it the
 * same bars in words (the chart's text alternative). A marker with a checked
 * reference draws like the strip's own; one without is the agent's note,
 * drawn dashed and named so in the summary. The summary's line holds a space
 * while the window loads so the block does not grow when the data lands.
 */
export function SignalWindowView({
  strip,
  error,
  onRetry,
  markers,
  title,
  meta,
  lane,
}: {
  strip: StripResponse | undefined;
  error: boolean;
  onRetry: () => void;
  markers: SignalMarker[];
  title: string;
  meta: Meta;
  lane?: string;
}) {
  if (error && !strip)
    return (
      <InlineAlert onRetry={onRetry}>Couldn&apos;t load the signal</InlineAlert>
    );
  const shown = strip ? windowStrip(strip, lane) : undefined;
  const annotations = markers.map((m) => ({
    at: m.at,
    label: m.label,
    note: !m.ref,
  }));
  const notes = annotations.some((m) => m.note);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <SignalStrip
        strip={shown}
        meta={meta}
        annotations={annotations}
        live={false}
        title={title}
        liveLine={null}
      />
      <p className={FINDINGS_STRIP_SUMMARY}>
        {shown
          ? stripSummary(shown, { format: laneFormat(shown, meta) }) +
            (notes ? ` ${FINDINGS_COPY.markerNotes}` : "")
          : " "}
      </p>
    </div>
  );
}

/** Values in the summary read the way the lane's axis does. */
function laneFormat(strip: StripResponse, meta: Meta) {
  const lane = strip.lanes[0];
  return lane ? meta(lane).format : String;
}

/** A window with its own loading, so a compare can hold two. */
function LoadedWindow({
  range: w,
  markers,
  meta,
  signalName,
}: {
  range: SignalWindow;
  markers: SignalMarker[];
  meta: Meta;
  signalName: (id: string) => string;
}) {
  const { data, error, mutate } = useSignalWindow(w);
  return (
    <SignalWindowView
      strip={data}
      error={!!error}
      onRetry={() => void mutate()}
      markers={markers}
      title={signalName(w.signalId)}
      meta={meta}
      lane={w.lane}
    />
  );
}

export function SignalBlock({
  item,
  meta,
  signalName,
}: {
  item: FindingItem;
  meta: Meta;
  signalName: (id: string) => string;
}) {
  const block = item.block;
  if (block.kind !== "signal") return null;
  return (
    <LoadedWindow
      range={block}
      markers={block.markers}
      meta={meta}
      signalName={signalName}
    />
  );
}

function CompareSideView({
  side,
  meta,
  signalName,
}: {
  side: CompareSide;
  meta: Meta;
  signalName: (id: string) => string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className={FINDINGS_LABEL}>{side.label}</p>
      {"signal" in side ? (
        <LoadedWindow
          range={side.signal}
          markers={[]}
          meta={meta}
          signalName={signalName}
        />
      ) : (
        <LogLines excerpt={side.log} />
      )}
    </div>
  );
}

/**
 * Two windows or two excerpts, each under its label: side by side when the
 * block spans the desktop's two columns, stacked in a half block and on a
 * phone, where two charts side by side would be too narrow to read.
 */
export function CompareBlock({
  item,
  meta,
  signalName,
}: {
  item: FindingItem;
  meta: Meta;
  signalName: (id: string) => string;
}) {
  const block = item.block;
  if (block.kind !== "compare") return null;
  return (
    <div
      className={cn(
        FINDINGS_COMPARE,
        item.span === "full" && "desktop:grid-cols-2",
      )}
    >
      <CompareSideView
        side={block.sides[0]}
        meta={meta}
        signalName={signalName}
      />
      <CompareSideView
        side={block.sides[1]}
        meta={meta}
        signalName={signalName}
      />
    </div>
  );
}

/**
 * A PR or commit as a summary: what it is (`head`, a link only for a
 * commit; a PR opens through the block's Show source, the review), why
 * the agent points at it, the files it touches with their line counts,
 * and the one hunk the agent cited. The whole diff stays in the review.
 * `head` and `files` are null while the change loads.
 */
export function ChangeView({
  head,
  kind,
  why,
  url,
  files,
  total,
  hunk,
  truncated = false,
  error,
  onRetry,
}: {
  head: string | null;
  kind: "pr" | "commit";
  why: string;
  url?: string;
  files: PrFile[] | null;
  /** How many files the change touches; more than `files` may list. */
  total: number;
  /** The cited file's hunk (`citedHunk`), when there is one. */
  hunk: string | null;
  /** The patch was cut to its size limit. */
  truncated?: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const theme = useResolvedTheme();
  const href = url ? httpUrl(url) : null;
  const listed = files ? shownFiles(files, total) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {head === null ? (
        <p aria-hidden className={cn(FINDINGS_CHANGE_TITLE, "text-faint")}>
          {" "}
        </p>
      ) : (
        <p className={FINDINGS_CHANGE_TITLE}>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={FINDINGS_CHANGE_LINK}
            >
              {head}
            </a>
          ) : (
            head
          )}
        </p>
      )}
      {why.trim() ? (
        <MarkdownBody
          html={renderMarkdown(localizeTimes(why), FINDINGS_MARKDOWN)}
          enhance={false}
          className={FINDINGS_PROSE_QUIET}
        />
      ) : null}
      {error ? (
        <InlineAlert onRetry={onRetry}>
          Couldn&apos;t load the change
        </InlineAlert>
      ) : null}
      {listed && listed.files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {listed.files.map((file) => (
            <li key={file.path} className={FINDINGS_CHANGE_FILE}>
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                {file.path}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="text-green">+{file.additions}</span>{" "}
                <span className="text-red">−{file.deletions}</span>
              </span>
            </li>
          ))}
          {listed.more > 0 ? (
            <li className={cn(FINDINGS_CHANGE_FILE, "text-faint")}>
              {changeMoreCopy(listed.more, kind)}
            </li>
          ) : null}
        </ul>
      ) : null}
      {!error && hunk ? (
        kind === "pr" ? (
          <PatchDiffs
            key={theme}
            patch={hunk}
            options={{
              diffStyle: "unified",
              overflow: "wrap",
              enableLineSelection: false,
              theme: theme === "light" ? "pierre-light" : "pierre-dark",
              themeType: theme,
            }}
            className={FINDINGS_CHANGE_HUNK}
            header={null}
          />
        ) : (
          <CommitDiff diff={hunk} />
        )
      ) : null}
      {truncated && !error ? (
        <p className="m-0 text-meta text-faint">
          Some large changes aren’t shown.
        </p>
      ) : null}
    </div>
  );
}

function PrChange({
  block,
  fixPr,
}: {
  block: ChangeBlockOf;
  fixPr: number | null;
}) {
  // SAFETY: ChangeBlock hands PrChange only a PR change.
  const change = block.change as Extract<ChangeRef, { type: "pr" }>;
  const pr = useSessionPrResource(change.sessionId);
  // The session's PR is the one the server matched to this number; a
  // different number means it has since opened another, so the ref alone
  // (number and link) is what is left to show.
  const same = pr.data?.number === change.number;
  // The diff only for the cited hunk, or for line counts the PR lacks.
  const diff = useSessionPrDiffResource(
    change.sessionId,
    undefined,
    undefined,
    { enabled: same && (!!block.file || !pr.data?.files) },
  );
  const loading = pr.data === undefined && !pr.error;
  // A 404 (the session or its PR is gone) leaves the ref's number and link;
  // Try again could not bring it back. Anything else is a failed load.
  const failed = (e: Error | undefined) =>
    !!e && !(e instanceof ApiError && e.status === 404);
  const number = `PR #${change.number}`;
  // The Fix section already names the incident's own PR with its title
  // and counts; here the number says which one it is.
  const head = loading
    ? null
    : same && pr.data && fixPr !== change.number
      ? `${number} · ${pr.data.title}`
      : number;
  const patch = same ? (diff.data?.patch ?? null) : null;
  const files = same
    ? (pr.data?.files ?? (patch ? patchFileStats(patch) : null))
    : [];
  return (
    <ChangeView
      head={head}
      kind="pr"
      why={block.why}
      files={files}
      total={same ? (pr.data?.changedFiles ?? 0) : 0}
      hunk={patch ? citedHunk(patch, block.file, block.line) : null}
      error={failed(pr.error) || (same && failed(diff.error) && !diff.data)}
      onRetry={() => {
        void pr.mutate();
        void diff.mutate();
      }}
    />
  );
}

function CommitChange({ block }: { block: ChangeBlockOf }) {
  // SAFETY: ChangeBlock hands CommitChange only a commit change.
  const change = block.change as Extract<ChangeRef, { type: "commit" }>;
  const commit = useIncidentCommit(change.sha, change.repo);
  const data = commit.data;
  const short = data?.shortSha ?? change.sha.slice(0, 7);
  const head =
    data === undefined && !commit.error
      ? null
      : data
        ? `${short} · ${data.title}`
        : short;
  const patch = data?.rawPatch ?? null;
  return (
    <ChangeView
      head={head}
      kind="commit"
      why={block.why}
      url={data?.url}
      files={patch ? patchFileStats(patch) : data ? [] : null}
      total={data?.filesChanged ?? 0}
      hunk={patch ? citedHunk(patch, block.file, block.line) : null}
      truncated={!!data?.patchTruncated}
      error={!!commit.error && !data}
      onRetry={() => void commit.mutate()}
    />
  );
}

export function ChangeBlock({
  item,
  incident,
}: {
  item: FindingItem;
  incident: Pick<Incident, "response">;
}) {
  const block = item.block;
  if (block.kind !== "change") return null;
  return block.change.type === "pr" ? (
    <PrChange block={block} fixPr={fixPrNumber(incident.response)} />
  ) : (
    <CommitChange block={block} />
  );
}
