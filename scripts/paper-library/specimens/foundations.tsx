import * as React from "react";
import type { Section } from "../entry";

const TYPE: [string, string, string][] = [
  ["page-title", "text-page-title font-title text-fg", "Automations"],
  ["section-title", "text-section-title font-title text-fg", "Model providers"],
  [
    "dialog-title",
    "text-dialog-title font-title text-fg",
    "Delete this session?",
  ],
  [
    "body",
    "text-body text-fg",
    "Both layouts render on Apple and Google Wallet.",
  ],
  ["item-title", "text-item-title font-medium text-fg", "Wallet pass redesign"],
  ["label", "text-label font-medium text-fg", "Create session"],
  ["supporting", "text-supporting text-dim", "Runs every weekday at 9:00"],
  ["meta", "text-meta text-faint", "22m · 4 steps"],
  ["stat", "text-stat font-title text-fg tabular-nums", "1,284"],
  ["mono", "font-mono text-label text-dim", "feat/wallet-pass · 3f9c2e1"],
];
const RADIUS: [string, string][] = [
  ["sm · 4", "rounded-sm"],
  ["md · 7", "rounded-md"],
  ["control · 12", "rounded-control"],
  ["row · 12", "rounded-row"],
  ["lg · 14", "rounded-lg"],
  ["panel · 14", "rounded-panel"],
  ["popup · 16", "rounded-popup"],
  ["xl · 18", "rounded-xl"],
  ["2xl · 22", "rounded-2xl"],
  ["section · 28", "rounded-section"],
];
const SHADOW: [string, string][] = [
  ["xs", "smooth-shadow-xs"],
  ["sm", "smooth-shadow-sm"],
  ["md", "smooth-shadow-md"],
  ["lg", "smooth-shadow-lg"],
  ["soft", "smooth-shadow-soft"],
  ["ring-sm", "smooth-shadow-ring-sm"],
  ["ring-md", "smooth-shadow-ring-md"],
  ["ring-lg", "smooth-shadow-ring-lg"],
];
const SURFACES: [string, string][] = [
  ["bg", "bg-bg"],
  ["sidebar", "bg-sidebar"],
  ["panel-surface", "bg-panel-surface"],
  ["settings-plate", "bg-settings-plate"],
  ["raised", "bg-raised"],
  ["panel", "bg-panel"],
  ["control", "bg-control"],
  ["active", "bg-active"],
];

export const sections: Section[] = [
  {
    group: "Type",
    title: "Roles",
    specimens: TYPE.map(([n, c, t]) => ({
      name: `${n}`,
      node: <span className={c}>{t}</span>,
    })),
  },
  {
    group: "Shape",
    title:
      "Radius (circular-corner values; the app draws squircles where supported)",
    specimens: RADIUS.map(([n, c]) => ({
      name: n,
      node: (
        <div className={`${c} bg-panel`} style={{ width: 88, height: 56 }} />
      ),
    })),
  },
  {
    group: "Shape",
    title: "Shadows",
    specimens: SHADOW.map(([n, c]) => ({
      name: n,
      node: (
        <div
          className={`${c} rounded-xl bg-bg`}
          style={{ width: 120, height: 72 }}
        />
      ),
      on: "--bg",
    })),
  },
  {
    group: "Shape",
    title: "Surface ramp",
    specimens: SURFACES.map(([n, c]) => ({
      name: n,
      node: (
        <div
          className={`${c} rounded-lg`}
          style={{
            width: 120,
            height: 72,
            boxShadow: "inset 0 0 0 1px var(--border)",
          }}
        />
      ),
    })),
  },
];

export const descriptions: Record<string, string> = {
  Type: "styles/tailwind.css · text-* roles; titles take font-title (600 light, 500 dark), interface text is regular or medium",
  Shape:
    "styles/tailwind.css · radius scales with the box and nests concentrically; a filled block takes no border",
};
