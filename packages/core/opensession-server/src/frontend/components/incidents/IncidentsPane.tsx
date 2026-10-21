import type { Route } from "../../lib/app-route";
import type { UnifiedSession } from "../../lib/types";
import { EmptyState } from "../../ui/state";
import { IncidentPage } from "./IncidentPage";

/**
 * The main pane for `/incidents` and `/incidents/:id`, so the composition
 * root mounts one element for the whole area.
 */
export function IncidentsPane({
  route,
  sessions,
  onBack,
  navigate,
}: {
  route: Extract<Route, { view: "incidents" }>;
  sessions: UnifiedSession[];
  onBack: () => void;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}) {
  if (!route.id)
    // Placeholder until the incident home lands.
    return <EmptyState title="Incidents">Incidents</EmptyState>;
  return (
    <IncidentPage
      key={route.id}
      id={route.id}
      intent={route.intent}
      sessions={sessions}
      onBack={onBack}
      navigate={navigate}
    />
  );
}
