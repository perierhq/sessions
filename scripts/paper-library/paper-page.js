// Codemode helper: rebuild a whole library page.
//   const run = new Function("toolsRaw", importSrc + pageSrc + "\nreturn rebuildPage;")(tools);
//   await run({ F, P, theme, read: (path) => <string>, keep: ["Read me", "Colour"] });
const ROWS = [
  ["Read me", "Colour", "Type", "Shape", "Icons"],
  [
    "Button",
    "Plain button",
    "Text link",
    "Input",
    "Field",
    "Checkbox",
    "Radio",
    "Switch",
    "Segmented",
    "Select",
    "Combobox",
    "Date range",
  ],
  [
    "Menu",
    "Popover",
    "Tooltip",
    "Modal",
    "Confirm dialog",
    "Sheet",
    "Toast",
    "Floating status",
    "Overlay action",
  ],
  [
    "Badge",
    "Card",
    "Spinner",
    "Page loader",
    "Pulse dot",
    "Working pill",
    "Time of day",
    "Meter",
    "Bar strip",
    "Chart tooltip",
    "Countdown",
    "Detail key",
    "Empty state",
    "Loading state",
  ],
  [
    "Skeleton",
    "List skeleton",
    "Transcript skeleton",
    "Inline alert",
    "Text shimmer",
    "Device code",
    "Data grid",
    "Overflow fade text",
    "Fold",
    "Disclosure",
    "Swipe card",
    "Deck done",
  ],
  [
    "Page header",
    "Page layout",
    "Settings page",
    "Settings header",
    "Settings group label",
    "Setting card",
    "Setting card skeleton",
    "Settings section",
    "Status chip",
    "Settings hint",
    "Settings form",
    "Panel setting rows",
    "Top bar",
    "Phone top bar",
  ],
  [
    "Sidebar",
    "Session row",
    "Sidebar header",
    "Sidebar tool row",
    "Organization switcher",
    "Project band",
    "Incidents band",
    "Incident row",
    "Hidden row",
    "Lane header",
    "Draft row",
    "Archived row",
    "Account footer",
    "Update pill",
    "Usage meter",
    "Next unread button",
    "Row hover card",
  ],
  [
    "Message bubble",
    "Turn block",
    "Turn footer",
    "Tool call",
    "Plan checklist",
    "Typing indicator",
    "Reply suggestions",
    "Ask card",
    "Answered ask card",
    "Keychain ask card",
    "Force merge card",
    "Note bubble",
    "Session context",
    "Markdown body",
  ],
  [
    "Composer",
    "Composer context chip",
    "File chips",
    "Image thumbs",
    "Model and effort select",
    "Model mark",
    "Session header",
    "Session tabs",
    "Phone session header",
    "New session",
    "New session prompt",
  ],
  [
    "Session side panel",
    "PR status",
    "Workspace summary",
    "PR series rows",
    "PR row",
    "PR review rail",
    "PR review rows",
    "Checks popover",
    "Check status icon",
    "PR state icon",
    "Plain status badge",
    "Sandbox badge",
    "Session relations",
    "Command palette",
    "Notifications",
  ],
];
const GROUP_FILES = [
  "foundations",
  "icons",
  "button",
  "forms",
  "overlays",
  "display",
  "chrome",
  "sidebar",
  "transcript",
  "composer",
  "panel",
];
const FLAT = [
  "Glyphs",
  "Size steps",
  "Icon, caret",
  "Radius",
  "Shadows",
  "Surface ramp",
];

async function rebuildPage({
  F,
  P,
  theme,
  read,
  keep = ["Read me", "Colour"],
  only = null,
}) {
  const info = JSON.parse(
    (
      await toolsRaw.mcp__paper_desktop__get_basic_info({
        fileId: F,
        pageId: P,
      })
    ).content[1].text,
  );
  // get_basic_info lists at most 100 artboards; every library artboard has
  // 56px padding, so find_nodes returns the full set.
  info.artboards = await listArtboards(F, P);
  const del = info.artboards
    .filter((a) => !keep.includes(a.name) && (!only || only.includes(a.name)))
    .map((a) => a.id);
  if (del.length)
    await toolsRaw.mcp__paper_desktop__delete_nodes({
      fileId: F,
      nodeIds: del,
    });
  const errors = [];
  for (const g of GROUP_FILES) {
    let specs = JSON.parse(await read(`out/${g}/specimens-${theme}.json`));
    // Copy check crashed Paper on import; the stack can't be drawn statically.
    specs = specs.filter(
      (s) =>
        s.group !== "Copy check" &&
        !(
          g === "overlays" &&
          s.group === "Toast" &&
          /three toasts/.test(s.name)
        ),
    );
    if (only) specs = specs.filter((s) => only.includes(s.group));
    if (!specs.length) continue;
    const descriptions = JSON.parse(await read(`out/${g}/descriptions.json`));
    const r = await importGroups({
      F,
      P,
      specs,
      descriptions,
      theme,
      flatSections: FLAT,
    });
    for (const x of r) errors.push(...x.errors);
  }
  await layoutPage({ F, P });
  if (theme === "dark") {
    const found = JSON.parse(
      (
        await toolsRaw.mcp__paper_desktop__find_nodes({
          fileId: F,
          pageId: P,
          filters: [
            { styleName: "font-size", styleValue: "24px" },
            { styleName: "font-weight", styleValue: "600" },
          ],
        })
      ).content[1].text,
    );
    const ids = (found.results || found.nodes || []).map((n) => n.id);
    if (ids.length)
      await toolsRaw.mcp__paper_desktop__update_styles({
        fileId: F,
        updates: [{ nodeIds: ids, styles: { fontWeight: 500 } }],
      });
  }
  await toolsRaw.mcp__paper_desktop__finish_working_on_nodes({ fileId: F });
  return { errors };
}

async function layoutPage({ F, P }) {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const dec = (s) => {
    const out = [];
    let buf = 0,
      bits = 0;
    for (const ch of s) {
      const v = B.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 255);
      }
    }
    return out;
  };
  const dims = (b64) => {
    const b = dec(b64.slice(0, 40000));
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xc3)
        return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + len;
    }
    return null;
  };
  const info = JSON.parse(
    (
      await toolsRaw.mcp__paper_desktop__get_basic_info({
        fileId: F,
        pageId: P,
      })
    ).content[1].text,
  );
  // get_basic_info lists at most 100 artboards; every library artboard has
  // 56px padding, so find_nodes returns the full set.
  info.artboards = await listArtboards(F, P);
  const byName = Object.fromEntries(info.artboards.map((a) => [a.name, a.id]));
  const hs = {};
  for (const a of info.artboards) {
    const s = await toolsRaw.mcp__paper_desktop__get_screenshot({
      fileId: F,
      nodeId: a.id,
      scale: 0.25,
    });
    const d = dims(s.content.find((c) => c.type === "image").data);
    hs[a.id] = d ? d[1] * 2 : 1200;
  }
  let y = 0;
  const updates = [];
  const placed = new Set();
  for (const row of ROWS) {
    let maxH = 0,
      i = 0;
    for (const n of row) {
      const id = byName[n];
      if (!id) continue;
      placed.add(n);
      updates.push({
        nodeIds: [id],
        styles: { left: `${i * 1400}px`, top: `${y}px` },
      });
      maxH = Math.max(maxH, hs[id]);
      i++;
    }
    if (maxH) y += maxH + 600;
  }
  const rest = info.artboards.filter((a) => !placed.has(a.name));
  rest.forEach((a, i) =>
    updates.push({
      nodeIds: [a.id],
      styles: { left: `${i * 1400}px`, top: `${y}px` },
    }),
  );
  await toolsRaw.mcp__paper_desktop__update_styles({ fileId: F, updates });
  return { unplaced: rest.map((a) => a.name) };
}

async function listArtboards(F, P) {
  const r = JSON.parse(
    (
      await toolsRaw.mcp__paper_desktop__find_nodes({
        fileId: F,
        pageId: P,
        filters: [{ styleName: "padding", styleValue: "56px" }],
      })
    ).content[1].text,
  );
  const known = new Set([...ROWS.flat()]);
  return (r.nodes || []).filter(
    (n) => n.component === "Frame" && known.has(n.name),
  );
}
