// out/tokens-light.json -> out/paper-tokens.json (create_tokens payload)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.chdir(import.meta.dir);
const theme = process.argv[2] ?? "light";
const t = JSON.parse(readFileSync(`out/tokens-${theme}.json`, "utf8"));
const srgb = (s: string) =>
  s.replace(
    /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/g,
    (_, r, g, b, a) =>
      `rgba(${Math.round(+r * 255)}, ${Math.round(+g * 255)}, ${Math.round(+b * 255)}, ${a ?? 1})`,
  );
const hex = (v: string) => {
  const m = srgb(v).match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
  if (!m) return v;
  const a = m[4] == null ? 1 : +m[4];
  if (a === 0) return null;
  if (a === 1)
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((x) => (+x).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    );
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.round(a * 1000) / 1000})`;
};
const out: any[] = [];
for (const x of t) {
  if (x.type === "color") {
    const v = hex(x.value);
    if (v)
      out.push({
        type: "color",
        name: x.name,
        value: v,
        description: `Code: ${x.expr}`,
      });
  } else if (x.type === "radius" && x.value.endsWith("px"))
    out.push({
      type: "radius",
      name: x.name,
      value: `${Math.round(parseFloat(x.value) * 100) / 100}px`,
      description: `Code: ${x.expr} (circular-corner value, --rf 0.771)`,
    });
  else if (x.type === "fontSize")
    out.push({
      type: "fontSize",
      name: x.name,
      value: x.value,
      description: `Code: ${x.expr} (desktop; phone scale is larger)`,
    });
  else if (x.type === "spacing")
    out.push({
      type: "spacing",
      name: x.name,
      value: x.value,
      description: `Code: ${x.expr}`,
    });
  else if (x.type === "fontWeight")
    out.push({
      type: "fontWeight",
      name: x.name,
      value: +x.value,
      description: "Light theme value (dark: 500)",
    });
}
out.push({
  type: "spacing",
  name: "--spacing",
  value: "4px",
  description: "Tailwind base step: p-1 = 4px",
});
out.push({
  type: "fontFamily",
  name: "--font-sans",
  value: "SF Pro",
  description: "Code: -apple-system stack",
});
out.push({
  type: "fontFamily",
  name: "--font-mono",
  value: "SF Mono",
  description: "Code: SF Mono, ui-monospace stack",
});
out.push(
  { type: "fontWeight", name: "--font-weight-normal", value: 400 },
  { type: "fontWeight", name: "--font-weight-medium", value: 500 },
);
// create_tokens wants smallest-first for non-colour types; colours first.
const order = [
  "color",
  "fontFamily",
  "fontWeight",
  "fontSize",
  "spacing",
  "radius",
];
out.sort(
  (a, b) =>
    order.indexOf(a.type) - order.indexOf(b.type) ||
    (a.type === "color" ? 0 : parseFloat(a.value) - parseFloat(b.value)),
);
if (theme === "dark") {
  // Paper tokens hold one value, so dark lives beside light as --dark-*.
  const dark = out
    .filter((x) => x.type === "color" || x.name === "--font-weight-title")
    .map((x) => ({
      ...x,
      name: x.name.replace(/^--/, "--dark-"),
      description:
        `Dark theme value of ${x.name}. ${x.description ?? ""}`.trim(),
    }));
  writeFileSync("out/paper-tokens-dark.json", JSON.stringify(dark));
  console.log(dark.length, "dark tokens");
} else {
  writeFileSync("out/paper-tokens.json", JSON.stringify(out));
  console.log(out.length, "tokens");
}
