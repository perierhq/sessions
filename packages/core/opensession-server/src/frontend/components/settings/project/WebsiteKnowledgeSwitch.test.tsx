// The "Use as knowledge" switch beside a Support website: a labelled 44px
// row whose switch is named after the site and says what it does.
import { describe, expect, test } from "bun:test";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { find } from "../../../tools/hook-harness";
import { Switch } from "../../../ui/switch";
import { WebsiteKnowledgeSwitch } from "./WebsiteKnowledgeSwitch";

describe("WebsiteKnowledgeSwitch", () => {
  test("names the site, says what it does and reports the change", () => {
    const changes: boolean[] = [];
    const tree = WebsiteKnowledgeSwitch({
      host: "help.acme.example.test",
      on: false,
      onChange: (on) => changes.push(on),
    });
    const sw = find<React.ComponentProps<typeof Switch>>(tree, Switch);
    expect(sw?.props["aria-label"]).toBe(
      "Use help.acme.example.test as knowledge",
    );
    expect(sw?.props.checked).toBe(false);
    // SAFETY: the handler ignores its event details.
    sw?.props.onCheckedChange?.(true, {} as never);
    expect(changes).toEqual([true]);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Use as knowledge");
    expect(html).toContain(
      "Import this site&#x27;s pages as knowledge replies can rely on",
    );
    // The whole row is the target: a label at least 44px tall.
    expect(html).toMatch(/<label[^>]*min-h-11/);
  });

  test("a wildcard says it can't be imported", () => {
    const html = renderToStaticMarkup(
      WebsiteKnowledgeSwitch({
        host: "*.acme.example.test",
        on: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain("A wildcard isn&#x27;t imported");
  });
});
