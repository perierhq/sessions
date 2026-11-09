import * as React from "react";
import * as Icons from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section } from "../entry";

const names = Object.keys(Icons)
  .filter(
    (k) =>
      /^Icon[A-Z]/.test(k) &&
      (typeof (Icons as any)[k] === "function" || (Icons as any)[k]?.$$typeof),
  )
  .sort();

export const sections: Section[] = [
  {
    group: "Icons",
    title: "Glyphs at 22",
    specimens: names.map((n) => {
      const I = (Icons as any)[n];
      return {
        name: n.replace(/^Icon/, ""),
        node: (
          <span className="text-fg flex">
            <I size={22} />
          </span>
        ),
      };
    }),
  },
  {
    group: "Icons",
    title: "Size steps",
    specimens: [20, 22, 24].map((s) => ({
      name: `${s} · ${s === 20 ? "inline with text" : s === 22 ? "standalone, default" : "primary actions"}`,
      node: (
        <span className="text-fg flex">
          <Icons.IconSearch size={s} />
        </span>
      ),
    })),
  },
];

export const descriptions: Record<string, string> = {
  Icons:
    "components/icons.tsx · iconic-pro, 24 grid, 1.5 stroke with round caps; add new glyphs to that file, never inline",
};
