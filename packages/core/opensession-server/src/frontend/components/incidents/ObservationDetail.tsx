import type { StripBar } from "../../../shared/incidents";
import { OBSERVATION_GRID } from "../../lib/incident-classes";
import { httpUrl } from "../../lib/incidents/links";
import { RESULT_WORD } from "../../lib/incidents/strip-layout";
import { clockTime } from "../../lib/time";
import { DetailKey } from "../../ui/detail-key";

/**
 * One bar of a signal strip, written out: when, what it said, how many
 * checks it holds, the value and the detail of its worst observation, and
 * where that came from. A source link renders only for http(s).
 */
export function ObservationDetail({
  bar,
  laneLabel,
  format,
}: {
  bar: StripBar;
  laneLabel: string;
  format: (value: number) => string;
}) {
  const when = `${clockTime(bar.start)}–${clockTime(bar.end)}`;
  const source = httpUrl(bar.sample?.sourceUrl);
  const value = bar.value ?? bar.sample?.value;
  return (
    <dl className={OBSERVATION_GRID} aria-label={`${laneLabel}, ${when}`}>
      <DetailKey>When</DetailKey>
      <dd className="m-0 tabular-nums">{when}</dd>
      {bar.result === null ? (
        <>
          <DetailKey>Result</DetailKey>
          <dd className="m-0 text-dim">No data in this interval</dd>
        </>
      ) : (
        <>
          <DetailKey>Result</DetailKey>
          <dd className="m-0">{RESULT_WORD[bar.result]}</dd>
          <DetailKey>Checks</DetailKey>
          <dd className="m-0 tabular-nums">{bar.count.toLocaleString()}</dd>
          {value !== undefined && (
            <>
              <DetailKey>Value</DetailKey>
              <dd className="m-0 tabular-nums">{format(value)}</dd>
            </>
          )}
          {bar.sample?.detail && (
            <>
              <DetailKey>Detail</DetailKey>
              <dd className="m-0 select-text [overflow-wrap:anywhere]">
                {bar.sample.detail}
              </dd>
            </>
          )}
          {source && (
            <>
              <DetailKey>Source</DetailKey>
              <dd className="m-0 min-w-0">
                <a
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link [overflow-wrap:anywhere] hover:underline"
                >
                  {source}
                </a>
              </dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
