# Paper component library harness

Builds the Sessions component library in the Paper design app (file
"perier sessions", pages "Sessions · Components" and "Sessions · Components ·
Dark") from the real frontend, so designs can start in Paper without
redrawing controls.

It renders the real `ui/` primitives and feature components with the app's own
CSS in headless Chrome, then serializes each one to Paper-compatible HTML:
inline styles, flex only, no margins, and colours mapped back to Paper tokens
named after the code's Tailwind tokens (`--color-panel` is `bg-panel`; dark
values are `--dark-color-*`).

Output goes to `out/` (gitignored).

## Requirements

- `bun install` at the repo root (installs `playwright-core`).
- A Chromium. Defaults to Playwright's cached Chrome for Testing on macOS; set
  `PAPER_LIB_CHROME` to another binary.

## Files

- `specimens/<file>.tsx`: each exports `sections: Section[]` and
  `descriptions: Record<group, string>`. One `group` is one Paper artboard (one
  component, e.g. "Switch"); `title` is a section inside it ("States").
  Specimen names read `"<row> · <variant> · <state>"`; specimens that share the
  first segment are laid out on one row in Paper.
- `entry.tsx`: the `Specimen` and `Section` types. Fields: `name`, `node`,
  `select` (CSS selector for portalled popups), `width` (fixed wrapper width
  for fill-width parts), `on` (CSS variable for the surface it sits on),
  `viewport` (render at this width, e.g. 390, for phone layouts).
- `build.ts --only <file>`: CSS + bundle + `index.html` into `out/<file>/`.
- `extract.ts --only <file> [--theme light|dark]`: serializes every specimen
  into `out/<file>/specimens-<theme>.json` and saves real renders in
  `shots/` (or `shots-dark/`). `--filter <text>` limits the run but overwrites
  the json with only the matching specimens.
- `preview.ts --only <file> [--theme dark] [--ids a,b]`: pages of the real
  render next to the serialized HTML (`compare-*.png`). Left and right must
  match.
- `tokens.ts <theme>` then `paper-tokens.ts [dark]`: resolve the app's tokens
  into `out/paper-tokens.json` and `out/paper-tokens-dark.json` (the payloads
  for Paper's `create_tokens` / `set_tokens`). Run after `build.ts --only button`.
- `serialize.js`: the DOM to Paper HTML converter.
- `paper-import.js`, `paper-page.js`: codemode helpers that write artboards
  into Paper through the Paper MCP server and lay the page out.

## Forcing states

`:hover`, `:active`, `:focus-visible` and `:focus-within` are rewritten so an
element carrying `data-force-hover`, `data-force-active` or `data-force-focus`
matches them; a wrapper with `data-force-hover-in` (etc.) forces its direct
children. Disabled is `disabled`; selected, open and checked use the
component's own props. Transitions are frozen. The accent is Sky, the shipped
default.

## Refreshing the library

    cd scripts/paper-library
    bun build.ts --only button && bun tokens.ts light && bun tokens.ts dark
    bun paper-tokens.ts && bun paper-tokens.ts dark
    for f in foundations icons button forms overlays display chrome sidebar transcript composer panel; do
      bun build.ts --only $f && bun extract.ts --only $f && bun extract.ts --only $f --theme dark
    done

Then, from an agent with the Paper MCP server, update the tokens and rebuild a
page in codemode:

    const read = async (p) => (await tools.bash({ command: `cat scripts/paper-library/${p}` })).output;
    const src = (await read("paper-import.js")) + (await read("paper-page.js"));
    const { rebuildPage } = new Function("toolsRaw", src + "\nreturn { rebuildPage };")(tools);
    await rebuildPage({ F: "<file id>", P: "<page id>", theme: "light", read: (p) => read(p) });

Import one specimen file per codemode call: Paper slows down as the page
grows, and very long runs have dropped the MCP connection.

## Known gaps

The serializer does not reproduce: text clipped with `-webkit-line-clamp` (no
ellipsis), inline code tint, the text shimmer's moving mask, diff gutter bars,
textarea grips and native select chevrons. The collapsed toast stack and Copy
check are left out of the Paper pages.
