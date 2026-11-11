import { useEffect, useState } from "react";
import type { LeadRosterEntry } from "../../../shared/project-lead";
import { routePath } from "../../lib/app-route";
import { cachedRepos, fetchRepos } from "../../lib/api/repos";
import {
  githubRepoNames,
  loadBlobGithub,
  type BlobGithubLoad,
} from "../../lib/blob-github";
import { blobInset, blobSubhead } from "../../lib/blob-member-classes";
import {
  BLOB_ROLE,
  blobFacts,
  leadStateLabel,
  loadBlobSummary,
  type BlobSummary,
} from "../../lib/blob-member";
import { useBots, type Person } from "../../lib/people";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
} from "../../ui/settings";
import { SkeletonBar } from "../../ui/state";
import { IconChevronRight } from "../icons";
import { BlobGithubSection } from "./BlobGithubSection";
import { BotBadge, UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";

// Settings → Members → Bots: Blob as a teammate. Its picture, role and a
// read-only summary of how it runs for you: the watch, quiet hours, digest,
// time zone, open needs-you items, and each project's lead linking to that
// project's Lead section. Blob's own settings are a link. The one thing it
// edits is Blob's GitHub account, which only the instance owner sees
// (BlobGithubSection).

export function BotsSection() {
  const bots = useBots();
  const user = useCurrentUser();
  const [summary, setSummary] = useState<BlobSummary | null>(null);
  const [github, setGithub] = useState<BlobGithubLoad | null>(null);
  const [repos, setRepos] = useState(() => githubRepoNames(cachedRepos()));

  useEffect(() => {
    if (!user) return;
    let live = true;
    void loadBlobSummary(user).then((next) => {
      if (live) setSummary(next);
    });
    void loadBlobGithub().then((next) => {
      if (live) setGithub(next);
    });
    fetchRepos()
      .then((next) => {
        if (live) setRepos(githubRepoNames(next));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [user]);

  if (!bots.length) return null;
  return (
    <>
      <SettingsGroupLabel>Bots</SettingsGroupLabel>
      {bots.map((bot) =>
        bot.name.toLowerCase() === "blob" ? (
          <BlobMemberCard
            key={bot.name}
            bot={bot}
            summary={summary}
            signedIn={!!user}
            github={github}
            repos={repos}
          />
        ) : (
          <SettingCard key={bot.name}>
            <BotIdentityRow bot={bot} />
          </SettingCard>
        ),
      )}
    </>
  );
}

function BotIdentityRow({
  bot,
  description,
  action,
}: {
  bot: Person;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <SettingRow className="items-start">
      <UserAvatar name={bot.name} image={bot.image} size={28} />
      <SettingRowText>
        <SettingRowTitle className="flex items-center gap-1.5">
          {bot.fullName}
          <BotBadge />
        </SettingRowTitle>
        {description && (
          <SettingRowDescription>{description}</SettingRowDescription>
        )}
      </SettingRowText>
      {action && <SettingRowControl>{action}</SettingRowControl>}
    </SettingRow>
  );
}

/** Blob's card: identity, then its state for you, then its leads, then its
 *  GitHub account for the owner. `summary` and `github` null are still
 *  loading. */
export function BlobMemberCard({
  bot,
  summary,
  signedIn = true,
  github = { kind: "hidden" },
  repos = [],
}: {
  bot: Person;
  summary: BlobSummary | null;
  signedIn?: boolean;
  github?: BlobGithubLoad | null;
  repos?: string[];
}) {
  return (
    <SettingCard>
      <BotIdentityRow
        bot={bot}
        description={BLOB_ROLE}
        action={
          <Button
            size="sm"
            className="phone:min-h-11"
            render={
              <a
                href={routePath({ view: "settings", section: "notifications" })}
              />
            }
          >
            Notification settings
          </Button>
        }
      />
      {signedIn && <BlobFacts summary={summary} />}
      <BlobLeads leads={summary ? summary.leads : undefined} />
      {signedIn && <BlobGithubSection load={github} repos={repos} />}
    </SettingCard>
  );
}

const FACT_LABELS = [
  "Watch",
  "Quiet hours",
  "Daily digest",
  "Time zone",
  "Needs you",
];

function BlobFacts({ summary }: { summary: BlobSummary | null }) {
  if (summary && !summary.prefs)
    return (
      <div className={cn("py-4 text-supporting text-dim", blobInset)}>
        Couldn&rsquo;t load Blob&rsquo;s settings.
      </div>
    );
  const facts = summary?.prefs
    ? blobFacts(summary.prefs, summary.needsYou)
    : null;
  return (
    <dl
      aria-busy={!facts}
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-4 text-supporting",
        blobInset,
      )}
    >
      {(facts ?? FACT_LABELS.map((label) => ({ label, value: "" }))).map(
        (fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-dim">{fact.label}</dt>
            <dd className="min-w-0 tabular-nums text-fg">
              {facts ? fact.value : <SkeletonBar className="mt-1 h-3 w-24" />}
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

/** `leads` undefined is still loading; null could not be read. */
function BlobLeads({ leads }: { leads: LeadRosterEntry[] | null | undefined }) {
  return (
    <div className="py-2">
      <div className={blobSubhead}>Project leads</div>
      {leads === undefined ? (
        <div aria-busy className={cn("py-3", blobInset)}>
          <SkeletonBar className="w-32" />
        </div>
      ) : leads === null ? (
        <div className={cn("py-3 text-supporting text-dim", blobInset)}>
          Couldn&rsquo;t load the project leads.
        </div>
      ) : leads.length === 0 ? (
        <div className={cn("py-3 text-supporting text-dim", blobInset)}>
          No project has a lead yet. Turn one on in a project&rsquo;s Lead
          settings.
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {leads.map((lead) => (
            <li key={lead.project}>
              <a
                href={routePath({
                  view: "projectSettings",
                  project: lead.project,
                  section: "lead",
                })}
                className={cn(
                  "flex min-h-11 items-center gap-3 text-supporting text-fg no-underline transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                  blobInset,
                )}
              >
                <span className="min-w-0 flex-1 truncate">{lead.label}</span>
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 text-label",
                    lead.enabled ? "text-dim" : "text-faint",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      lead.enabled ? "bg-green" : "bg-faint",
                    )}
                  />
                  {leadStateLabel(lead)}
                </span>
                <IconChevronRight
                  size={16}
                  className="shrink-0 text-faint"
                  aria-hidden="true"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
