// Bringing a project page's section into view. A route change scrolls on
// its own (ProjectSettingsPage); this is for a click whose route is
// already the current one: the active nav sub-item after scrolling away,
// or a checklist fix whose section is already in the URL.

import { type ProjectSectionId, sectionAnchorId } from "./page-model";

export function scrollToProjectSection(id: ProjectSectionId): void {
  globalThis.document
    ?.getElementById(sectionAnchorId(id))
    ?.scrollIntoView({ block: "start" });
}
