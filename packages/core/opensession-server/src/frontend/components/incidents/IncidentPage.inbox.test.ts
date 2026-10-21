import { expect, test } from "bun:test";

// Opening an incident from any path (a push, the inbox, the list) reads its
// inbox row on every device while the page is on screen. The rule itself is
// lib/notifications' (watchIncidentNotifications); this pins the wiring.
test("the incident page watches its inbox row while mounted", async () => {
  const src = await Bun.file(
    new URL("./IncidentPage.tsx", import.meta.url),
  ).text();
  expect(src).toMatch(
    /useEffect\(\(\) => watchIncidentNotifications\(id\), \[id\]\)/,
  );
});
