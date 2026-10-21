import type { DotTone } from "../../lib/incidents/tone";
import { DOT_BG } from "../../lib/incidents/tone";
import {
  STATUS_LINE_DOT_SLOT,
  STATUS_LINE_FACTS,
  STATUS_LINE_HEADLINE,
} from "../../lib/incident-classes";
import { cn } from "../../ui/cn";
import { PulseDot } from "../../ui/status";

/**
 * The status line: a dot on the headline's first line, the headline in
 * plain words ("Search is down"), and one line of parallel facts ending
 * with where they came from. The dot is decoration; the words carry it.
 * On the home the facts are one sentence.
 */
export function StatusLine({
  tone,
  pulse,
  headline,
  facts,
  level,
}: {
  tone: DotTone;
  pulse: boolean;
  headline: string;
  facts: string[];
  level: "page" | "home";
}) {
  const line = level === "home" ? facts.join(" ") : facts.join(" · ");
  return (
    <header className="flex min-w-0 flex-col gap-1">
      <h1 className={STATUS_LINE_HEADLINE}>
        <span aria-hidden="true" className={STATUS_LINE_DOT_SLOT}>
          {pulse ? (
            <PulseDot size={12} />
          ) : (
            <span className={cn("size-3 rounded-full", DOT_BG[tone])} />
          )}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{headline}</span>
      </h1>
      {line && <p className={STATUS_LINE_FACTS}>{line}</p>}
    </header>
  );
}
