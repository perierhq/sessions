// Runs in the page. window.__paperSerialize(rootEl) -> { html, w, h }
// Turns live DOM into Paper-compatible HTML: inline styles, flex only, no
// margins, colors mapped back to the app's Tailwind color tokens.
(() => {
  // Tailwind token -> base var. Order inside each preference list decides ties.
  const TOKENS = {
    "--color-bg": "--bg",
    "--color-raised": "--bg-raised",
    "--color-sidebar": "--sidebar-bg",
    "--color-panel": "--bg-panel",
    "--color-panel-surface": "--panel-surface",
    "--color-settings-plate": "--settings-plate",
    "--color-popup": "--popup-surface",
    "--color-hover": "--hover",
    "--color-pressed": "--hover-strong",
    "--color-selected": "--selected",
    "--color-active": "--bg-active",
    "--color-line": "--border",
    "--color-line-strong": "--border-strong",
    "--color-divider": "--divider",
    "--color-divider-soft": "--divider-soft",
    "--color-fg": "--text",
    "--color-dim": "--text-dim",
    "--color-faint": "--text-faint",
    "--color-accent": "--accent",
    "--color-accent-soft": "--accent-soft",
    "--color-on-accent": "--on-accent",
    "--color-accent-hover": "--accent-hover",
    "--color-link": "--link",
    "--color-green": "--green",
    "--color-green-soft": "--green-soft",
    "--color-yellow": "--yellow",
    "--color-yellow-soft": "--yellow-soft",
    "--color-yellow-tint": "--yellow-tint",
    "--color-blue": "--blue",
    "--color-blue-soft": "--blue-soft",
    "--color-red": "--red",
    "--color-red-soft": "--red-soft",
    "--color-purple": "--purple",
    "--color-tooltip": "--tooltip-bg",
    "--color-tooltip-fg": "--tooltip-fg",
    "--color-control": "--control-surface",
    "--color-button": "--button-surface",
    "--color-code-well": "--code-well",
    "--color-code-well-line": "--code-well-line",
    "--color-code-well-ink": "--code-well-ink",
  };
  const PREF = {
    bg: [
      "--color-bg",
      "--color-button",
      "--color-popup",
      "--color-accent",
      "--color-panel",
      "--color-raised",
      "--color-sidebar",
      "--color-panel-surface",
      "--color-settings-plate",
      "--color-control",
      "--color-active",
      "--color-hover",
      "--color-pressed",
      "--color-selected",
      "--color-accent-soft",
      "--color-green-soft",
      "--color-red-soft",
      "--color-yellow-soft",
      "--color-blue-soft",
      "--color-green",
      "--color-red",
      "--color-blue",
      "--color-yellow",
      "--color-tooltip",
      "--color-code-well",
    ],
    text: [
      "--color-fg",
      "--color-dim",
      "--color-faint",
      "--color-on-accent",
      "--color-accent",
      "--color-link",
      "--color-green",
      "--color-red",
      "--color-yellow",
      "--color-blue",
      "--color-purple",
      "--color-tooltip-fg",
      "--color-code-well-ink",
    ],
    line: [
      "--color-line",
      "--color-line-strong",
      "--color-divider",
      "--color-divider-soft",
      "--color-composer-border",
    ],
  };
  const srgb = (s) =>
    s.replace(
      /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/g,
      (_, r, g, b, a) =>
        `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`,
    );
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const norm = (c) => {
    probe.style.color = "";
    probe.style.color = c;
    return srgb(getComputedStyle(probe).color)
      .replace(/, 1\)$/, ")")
      .replace(/^rgba\((\d+), (\d+), (\d+)\)$/, "rgb($1, $2, $3)");
  };
  const byValue = new Map(); // rgb string -> [token]
  for (const { name: tw, value } of (window.__TOKENS || []).filter(
    (t) => t.type === "color",
  )) {
    const n = norm(value);
    if (!byValue.has(n)) byValue.set(n, []);
    byValue.get(n).push(tw);
  }
  probe.remove();
  const isClear = (c) =>
    !c ||
    c === "transparent" ||
    /rgba\(.*,\s*0\)$/.test(c) ||
    c === "rgba(0, 0, 0, 0)";
  let hintEl = null; // element whose Tailwind classes hint the token
  const PFX = {
    bg: ["bg"],
    text: ["text", "stroke", "fill"],
    line: ["border", "ring", "divide"],
  };
  const tok = (c, kind) => {
    c = srgb(c)
      .replace(/, 1\)$/, ")")
      .replace(/^rgba\((\d+), (\d+), (\d+)\)$/, "rgb($1, $2, $3)");
    const hits = byValue.get(c);
    if (hits && hintEl && typeof hintEl.className === "string") {
      const forced = ["hover", "active", "focus-visible"].filter((st) =>
        hintEl.closest(`[data-force-${st === "focus-visible" ? "focus" : st}]`),
      );
      for (const cls of hintEl.className.split(/\s+/)) {
        const parts = cls.split(":");
        const util = parts.pop();
        if (parts.some((v) => !forced.includes(v) && !v.startsWith("data-")))
          continue;
        const m = util.match(/^([a-z]+)-([a-z0-9-]+)$/);
        if (!m || !(PFX[kind] || []).includes(m[1])) continue;
        const name = `--color-${m[2]}`;
        if (hits.includes(name)) return `var(${name})`;
      }
    }
    if (!hits) return c;
    const pref = PREF[kind] || [];
    const best = pref.find((p) => hits.includes(p)) || hits[0];
    return `var(${best})`;
  };
  const tokAll = (s, kind) =>
    srgb(s).replace(/rgba?\([^)]*\)/g, (m) =>
      tok(
        m
          .replace(/, 1\)$/, ")")
          .replace(/^rgba\((\d+), (\d+), (\d+)\)$/, "rgb($1, $2, $3)"),
        kind,
      ),
    );

  const fontFamily = (ff) => {
    if (/SF Mono|ui-monospace|monospace/.test(ff) && !/apple-system/.test(ff))
      return "'SF Mono'";
    if (/apple-system|BlinkMacSystemFont|system-ui/.test(ff)) return "'SF Pro'";
    return ff.replace(/"/g, "'");
  };
  const px = (v) =>
    v && v !== "auto" ? `${Math.round(parseFloat(v) * 100) / 100}px` : null;
  const esc = (t) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const styleStr = (o) =>
    Object.entries(o)
      .filter(([, v]) => v != null && v !== "")
      .map(
        ([k, v]) =>
          `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}: ${v}`,
      )
      .join("; ");

  function textStyles(cs) {
    const s = {
      fontFamily: fontFamily(cs.fontFamily),
      fontSize: px(cs.fontSize),
      fontWeight: cs.fontWeight,
      lineHeight:
        cs.lineHeight === "normal"
          ? `${Math.round(parseFloat(cs.fontSize) * 1.2)}px`
          : px(cs.lineHeight),
      color: tok(cs.color, "text"),
    };
    if (cs.letterSpacing !== "normal" && parseFloat(cs.letterSpacing) !== 0)
      s.letterSpacing = px(cs.letterSpacing);
    if (cs.fontStyle === "italic") s.fontStyle = "italic";
    if (cs.textTransform !== "none") s.textTransform = cs.textTransform;
    if (cs.textDecorationLine !== "none")
      s.textDecoration = cs.textDecorationLine;
    if (cs.fontVariantNumeric !== "normal")
      s.fontVariantNumeric = cs.fontVariantNumeric;
    if (cs.textAlign !== "start" && cs.textAlign !== "left")
      s.textAlign = cs.textAlign;
    if (parseFloat(cs.opacity) < 1) s.opacity = cs.opacity;
    return s;
  }

  function boxStyles(el, cs) {
    boxStyles.el = el && el.getBoundingClientRect ? el : null;
    const s = {};
    const pads = [
      cs.paddingTop,
      cs.paddingRight,
      cs.paddingBottom,
      cs.paddingLeft,
    ].map((v) => parseFloat(v));
    if (pads.some((p) => p))
      s.padding = pads.map((p) => `${Math.round(p * 100) / 100}px`).join(" ");
    if (!isClear(cs.backgroundColor))
      s.backgroundColor = tok(cs.backgroundColor, "bg");
    if (cs.backgroundImage !== "none" && !cs.backgroundImage.includes("url("))
      s.backgroundImage = tokAll(cs.backgroundImage, "bg");
    const sides = ["Top", "Right", "Bottom", "Left"];
    const bw = sides.map((d) => parseFloat(cs[`border${d}Width`]));
    const bc = sides.map((d) => cs[`border${d}Color`]);
    const bs = sides.map((d) => cs[`border${d}Style`]);
    const visible = sides.map(
      (_, i) => bw[i] > 0 && bs[i] !== "none" && !isClear(bc[i]),
    );
    if (
      visible.every(Boolean) &&
      new Set(bw).size === 1 &&
      new Set(bc).size === 1
    ) {
      s.border = `${bw[0]}px ${bs[0]} ${tok(bc[0], "line")}`;
    } else {
      sides.forEach((d, i) => {
        if (visible[i])
          s[`border${d}`] = `${bw[i]}px ${bs[i]} ${tok(bc[i], "line")}`;
      });
    }
    const r = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ];
    const bw0 = boxStyles.el ? boxStyles.el.getBoundingClientRect() : null;
    const rv = r.map((v) => {
      const n = parseFloat(v) || 0;
      return Math.min(
        String(v).trim().endsWith("%") && bw0
          ? (n / 100) * Math.min(bw0.width, bw0.height)
          : n,
        9999,
      );
    });
    if (rv.some((x) => x))
      s.borderRadius =
        new Set(rv).size === 1
          ? `${Math.round(rv[0] * 100) / 100}px`
          : rv.map((x) => `${Math.round(x * 100) / 100}px`).join(" ");
    const shadows = [];
    if (
      cs.outlineStyle !== "none" &&
      parseFloat(cs.outlineWidth) > 0 &&
      !isClear(cs.outlineColor)
    ) {
      const off = Math.max(0, parseFloat(cs.outlineOffset) || 0),
        w = parseFloat(cs.outlineWidth);
      if (off > 0) shadows.push(`0px 0px 0px ${off}px var(--color-bg)`);
      shadows.push(
        `0px 0px 0px ${off + w}px ${tok(srgb(cs.outlineColor), "line")}`,
      );
    }
    if (cs.boxShadow !== "none") shadows.push(tokAll(cs.boxShadow, "line"));
    if (shadows.length) s.boxShadow = shadows.join(", ");
    if (parseFloat(cs.opacity) < 1) s.opacity = cs.opacity;
    if (
      cs.overflow.includes("hidden") ||
      cs.overflow.includes("clip") ||
      cs.overflow.includes("auto") ||
      cs.overflow.includes("scroll")
    )
      s.overflow = "hidden";
    if (cs.filter !== "none") s.filter = cs.filter;
    if (cs.backdropFilter && cs.backdropFilter !== "none")
      s.backdropFilter = cs.backdropFilter;
    const tf = transformOf(cs, boxStyles.el);
    if (tf) s.transform = tf;
    const mask =
      cs.maskImage && cs.maskImage !== "none"
        ? cs.maskImage
        : cs.webkitMaskImage && cs.webkitMaskImage !== "none"
          ? cs.webkitMaskImage
          : null;
    if (mask && !mask.includes("url(")) s.maskImage = mask;
    return s;
  }

  const R = (v) => Math.round(v * 100) / 100;
  // Does the box hug its content on this axis? (max/min caps lifted while measuring)
  function hugs(el, axis) {
    const prop = axis === "x" ? "width" : "height";
    const cap =
      axis === "x" ? ["maxWidth", "minWidth"] : ["maxHeight", "minHeight"];
    const before = el.getBoundingClientRect()[prop];
    const old = [
      el.style[prop],
      el.style[cap[0]],
      el.style[cap[1]],
      el.style.flex,
    ];
    el.style[prop] = axis === "x" ? "max-content" : "auto";
    el.style[cap[0]] = "none";
    el.style[cap[1]] = "0px";
    el.style.flex = "none";
    const after = el.getBoundingClientRect()[prop];
    [el.style[prop], el.style[cap[0]], el.style[cap[1]], el.style.flex] = old;
    return Math.abs(before - after) < 0.6;
  }
  const ALIGN = {
    "flow-start": "flex-start",
    "flow-end": "flex-end",
    start: "flex-start",
    end: "flex-end",
    "self-start": "flex-start",
    "self-end": "flex-end",
    left: "flex-start",
    right: "flex-end",
    normal: "stretch",
    legacy: "stretch",
    "anchor-center": "center",
    baseline: "baseline",
    "first baseline": "baseline",
    "last baseline": "baseline",
  };
  const al = (v) => ALIGN[v] || v;
  const JUST = {
    normal: "flex-start",
    "flow-start": "flex-start",
    "flow-end": "flex-end",
    start: "flex-start",
    end: "flex-end",
    left: "flex-start",
    right: "flex-end",
    stretch: "flex-start",
  };
  const ju = (v) => JUST[v] || v;
  const contentBox = (r, cs) => ({
    left: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    right:
      r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
    top: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    bottom:
      r.bottom -
      parseFloat(cs.borderBottomWidth) -
      parseFloat(cs.paddingBottom),
  });
  const trackCount = (v) =>
    v && v !== "none" ? v.split(/\s+(?![^(]*\))/).filter(Boolean).length : 1;

  // How a container lays out its children, translated to flex.
  function layoutOf(cs) {
    const d = cs.display;
    if (d.includes("flex")) {
      const rev = cs.flexDirection.endsWith("-reverse");
      let jc = ju(cs.justifyContent);
      if (rev)
        jc =
          jc === "flex-start"
            ? "flex-end"
            : jc === "flex-end"
              ? "flex-start"
              : jc;
      const L = {
        kind: "flex",
        flexDirection: cs.flexDirection.replace("-reverse", ""),
        alignItems: al(cs.alignItems),
        justifyContent: jc,
      };
      if (cs.flexWrap !== "nowrap") L.flexWrap = cs.flexWrap;
      const rg = parseFloat(cs.rowGap) || 0,
        cg = parseFloat(cs.columnGap) || 0;
      L.gap = cs.flexDirection.startsWith("column") ? rg : cg;
      if (L.flexWrap) {
        L.rowGap = rg;
        L.columnGap = cg;
      }
      return L;
    }
    if (d.includes("grid")) {
      const cols = trackCount(cs.gridTemplateColumns);
      const rg = parseFloat(cs.rowGap) || 0,
        cg = parseFloat(cs.columnGap) || 0;
      if (cols > 1 && trackCount(cs.gridTemplateRows) <= 1)
        return {
          kind: "grid",
          flexDirection: "row",
          alignItems: al(cs.alignItems),
          justifyContent: "flex-start",
          gap: cg,
        };
      if (cols > 1)
        return {
          kind: "grid",
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: al(cs.alignItems),
          justifyContent: "flex-start",
          rowGap: rg,
          columnGap: cg,
          gap: cg,
        };
      const v = al(cs.alignItems);
      return {
        kind: "grid",
        flexDirection: "column",
        alignItems: al(cs.justifyItems),
        justifyContent:
          v === "center"
            ? "center"
            : v === "flex-end"
              ? "flex-end"
              : "flex-start",
        gap: rg,
      };
    }
    if (d === "table-row")
      return {
        kind: "table-row",
        flexDirection: "row",
        alignItems: "stretch",
        justifyContent: "flex-start",
        gap: 0,
      };
    return {
      kind: d.startsWith("table") ? "table" : "block",
      flexDirection: "column",
      alignItems: "stretch",
      justifyContent: "flex-start",
      gap: 0,
      textAlign: cs.textAlign,
    };
  }

  function translateOf(cs, el) {
    if (!cs.translate || cs.translate === "none") return [0, 0];
    const [x, y = "0px"] = cs.translate.split(" ");
    const w =
      el && el.offsetWidth != null
        ? el.offsetWidth
        : el
          ? el.getBoundingClientRect().width
          : 0;
    const h =
      el && el.offsetHeight != null
        ? el.offsetHeight
        : el
          ? el.getBoundingClientRect().height
          : 0;
    const res = (v, size) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0;
    return [res(x, w), res(y, h)];
  }
  function transformOf(cs, el) {
    const t = [];
    if (cs.translate && cs.translate !== "none") {
      const [x, y] = translateOf(cs, el);
      if (x || y) t.push(`translate(${R(x)}px, ${R(y)}px)`);
    }
    if (cs.rotate && cs.rotate !== "none") t.push(`rotate(${cs.rotate})`);
    if (cs.scale && cs.scale !== "none") {
      const [x, y = x] = cs.scale.split(" ");
      t.push(`scale(${x}, ${y})`);
    }
    if (cs.transform && cs.transform !== "none") t.push(cs.transform);
    return t.length ? t.join(" ") : null;
  }

  const rectOf = (n) => {
    if (n.nodeType === 1) return n.getBoundingClientRect();
    const rg = document.createRange();
    rg.selectNodeContents(n);
    const b = rg.getBoundingClientRect();
    // Trim the leading/trailing whitespace a text run carries.
    return b;
  };
  const isInlineLevel = (n) =>
    n.nodeType === 3 ||
    /^inline/.test(getComputedStyle(n).display) ||
    n.tagName.toLowerCase() === "svg";
  const childNodesOf = (el) => {
    const out = [];
    const src = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : [...el.childNodes];
    for (const n of src) {
      if (n.nodeType === 1 && n.tagName === "SLOT") {
        out.push(...n.assignedNodes({ flatten: true }));
        continue;
      }
      if (n.nodeType === 1 && getComputedStyle(n).display === "contents") {
        out.push(...childNodesOf(n));
        continue;
      }
      out.push(n);
    }
    return out;
  };
  const visibleKids = (el) =>
    childNodesOf(el).filter((n) => {
      if (n.nodeType === 3) return n.textContent.trim().length > 0;
      if (n.nodeType !== 1) return false;
      const cs = getComputedStyle(n);
      if (cs.display === "none") return false;
      if (
        n.tagName === "TEMPLATE" ||
        n.tagName === "SCRIPT" ||
        n.tagName === "STYLE"
      )
        return false;
      const r = n.getBoundingClientRect();
      if (r.width === 0 && r.height === 0 && cs.position !== "absolute")
        return false;
      if (
        cs.clip === "rect(0px, 0px, 0px, 0px)" ||
        (r.width <= 2 && r.height <= 2 && cs.position === "absolute")
      )
        return false;
      if (/inset\(50%|inset\(100%/.test(cs.clipPath)) return false;
      return true;
    });
  const isInlineTextish = (n) => {
    if (n.nodeType === 3) return true;
    if (
      /^(svg|img|input|select|textarea|button|video|canvas)$/i.test(n.tagName)
    )
      return false;
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden") return false;
    return (
      cs.display === "inline" &&
      [...n.childNodes].every(
        (c) => c.nodeType === 3 || (c.nodeType === 1 && isInlineTextish(c)),
      )
    );
  };

  function svg(el, extra) {
    const clone = el.cloneNode(true);
    const all = [el, ...el.querySelectorAll("*")];
    const call = [clone, ...clone.querySelectorAll("*")];
    all.forEach((n, i) => {
      const cs = getComputedStyle(n);
      hintEl = n;
      const c = call[i];
      for (const attr of ["stroke", "fill"]) {
        const a = n.getAttribute(attr);
        const v = cs[attr];
        if (a === "currentColor") c.setAttribute(attr, tok(cs.color, "text"));
        else if (a && a.startsWith("var("))
          c.setAttribute(attr, tok(v, "text"));
        else if (
          i > 0 &&
          v &&
          v !== "none" &&
          !v.startsWith("url(") &&
          (a == null || n.getAttribute("class"))
        ) {
          // Colour set from CSS (a class), not an attribute.
          if (
            a == null &&
            attr === "fill" &&
            /rgb\(0, 0, 0\)/.test(v) &&
            !n.getAttribute("class")
          )
            continue;
          c.setAttribute(attr, tok(srgb(v), "text"));
        } else if (
          i > 0 &&
          v === "none" &&
          a == null &&
          n.getAttribute("class")
        )
          c.setAttribute(attr, "none");
      }
      if (i > 0 && n.getAttribute("class")) {
        if (
          cs.strokeWidth &&
          cs.strokeWidth !== "1px" &&
          !n.getAttribute("stroke-width")
        )
          c.setAttribute("stroke-width", parseFloat(cs.strokeWidth));
        if (cs.strokeDasharray && cs.strokeDasharray !== "none")
          c.setAttribute(
            "stroke-dasharray",
            cs.strokeDasharray.replace(/px/g, ""),
          );
        if (cs.strokeDashoffset && parseFloat(cs.strokeDashoffset))
          c.setAttribute("stroke-dashoffset", parseFloat(cs.strokeDashoffset));
        if (
          cs.strokeLinecap &&
          cs.strokeLinecap !== "butt" &&
          !n.getAttribute("stroke-linecap")
        )
          c.setAttribute("stroke-linecap", cs.strokeLinecap);
        if (parseFloat(cs.opacity) < 1) c.setAttribute("opacity", cs.opacity);
      }
      c.removeAttribute("class");
      c.removeAttribute("style");
      c.removeAttribute("aria-hidden");
    });
    // Measure the untransformed box (a rotated glyph reports its rotated bounds).
    const ccs = getComputedStyle(el);
    const br = el.getBoundingClientRect();
    const r = {
      width: ccs.width.endsWith("px") ? parseFloat(ccs.width) : br.width,
      height: ccs.height.endsWith("px") ? parseFloat(ccs.height) : br.height,
    };
    clone.setAttribute("width", `${Math.round(r.width)}`);
    clone.setAttribute("height", `${Math.round(r.height)}`);
    const cs = getComputedStyle(el);
    const st = {
      width: `${Math.round(r.width)}px`,
      height: `${Math.round(r.height)}px`,
      flexShrink: 0,
      ...extra,
    };
    if (parseFloat(cs.opacity) < 1) st.opacity = cs.opacity;
    const tf = transformOf(cs, el);
    if (tf) st.transform = tf;
    clone.setAttribute("style", styleStr(st));
    return clone.outerHTML;
  }

  function pseudo(el, which, rect) {
    const cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === "none" || cs.content === "normal")
      return "";
    if (cs.display === "none") return "";
    const b = boxStyles(el, cs);
    if (!b.backgroundColor && !b.border && !b.boxShadow && !b.backgroundImage)
      return "";
    const w = parseFloat(cs.width),
      h = parseFloat(cs.height);
    if (!(w > 0 && h > 0)) return "";
    const st = {
      position: "absolute",
      left: px(cs.left) || "0px",
      top: px(cs.top) || "0px",
      width: `${w}px`,
      height: `${h}px`,
      ...b,
    };
    delete st.padding;
    return `<div layer-name="${which.replace("::", "")}" style="${styleStr(st)}"></div>`;
  }

  function node(el, ctx) {
    if (el.nodeType === 1 && !ctx.inMarker) {
      const lcs = getComputedStyle(el);
      if (lcs.display === "list-item" && lcs.listStyleType !== "none") {
        const parent = el.parentElement;
        const items = [...parent.children].filter(
          (c) => getComputedStyle(c).display === "list-item",
        );
        const idx =
          items.indexOf(el) + parseInt(parent.getAttribute("start") || "1", 10);
        const ordered = /decimal|alpha|roman/.test(lcs.listStyleType);
        const marker = ordered
          ? `${idx}.`
          : lcs.listStyleType === "circle"
            ? "◦"
            : lcs.listStyleType === "square"
              ? "▪"
              : "•";
        const inner = node(el, { ...ctx, inMarker: true });
        const ts = textStyles(lcs);
        const lr = el.getBoundingClientRect();
        const mw = 24;
        return `<div layer-name="list item" style="${styleStr({ display: "flex", flexDirection: "row", alignItems: "flex-start", alignSelf: "stretch", position: "relative" })}"><span layer-name="marker" style="${styleStr({ ...ts, position: "absolute", left: `${-mw - 4}px`, top: "0px", width: `${mw}px`, textAlign: "right", whiteSpace: "nowrap", color: lcs.color ? tok(srgb(getComputedStyle(el, "::marker").color || lcs.color), "text") : ts.color })}">${marker}</span>${inner.replace(/^<(\w+)([^>]*?) style="/, `<$1$2 style="flex-grow: 1; flex-basis: 0px; min-width: 0px; `)}</div>`;
      }
    }
    if (el.nodeType === 3) return esc(el.textContent.replace(/\s+/g, " "));
    const cs = getComputedStyle(el);
    hintEl = el;
    const r = el.getBoundingClientRect();
    if (cs.visibility === "hidden" && !ctx.root) {
      if (["absolute", "fixed"].includes(cs.position)) return "";
      return `<div layer-name="placeholder" style="width: ${R(r.width)}px; height: ${R(r.height)}px; flex-shrink: 0"></div>`;
    }
    const sizing = {};
    const P = ctx.parentLayout; // parent layout (flex-translated)
    const pcs = ctx.parentCs;
    const absolute = cs.position === "absolute" || cs.position === "fixed";

    if (ctx.root || !P) {
      const insetX = absolute && cs.left !== "auto" && cs.right !== "auto";
      const insetY = absolute && cs.top !== "auto" && cs.bottom !== "auto";
      if (insetX || !hugs(el, "x")) sizing.width = `${R(r.width)}px`;
      if (insetY || !hugs(el, "y")) sizing.height = `${R(r.height)}px`;
    } else if (absolute || ctx.absLayout) {
      sizing.position = "absolute";
      if (
        !ctx.absLayout &&
        el.offsetParent &&
        el.offsetParent === el.parentElement
      ) {
        sizing.left = `${R(el.offsetLeft)}px`;
        sizing.top = `${R(el.offsetTop)}px`;
        sizing.width = `${R(el.offsetWidth)}px`;
        sizing.height = `${R(el.offsetHeight)}px`;
      } else {
        const [tx, ty] = translateOf(cs, el);
        sizing.left = `${R(r.left - ctx.parentRect.left - parseFloat(pcs.borderLeftWidth) - tx)}px`;
        sizing.top = `${R(r.top - ctx.parentRect.top - parseFloat(pcs.borderTopWidth) - ty)}px`;
        sizing.width = `${R(r.width)}px`;
        sizing.height = `${R(r.height)}px`;
      }
    } else {
      const row = P.flexDirection.startsWith("row");
      const cb = contentBox(ctx.parentRect, pcs);
      const grow =
        P.kind === "flex" &&
        parseFloat(cs.flexGrow) > 0 &&
        (row ? ctx.definiteX : ctx.definiteY);
      // Cross axis.
      let align =
        cs.alignSelf !== "auto" && cs.alignSelf !== "normal"
          ? al(cs.alignSelf)
          : P.alignItems;
      if (P.kind === "block" && cs.display.startsWith("inline"))
        align =
          P.textAlign === "center"
            ? "center"
            : P.textAlign === "right" || P.textAlign === "end"
              ? "flex-end"
              : "flex-start";
      const crossSize = row ? r.height : r.width;
      const crossAvail = row ? cb.bottom - cb.top : cb.right - cb.left;
      const crossOff = row ? r.top - cb.top : r.left - cb.left;
      let crossFixed = false;
      const crossDefinite = row ? ctx.definiteY : ctx.definiteX;
      if (align === "stretch") {
        if (Math.abs(crossSize - crossAvail) < 1 && crossDefinite)
          sizing.alignSelf = "stretch";
        else if (Math.abs(crossSize - crossAvail) < 1) {
          crossFixed = true;
          sizing.alignSelf = "stretch";
        } else {
          crossFixed = true;
          const endGap = crossAvail - crossOff - crossSize;
          sizing.alignSelf =
            crossSize > crossAvail
              ? "flex-start"
              : Math.abs(crossOff - endGap) < 1 && crossOff > 1
                ? "center"
                : crossOff > endGap + 1
                  ? "flex-end"
                  : "flex-start";
        }
      } else {
        if (cs.alignSelf !== "auto" && cs.alignSelf !== "normal")
          sizing.alignSelf = al(cs.alignSelf);
        else if (align !== P.alignItems) sizing.alignSelf = align;
        crossFixed = !hugs(el, row ? "y" : "x");
      }
      if (crossFixed) sizing[row ? "height" : "width"] = `${R(crossSize)}px`;
      // Main axis.
      if (P.kind === "table-row" || cs.display === "table-cell")
        sizing[row ? "width" : "height"] = `${R(row ? r.width : r.height)}px`;
      else if (grow) {
        sizing.flexGrow = cs.flexGrow;
        sizing.flexBasis = "0px";
      } else if (!hugs(el, row ? "x" : "y"))
        sizing[row ? "width" : "height"] = `${R(row ? r.width : r.height)}px`;
      if (parseFloat(cs.flexShrink) === 0 || sizing[row ? "width" : "height"])
        sizing.flexShrink = 0;
    }
    if (
      cs.minHeight !== "auto" &&
      parseFloat(cs.minHeight) > 0 &&
      !sizing.height
    )
      sizing.minHeight = px(cs.minHeight);
    if (cs.minWidth !== "auto" && parseFloat(cs.minWidth) > 0 && !sizing.width)
      sizing.minWidth = px(cs.minWidth);
    if (cs.maxWidth !== "none" && cs.maxWidth.endsWith("px") && !sizing.width)
      sizing.maxWidth = px(cs.maxWidth);

    if (el.tagName.toLowerCase() === "svg") return svg(el, sizing);

    const name =
      el.getAttribute("data-slot") ||
      el.getAttribute("aria-label") ||
      el.getAttribute("role") ||
      el.tagName.toLowerCase();
    const box = boxStyles(el, cs);
    if (ctx.root && box.transform) {
      const t = box.transform
        .replace(/translate\([^)]*\)\s*/g, "")
        .replace(
          /matrix\(([^,]+), ([^,]+), ([^,]+), ([^,]+), [^,]+, [^)]+\)/,
          "matrix($1, $2, $3, $4, 0, 0)",
        )
        .trim();
      if (!t || t === "matrix(1, 0, 0, 1, 0, 0)") delete box.transform;
      else box.transform = t;
    }
    if (
      (cs.position === "relative" || cs.position === "sticky") &&
      !absolute &&
      !sizing.position
    )
      box.position = "relative";

    // Form fields: draw the value or the placeholder as text.
    if (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT"
    ) {
      if (el.type === "checkbox" || el.type === "radio" || el.type === "hidden")
        return "";
      const isSel = el.tagName === "SELECT";
      const value = isSel ? (el.selectedOptions[0]?.text ?? "") : el.value;
      const val = value || el.placeholder || "";
      const tcs = value ? cs : getComputedStyle(el, "::placeholder");
      const ts = textStyles(cs);
      ts.color = tok(srgb(tcs.color), "text");
      delete ts.opacity;
      const ta = el.tagName === "TEXTAREA";
      const st = {
        display: "flex",
        alignItems: ta ? "flex-start" : "center",
        ...box,
        ...sizing,
      };
      if (ta) {
        st.height = `${R(r.height)}px`;
        delete st.minHeight;
      }
      const cb = contentBox(r, cs);
      const span = ta
        ? { ...ts, whiteSpace: "pre-wrap", width: `${R(cb.right - cb.left)}px` }
        : {
            ...ts,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "clip",
            flexShrink: 1,
            minWidth: "0px",
          };
      return `<div layer-name="${el.tagName.toLowerCase()}" style="${styleStr(st)}"><span style="${styleStr(span)}">${esc(val)}</span></div>`;
    }
    if (el.tagName === "IMG") {
      const src = el.currentSrc || el.src || "";
      const st = {
        ...box,
        ...sizing,
        width: `${R(r.width)}px`,
        height: `${R(r.height)}px`,
        objectFit: cs.objectFit !== "fill" ? cs.objectFit : null,
      };
      if (!src)
        return `<div layer-name="image" style="${styleStr({ ...st, backgroundColor: box.backgroundColor || "var(--color-active)" })}"></div>`;
      return `<img layer-name="image" src="__IMG__${esc(src)}" style="${styleStr(st)}">`;
    }

    let kids = visibleKids(el);
    if (kids.some((k) => k.nodeType === 1 && getComputedStyle(k).order !== "0"))
      kids = kids
        .map((k, i) => [k, i])
        .sort(
          (a, b) =>
            (a[0].nodeType === 1 ? +getComputedStyle(a[0]).order : 0) -
              (b[0].nodeType === 1 ? +getComputedStyle(b[0]).order : 0) ||
            a[1] - b[1],
        )
        .map((x) => x[0]);
    const reversed =
      cs.display.includes("flex") && cs.flexDirection.endsWith("-reverse");
    if (reversed) kids = kids.slice().reverse();
    const before = pseudo(el, "::before", r);
    const after = pseudo(el, "::after", r);
    const needsRel =
      kids.some(
        (k) =>
          k.nodeType === 1 &&
          ["absolute", "fixed"].includes(getComputedStyle(k).position),
      ) ||
      before ||
      after;
    let L = layoutOf(cs);
    if (L.kind === "grid") {
      // Read the grid's shape from where its items actually are (subgrid,
      // spans and auto-placement make the track lists unreliable).
      const fk = kids.filter(
        (k) =>
          k.nodeType === 1 &&
          !["absolute", "fixed"].includes(getComputedStyle(k).position),
      );
      if (fk.length > 1) {
        const rs = fk.map((k) => k.getBoundingClientRect());
        const lefts = new Set(rs.map((x) => Math.round(x.left))),
          tops = new Set(rs.map((x) => Math.round(x.top)));
        const rg = parseFloat(cs.rowGap) || 0,
          cg = parseFloat(cs.columnGap) || 0;
        if (lefts.size === 1) {
          const v = al(cs.alignItems);
          L = {
            kind: "grid",
            flexDirection: "column",
            alignItems: al(cs.justifyItems),
            justifyContent:
              v === "center"
                ? "center"
                : v === "flex-end"
                  ? "flex-end"
                  : "flex-start",
            gap: rg,
          };
        } else if (tops.size === 1)
          L = {
            kind: "grid",
            flexDirection: "row",
            alignItems: al(cs.alignItems),
            justifyContent: "flex-start",
            gap: cg,
          };
        else
          L = {
            kind: "grid",
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: al(cs.alignItems),
            justifyContent: "flex-start",
            rowGap: rg,
            columnGap: cg,
            gap: cg,
          };
      }
    }
    if (
      L.kind === "block" &&
      kids.length > 1 &&
      kids.every(isInlineLevel) &&
      !kids.every(isInlineTextish)
    ) {
      const tops = kids.map((k) => rectOf(k)),
        lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      const minT = Math.min(...tops.map((t) => t.top)),
        maxB = Math.max(...tops.map((t) => t.bottom));
      if (maxB - minT < lh * 1.6)
        L = {
          kind: "inline-row",
          flexDirection: "row",
          alignItems: "center",
          justifyContent:
            cs.textAlign === "center"
              ? "center"
              : /right|end/.test(cs.textAlign)
                ? "flex-end"
                : "flex-start",
          gap: 0,
        };
    }

    // Text leaf / rich text paragraph.
    if (kids.length > 0 && kids.every(isInlineTextish) && !before && !after) {
      const ts = textStyles(cs);
      const pre =
        cs.whiteSpace.startsWith("pre") || cs.whiteSpace === "break-spaces";
      const raw = childNodesOf(el).filter(
        (k) =>
          k.nodeType === 3 ||
          (k.nodeType === 1 && getComputedStyle(k).display !== "none"),
      );
      const inner = pre
        ? raw
            .map((k) =>
              k.nodeType === 3 ? esc(k.textContent) : richSpan(k, cs, true),
            )
            .join("")
        : raw
            .map((k) =>
              k.nodeType === 3
                ? esc(k.textContent.replace(/\s+/g, " "))
                : richSpan(k, cs),
            )
            .join("")
            .replace(/^\s+|\s+$/g, "");
      const lh = parseFloat(ts.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const cb = contentBox(r, cs);
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const lineTops = new Set(
        [...rg.getClientRects()]
          .filter((q) => q.width > 0.5)
          .map((q) => Math.round(q.bottom)),
      );
      const single = lineTops.size <= 1;
      const hasBox = Object.keys(box).length > 0 || L.kind !== "block";
      if (pre) ts.whiteSpace = cs.whiteSpace;
      else if (single || cs.whiteSpace === "nowrap") ts.whiteSpace = "nowrap";
      const overflowing = el.scrollWidth > el.clientWidth + 0.5;
      if (cs.textOverflow === "ellipsis") {
        ts.textOverflow = "ellipsis";
        ts.overflow = "hidden";
      }
      if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") {
        ts.overflow = "hidden";
        ts.height = `${R(cb.bottom - cb.top)}px`;
      }
      if (cs.position !== "static" && !absolute && !sizing.position)
        ts.position = "relative";
      if (hasBox) {
        delete ts.opacity;
        let jc, ai;
        if (L.kind === "flex") {
          jc = L.justifyContent;
          ai = L.alignItems === "stretch" ? "center" : L.alignItems;
        } else if (L.kind === "grid") {
          jc = L.justifyContent;
          ai =
            cs.justifyItems === "center" || cs.textAlign === "center"
              ? "center"
              : "flex-start";
        } else {
          jc = "flex-start";
          ai =
            cs.textAlign === "center"
              ? "center"
              : /right|end/.test(cs.textAlign)
                ? "flex-end"
                : "flex-start";
        }
        const isCol =
          L.kind !== "flex" ? true : L.flexDirection.startsWith("column");
        const st = {
          display: "flex",
          flexDirection: isCol ? "column" : "row",
          alignItems: ai,
          justifyContent: jc,
          ...box,
          ...sizing,
        };
        if (L.kind !== "flex") {
          st.justifyContent =
            L.kind === "grid" ? L.justifyContent : "flex-start";
        }
        if (needsRel) st.position = st.position || "relative";
        const tsz = { ...ts };
        if (!single && !pre && ts.whiteSpace !== "nowrap")
          tsz.width = `${R(cb.right - cb.left)}px`;
        if (ts.textOverflow) {
          tsz.minWidth = "0px";
          tsz.flexShrink = 1;
          if (overflowing) tsz.width = `${R(cb.right - cb.left)}px`;
        }
        return `<div layer-name="${name}" style="${styleStr(st)}"><span style="${styleStr(tsz)}">${inner}</span></div>`;
      }
      const st = { ...ts, ...sizing };
      if (!single && !st.width && !pre && ts.whiteSpace !== "nowrap")
        st.width = `${R(r.width)}px`;
      if (ts.textOverflow && overflowing && !st.width)
        st.width = `${R(r.width)}px`;
      if (ts.textOverflow && !overflowing) {
        delete st.width;
        st.flexShrink = 1;
        st.minWidth = "0px";
      }
      return `<span layer-name="${name}" style="${styleStr(st)}">${inner}</span>`;
    }

    // Container.
    const st = { ...sizing, display: "flex", flexDirection: L.flexDirection };
    if (L.flexWrap) st.flexWrap = L.flexWrap;
    st.alignItems = L.alignItems;
    if (L.justifyContent && L.justifyContent !== "flex-start")
      st.justifyContent = L.justifyContent;
    if (L.flexWrap) {
      if (L.rowGap) st.rowGap = `${L.rowGap}px`;
      if (L.columnGap) st.columnGap = `${L.columnGap}px`;
    } else if (L.gap) st.gap = `${L.gap}px`;
    if (needsRel) st.position = st.position || "relative";
    Object.assign(st, box);

    // Main-axis spacing from real positions. Keep the gap when it explains
    // every distance; otherwise drop it and write each distance as a spacer.
    const row = L.flexDirection.startsWith("row");
    const flowKids = kids.filter(
      (k) =>
        k.nodeType === 3 ||
        !["absolute", "fixed"].includes(getComputedStyle(k).position),
    );
    const cb = contentBox(r, cs);
    const spacers = new Map();
    let absLayout = false,
      trail = 0;
    const hasMargins = flowKids.some((k) => {
      if (k.nodeType === 3) return false;
      const m = getComputedStyle(k);
      return row
        ? parseFloat(m.marginLeft) || parseFloat(m.marginRight)
        : parseFloat(m.marginTop) || parseFloat(m.marginBottom);
    });
    const oneLine =
      flowKids.length > 0 &&
      flowKids.every(
        (k) => Math.abs(rectOf(k).top - rectOf(flowKids[0]).top) < 1 || !row,
      );
    if (
      (!L.flexWrap || (row && oneLine)) &&
      flowKids.length &&
      (hasMargins ||
        L.kind === "block" ||
        L.kind === "table" ||
        L.kind === "inline-row")
    ) {
      const rects = flowKids.map(rectOf);
      const dists = rects
        .slice(1)
        .map((kr, i) =>
          row ? kr.left - rects[i].right : kr.top - rects[i].bottom,
        );
      const lead = row ? rects[0].left - cb.left : rects[0].top - cb.top;
      const g = L.gap || 0;
      const startish = !L.justifyContent || L.justifyContent === "flex-start";
      const explained =
        dists.every((d) => Math.abs(d - g) < 0.6) &&
        (!startish || Math.abs(lead) < 0.6);
      if (!explained) {
        delete st.gap;
        delete st.justifyContent;
        delete st.flexWrap;
        delete st.rowGap;
        delete st.columnGap;
        if (dists.some((d) => d < -0.6) || lead < -0.6)
          absLayout = true; // overlap or negative margins: place exactly
        else {
          if (lead > 0.6) spacers.set(flowKids[0], lead);
          dists.forEach((d, i) => {
            if (d > 0.6) spacers.set(flowKids[i + 1], d);
          });
          const last = rects[rects.length - 1];
          const t = row ? cb.right - last.right : cb.bottom - last.bottom;
          if (hasMargins && t > 0.6 && !(row ? st.width : st.height)) trail = t;
        }
      }
    }
    // A grid whose items don't read left-to-right, top-to-bottom can't be a wrapping row.
    if (L.kind === "grid" && L.flexDirection === "row" && flowKids.length > 1) {
      const rs = flowKids.map(rectOf);
      for (let i = 1; i < rs.length && !absLayout; i++) {
        const sameRow = Math.abs(rs[i].top - rs[i - 1].top) < 1;
        if (
          sameRow
            ? rs[i].left < rs[i - 1].right - 1
            : rs[i].top < rs[i - 1].bottom - 1
        )
          absLayout = true;
      }
      if (!L.flexWrap && rs.some((x) => Math.abs(x.top - rs[0].top) > 1))
        absLayout = true;
    }
    if (absLayout) {
      st.position = "relative";
      st.width = st.width || `${R(r.width)}px`;
      st.height = st.height || `${R(r.height)}px`;
      delete st.gap;
      delete st.justifyContent;
    }
    const pRow = P && P.flexDirection.startsWith("row");
    const definiteX = !!(
      st.width ||
      (st.flexGrow && pRow) ||
      (st.alignSelf === "stretch" && P && !pRow && ctx.definiteX)
    );
    const definiteY = !!(
      st.height ||
      (st.flexGrow && P && !pRow) ||
      (st.alignSelf === "stretch" && pRow && ctx.definiteY)
    );
    const childCtx = {
      parentLayout: L,
      parentCs: cs,
      parentRect: r,
      definiteX,
      definiteY,
      absLayout,
    };
    const wraps = new Map();
    if (flowKids.length && !L.flexWrap) {
      const bl = parseFloat(cs.borderLeftWidth),
        br = parseFloat(cs.borderRightWidth),
        bt = parseFloat(cs.borderTopWidth);
      const pad = {
        l: parseFloat(cs.paddingLeft),
        r: parseFloat(cs.paddingRight),
        t: parseFloat(cs.paddingTop),
      };
      const rects = flowKids.map(rectOf);
      if (!row) {
        const li = rects.map((kr) => kr.left - r.left - bl),
          ri = rects.map((kr) => r.right - br - kr.right);
        const minL = Math.max(0, Math.min(...li)),
          minR = Math.max(0, Math.min(...ri));
        if (minL < pad.l - 0.6 || minR < pad.r - 0.6) {
          const nl = Math.min(pad.l, minL),
            nr = Math.min(pad.r, minR);
          flowKids.forEach((k, i) => {
            const wl = Math.max(0, Math.min(li[i], pad.l) - nl),
              wr = Math.max(0, Math.min(ri[i], pad.r) - nr);
            if (wl > 0.6 || wr > 0.6)
              wraps.set(k, {
                paddingLeft: `${R(wl)}px`,
                paddingRight: `${R(wr)}px`,
              });
          });
          pad.l = nl;
          pad.r = nr;
        }
        const lead = rects[0].top - r.top - bt;
        if (lead < pad.t - 0.6 && lead >= 0) {
          pad.t = lead;
          spacers.delete(flowKids[0]);
        }
      } else {
        const lead = rects[0].left - r.left - bl;
        if (lead < pad.l - 0.6 && lead >= 0) {
          pad.l = lead;
          spacers.delete(flowKids[0]);
        }
      }
      const cur = [
        cs.paddingTop,
        cs.paddingRight,
        cs.paddingBottom,
        cs.paddingLeft,
      ].map(parseFloat);
      const next = [pad.t, pad.r, cur[2], pad.l];
      if (next.some((v, i) => Math.abs(v - cur[i]) > 0.01))
        st.padding = next.map((v) => `${R(v)}px`).join(" ");
    }
    const parts = [];
    const placed = [];
    const overlaps = (a, b) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left),
        h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return (
        w > 1 &&
        h > 1 &&
        w * h > 0.5 * Math.min(a.width * a.height, b.width * b.height)
      );
    };
    for (const k of kids) {
      const sp0 = spacers.get(k);
      if (sp0 && k.nodeType === 3) {
        parts.push(
          `<div layer-name="spacer" style="${styleStr(row ? { width: `${R(sp0)}px`, flexShrink: 0 } : { height: `${R(sp0)}px`, flexShrink: 0 })}"></div>`,
        );
        spacers.delete(k);
      }
      if (L.kind === "grid" && k.nodeType === 1) {
        const kcs = getComputedStyle(k);
        if (!["absolute", "fixed"].includes(kcs.position)) {
          const kr = k.getBoundingClientRect();
          if (placed.some((p) => overlaps(p, kr))) {
            if (kcs.visibility === "hidden" || parseFloat(kcs.opacity) === 0)
              continue;
            st.position = "relative";
            const html = node(k, childCtx).replace(
              /^<(\w+)([^>]*?) style="/,
              `<$1$2 style="position: absolute; left: ${R(kr.left - r.left - parseFloat(cs.borderLeftWidth))}px; top: ${R(kr.top - r.top - parseFloat(cs.borderTopWidth))}px; width: ${R(kr.width)}px; height: ${R(kr.height)}px; `,
            );
            parts.push(html);
            continue;
          }
          placed.push(kr);
        }
      }
      if (k.nodeType === 3) {
        hintEl = el;
        const ts = textStyles(cs);
        const extra = {};
        if (absLayout) {
          const tr = rectOf(k);
          Object.assign(extra, {
            position: "absolute",
            left: `${R(tr.left - r.left - parseFloat(cs.borderLeftWidth))}px`,
            top: `${R(tr.top - r.top - parseFloat(cs.borderTopWidth))}px`,
          });
        }
        const txt =
          L.kind === "inline-row"
            ? k.textContent
                .replace(/\s+/g, " ")
                .replace(/^ /, "\u00a0")
                .replace(/ $/, "\u00a0")
            : k.textContent.trim();
        parts.push(
          `<span style="${styleStr({ ...ts, whiteSpace: L.kind === "inline-row" ? "pre" : "nowrap", flexShrink: 0, ...extra })}">${esc(txt)}</span>`,
        );
        continue;
      }
      const sp = spacers.get(k);
      if (sp)
        parts.push(
          `<div layer-name="spacer" style="${styleStr(row ? { width: `${R(sp)}px`, flexShrink: 0 } : { height: `${R(sp)}px`, flexShrink: 0 })}"></div>`,
        );
      let w = wraps.get(k);
      let html = node(k, childCtx);
      if (
        !absLayout &&
        k.nodeType === 1 &&
        !["absolute", "fixed"].includes(getComputedStyle(k).position)
      ) {
        const kc = getComputedStyle(k);
        const m = row
          ? [parseFloat(kc.marginTop) || 0, parseFloat(kc.marginBottom) || 0]
          : [parseFloat(kc.marginLeft) || 0, parseFloat(kc.marginRight) || 0];
        const stretched = /align-self: stretch/.test(
          html.slice(0, html.indexOf(">")),
        );
        if ((m[0] > 0.5 || m[1] > 0.5) && !stretched && !w) {
          const pad = row
            ? {
                paddingTop: `${R(Math.max(0, m[0]))}px`,
                paddingBottom: `${R(Math.max(0, m[1]))}px`,
              }
            : {
                paddingLeft: `${R(Math.max(0, m[0]))}px`,
                paddingRight: `${R(Math.max(0, m[1]))}px`,
              };
          const self = (html
            .slice(0, html.indexOf(">"))
            .match(/align-self: ([a-z-]+)/) || [])[1];
          html = `<div layer-name="margin" style="${styleStr({ display: "flex", flexDirection: "column", flexShrink: 0, alignSelf: self, ...pad })}">${html}</div>`;
        }
      }
      parts.push(
        w
          ? `<div layer-name="inset" style="${styleStr({ alignSelf: "stretch", display: "flex", flexDirection: "column", alignItems: "stretch", ...w })}">${html}</div>`
          : html,
      );
    }
    if (trail)
      parts.push(
        `<div layer-name="spacer" style="${styleStr(row ? { width: `${R(trail)}px`, flexShrink: 0 } : { height: `${R(trail)}px`, flexShrink: 0 })}"></div>`,
      );
    return `<div layer-name="${name}" style="${styleStr(st)}">${before}${parts.join("")}${after}</div>`;
  }

  function richSpan(el, parentCs, keepWs) {
    hintEl = el;
    const cs = getComputedStyle(el);
    const ts = textStyles(cs);
    const p = textStyles(parentCs);
    const diff = Object.fromEntries(
      Object.entries(ts).filter(([k, v]) => p[k] !== v),
    );
    // Paper trims plain spaces at the edges of a styled run; keep them as
    // no-break spaces.
    const edge = (t) => t.replace(/^ /, "\u00a0").replace(/ $/, "\u00a0");
    const inner = childNodesOf(el)
      .map((k) =>
        k.nodeType === 3
          ? esc(
              keepWs ? k.textContent : edge(k.textContent.replace(/\s+/g, " ")),
            )
          : k.nodeType === 1
            ? richSpan(k, cs, keepWs)
            : "",
      )
      .join("");
    return Object.keys(diff).length
      ? `<span style="${styleStr(diff)}">${inner}</span>`
      : inner;
  }

  window.__paperSerialize = (el, layerName) => {
    const r = el.getBoundingClientRect();
    let html = node(el, { root: true });
    if (layerName)
      html = html.replace(
        /^<(\w+) layer-name="[^"]*"/,
        `<$1 layer-name="${layerName.replace(/"/g, "'")}"`,
      );
    return { html, w: Math.round(r.width), h: Math.round(r.height) };
  };
})();
