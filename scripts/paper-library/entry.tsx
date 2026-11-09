import * as React from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../../packages/core/opensession-server/src/frontend/ui/tooltip";
import * as mod from "./specimens";
const sections: Section[] = (mod as any).sections;
(window as any).__DESCRIPTIONS = (mod as any).descriptions ?? {};

export type Specimen = {
  /** Variant / state, e.g. "primary · md · hover". */
  name: string;
  node: React.ReactNode;
  /** Capture this selector (document-wide) instead of the wrapper's child —
   *  for portalled popups. */
  select?: string;
  /** Fixed wrapper width, for components that fill their parent. */
  width?: number;
  /** Background the specimen sits on (a CSS var, e.g. "--bg-panel"). */
  on?: string;
  /** Render at this viewport width (e.g. 390 for the phone layout, <= 720). */
  viewport?: number;
};
/** group = the Paper artboard (one per component, e.g. "Switch");
 *  title = the section inside it (e.g. "States"). */
export type Section = { group: string; title: string; specimens: Specimen[] };

const params = new URLSearchParams(location.search);
const only = params.get("only");
const flat = sections.flatMap((s, si) =>
  s.specimens.map((sp, i) => ({ ...sp, id: `${si}-${i}`, section: s })),
);
(window as any).__SPECS = flat.map((s) => ({
  id: s.id,
  group: s.section.group,
  section: s.section.title,
  name: s.name,
  select: s.select ?? null,
  on: s.on ?? null,
  viewport: s.viewport ?? null,
}));

function Wrap({ s }: { s: (typeof flat)[number] }) {
  return (
    <div
      data-spec={s.id}
      style={{
        display: "flex",
        alignItems: "flex-start",
        width: s.width,
        padding: 0,
        background: s.on ? `var(${s.on})` : undefined,
      }}
    >
      {s.node}
    </div>
  );
}

function App() {
  const list = only ? flat.filter((s) => s.id === only) : flat;
  return (
    <TooltipProvider>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 32,
          padding: 40,
          alignItems: "flex-start",
        }}
      >
        {list.map((s) => (
          <div
            key={s.id}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            {!only && (
              <div style={{ font: "12px/16px system-ui", color: "#888" }}>
                {s.section.group} / {s.section.title} / {s.name}
              </div>
            )}
            <Wrap s={s} />
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
