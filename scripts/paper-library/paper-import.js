// Pass the real tools object as toolsRaw.
// Codemode helper. Usage inside codemode:
//   const src = (await tools.bash({command: "cat .../paper-import.js"})).output;
//   const importSpecs = new Function("tools", "return " + src)(tools);
//   await importSpecs({ F, P, artboardName, title, description, specs, flatSections });
// Builds one artboard: header, then per section a title and rows of cells
// (specimen + caption). Rows group specimens by their first name segment.
async function importSpecs({
  F,
  P,
  artboardName,
  title,
  description,
  specs,
  flatSections = [],
  width = 1280,
  existingArtboard,
  theme = "light",
}) {
  const dk = (h) =>
    theme === "dark" ? h.replace(/var\(--color-/g, "var(--dark-color-") : h;
  const tools = {
    mcp__paper_desktop__write_html: (a) =>
      toolsRaw.mcp__paper_desktop__write_html({ ...a, html: dk(a.html) }),
    mcp__paper_desktop__create_artboard: (a) =>
      toolsRaw.mcp__paper_desktop__create_artboard({
        ...a,
        styles: JSON.parse(dk(JSON.stringify(a.styles))),
      }),
    mcp__paper_desktop__update_styles: (a) =>
      toolsRaw.mcp__paper_desktop__update_styles(a),
  };
  const txt = (r) => r.content.map((c) => c.text).join("\n");
  const created = (r) => {
    for (const c of r.content) {
      try {
        const j = JSON.parse(c.text);
        if (j.createdNodes) return j.createdNodes[0].id;
        if (j.id && !j.file) return j.id;
        if (j.nodeId) return j.nodeId;
        if (j.artboardId) return j.artboardId;
      } catch {}
    }
    const m = txt(r).match(/"id":\s*"([A-Z0-9]+-\d+)"/);
    return m && m[1];
  };
  const errors = [];
  let abId = existingArtboard;
  if (!abId) {
    const ab = await tools.mcp__paper_desktop__create_artboard({
      fileId: F,
      pageId: P,
      name: artboardName,
      styles: {
        width: `${width}px`,
        height: "1200px",
        backgroundColor: "var(--color-bg)",
        padding: "56px",
        gap: "48px",
        display: "flex",
        flexDirection: "column",
      },
    });
    abId = created(ab);
    await tools.mcp__paper_desktop__write_html({
      fileId: F,
      targetNodeId: abId,
      mode: "insert-children",
      html: `<div layer-name="Header" style="display:flex;flex-direction:column;gap:6px"><span style="font-family:'SF Pro';font-size:24px;font-weight:600;line-height:30px;color:var(--color-fg)">${title}</span><span style="font-family:'SF Pro';font-size:13px;line-height:18px;color:var(--color-dim)">${description}</span></div>`,
    });
  }
  const sections = [...new Set(specs.map((s) => s.section))];
  for (const sec of sections) {
    const items = specs.filter((s) => s.section === sec);
    const stitle = sec;
    const sr = await tools.mcp__paper_desktop__write_html({
      fileId: F,
      targetNodeId: abId,
      mode: "insert-children",
      html: `<div layer-name="${stitle}" style="display:flex;flex-direction:column;gap:20px"><span layer-name="Section title" style="font-family:'SF Pro';font-size:13px;font-weight:500;line-height:18px;color:var(--color-dim)">${stitle[0].toUpperCase() + stitle.slice(1)}</span></div>`,
    });
    const secId = created(sr);
    const rows = [];
    if (flatSections.some((f) => sec.includes(f)))
      rows.push({ k: "all", items });
    else
      for (const it of items) {
        const k = it.name.split(" · ")[0];
        let r = rows.find((x) => x.k === k);
        if (!r) rows.push((r = { k, items: [] }));
        r.items.push(it);
      }
    for (const row of rows) {
      const rr = await tools.mcp__paper_desktop__write_html({
        fileId: F,
        targetNodeId: secId,
        mode: "insert-children",
        html: `<div layer-name="${row.k}" style="display:flex;flex-direction:row;flex-wrap:wrap;column-gap:32px;row-gap:28px;align-items:flex-start"></div>`,
      });
      const rowId = created(rr);
      for (const it of row.items) {
        const bg = it.on
          ? `background-color:var(${it.on.startsWith("--color-") ? it.on : { "--bg": "--color-bg", "--bg-surface": "--color-bg", "--bg-panel": "--color-panel", "--bg-raised": "--color-raised", "--sidebar-bg": "--color-sidebar", "--panel-surface": "--color-panel-surface", "--settings-plate": "--color-settings-plate" }[it.on] || "--color-panel"});`
          : "";
        const r = await tools.mcp__paper_desktop__write_html({
          fileId: F,
          targetNodeId: rowId,
          mode: "insert-children",
          html: `<div layer-name="cell" style="display:flex;flex-direction:column;gap:10px;align-items:flex-start;min-width:120px"><div layer-name="stage" style="display:flex;${bg}">${it.html}</div><span layer-name="caption" style="font-family:'SF Pro';font-size:11px;line-height:14px;color:var(--color-faint);white-space:nowrap">${it.name}</span></div>`,
        });
        if (
          r.isError ||
          /error|not found/i.test(txt(r).split("\n").slice(-3).join(" "))
        )
          errors.push(`${it.name}: ${txt(r).slice(-300)}`);
      }
    }
  }
  await tools.mcp__paper_desktop__update_styles({
    fileId: F,
    updates: [{ nodeIds: [abId], styles: { height: "fit-content" } }],
  });
  return { abId, errors };
}

// One artboard per Section.group. descriptions: { [group]: string }.
async function importGroups({
  F,
  P,
  specs,
  descriptions = {},
  flatSections = [],
  width = 1280,
  theme = "light",
}) {
  const groups = [...new Set(specs.map((s) => s.group))];
  const out = [];
  for (const g of groups) {
    const r = await importSpecs({
      F,
      P,
      artboardName: g,
      title: g,
      description: descriptions[g] || "",
      specs: specs.filter((s) => s.group === g),
      flatSections,
      width,
      theme,
    });
    out.push({ group: g, ...r });
  }
  return out;
}
