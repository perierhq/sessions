import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "../../ui/switch";
import { shownSwitchLabel } from "./SidebarCustomizeDialog";

// A switch's name stays put and its state rides aria-checked. A name that
// flipped between "Show" and "Hide" read as the opposite action once the
// screen reader also announced "on" or "off".
test("shown switches keep a fixed name and carry state in aria-checked", () => {
  expect(shownSwitchLabel("Tasks")).toBe("Show Tasks in sidebar");
  for (const checked of [true, false]) {
    const html = renderToStaticMarkup(
      <Switch
        checked={checked}
        onCheckedChange={() => {}}
        aria-label={shownSwitchLabel("acme")}
      />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Show acme in sidebar"');
    expect(html).toContain(`aria-checked="${checked}"`);
  }
});

test("every shown switch in the dialog uses the fixed name", async () => {
  const source = await Bun.file(
    new URL("./SidebarCustomizeDialog.tsx", import.meta.url),
  ).text();
  expect(source).toContain("aria-label={shownSwitchLabel(label)}");
  expect(source).not.toMatch(/\? "Hide" : "Show"/);
});
