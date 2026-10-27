import {
  type CompareSide,
  type FindingBlock,
  FINDINGS_COPY,
  type SignalMarker,
  type SignalWindow,
} from "../../../../shared/findings";
import type { StripLane, StripResponse } from "../../../../shared/incidents";
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
  FINDINGS_CHANGE_TITLE,
  FINDINGS_LABEL,
  FINDINGS_PROSE_QUIET,
  FINDINGS_STRIP_SUMMARY,
} from "../../../lib/incident-classes";
import { ApiError } from "../../../lib/api/request";
import type { FindingItem } from "../../../lib/incidents/findings";
import { httpUrl } from "../../../lib/incidents/links";
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
type ChangeRef = Extract<FindingBlock, { kind: "change" }>["change"];

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
 * A PR or commit: what it is (a link that only opens it), why the agent
 * points at it, and its patch. `title` is null while the change loads.
 */
export function ChangeView({
  title,
  patch,
  kind,
  why,
  url,
  truncated = false,
  error,
  onRetry,
}: {
  title: string | null;
  patch: string | null;
  kind: "pr" | "commit";
  why: string;
  url?: string;
  /** The patch was cut to its size limit. */
  truncated?: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const theme = useResolvedTheme();
  const href = url ? httpUrl(url) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {title === null ? (
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
              className="text-link hover:underline"
            >
              {title}
            </a>
          ) : (
            title
          )}
        </p>
      )}
      {why.trim() ? (
        <MarkdownBody
          html={renderMarkdown(why)}
          enhance={false}
          className={FINDINGS_PROSE_QUIET}
        />
      ) : null}
      {error ? (
        <InlineAlert onRetry={onRetry}>
          Couldn&apos;t load the change
        </InlineAlert>
      ) : patch?.trim() ? (
        kind === "pr" ? (
          <PatchDiffs
            key={theme}
            patch={patch}
            options={{
              diffStyle: "unified",
              overflow: "scroll",
              enableLineSelection: false,
              theme: theme === "light" ? "pierre-light" : "pierre-dark",
              themeType: theme,
            }}
            className="max-h-96 overflow-auto rounded-xl bg-code-well text-label"
            header={null}
          />
        ) : (
          <CommitDiff diff={patch} />
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
  change,
  why,
}: {
  change: Extract<ChangeRef, { type: "pr" }>;
  why: string;
}) {
  const pr = useSessionPrResource(change.sessionId);
  // The session's PR is the one the server matched to this number; a
  // different number means it has since opened another, so the ref alone
  // (number and link) is what is left to show.
  const same = pr.data?.number === change.number;
  const diff = useSessionPrDiffResource(
    change.sessionId,
    undefined,
    undefined,
    {
      enabled: same,
    },
  );
  const loading = pr.data === undefined && !pr.error;
  // A 404 (the session or its PR is gone) leaves the ref's number and link;
  // Try again could not bring it back. Anything else is a failed load.
  const failed = (e: Error | undefined) =>
    !!e && !(e instanceof ApiError && e.status === 404);
  const title = loading
    ? null
    : same && pr.data
      ? `PR #${change.number} · ${pr.data.title}`
      : `PR #${change.number}`;
  return (
    <ChangeView
      title={title}
      patch={same ? (diff.data?.patch ?? null) : null}
      kind="pr"
      why={why}
      url={change.url}
      error={failed(pr.error) || (same && failed(diff.error) && !diff.data)}
      onRetry={() => {
        void pr.mutate();
        void diff.mutate();
      }}
    />
  );
}

function CommitChange({
  change,
  why,
}: {
  change: Extract<ChangeRef, { type: "commit" }>;
  why: string;
}) {
  const commit = useIncidentCommit(change.sha, change.repo);
  const data = commit.data;
  const short = data?.shortSha ?? change.sha.slice(0, 7);
  const title =
    data === undefined && !commit.error
      ? null
      : data
        ? `${short} · ${data.title}`
        : short;
  return (
    <ChangeView
      title={title}
      patch={data?.rawPatch ?? null}
      kind="commit"
      why={why}
      url={data?.url}
      truncated={!!data?.patchTruncated}
      error={!!commit.error && !data}
      onRetry={() => void commit.mutate()}
    />
  );
}

export function ChangeBlock({ item }: { item: FindingItem }) {
  const block = item.block;
  if (block.kind !== "change") return null;
  return block.change.type === "pr" ? (
    <PrChange change={block.change} why={block.why} />
  ) : (
    <CommitChange change={block.change} why={block.why} />
  );
}
