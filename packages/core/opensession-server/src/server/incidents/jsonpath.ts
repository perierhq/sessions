// The JSONPath subset signal mappings use: `$`, dot and bracket keys,
// indexes (negative counts from the end), `*`, and `[?(@.a.b ==|!= literal)]`.
// No recursive descent, slices or functions.
import type { JsonScalar } from "../../shared/incidents";

export type JsonPathSegment =
  | { type: "key"; key: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "filter"; path: string[]; op: "==" | "!="; value: JsonScalar };

export const JSONPATH_MAX_CHARS = 256;
export const JSONPATH_MAX_RESULTS = 1000;
const JSONPATH_MAX_SEGMENTS = 32;

const IDENT = /[A-Za-z0-9_$-]/;

export function parseJsonPath(
  path: string,
): JsonPathSegment[] | { error: string } {
  if (typeof path !== "string") return { error: "Path must be a string" };
  const src = path.trim();
  if (!src) return { error: "Path is empty" };
  if (src.length > JSONPATH_MAX_CHARS)
    return { error: `Path is longer than ${JSONPATH_MAX_CHARS} characters` };
  const segments: JsonPathSegment[] = [];
  let i = 0;
  if (src[0] === "$") i = 1;
  else if (src[0] !== "[" && src[0] !== ".") {
    // Relative path: `a.b` is `$.a.b`.
    const key = readIdent(src, 0);
    if (!key.text) return { error: `Unexpected "${src[0]}" at 0` };
    segments.push(
      key.text === "*" ? { type: "wildcard" } : { type: "key", key: key.text },
    );
    i = key.end;
  }
  while (i < src.length) {
    const ch = src[i];
    if (ch === ".") {
      if (src[i + 1] === ".")
        return { error: "Recursive descent (..) is not supported" };
      if (src[i + 1] === "*") {
        segments.push({ type: "wildcard" });
        i += 2;
      } else {
        const key = readIdent(src, i + 1);
        if (!key.text) return { error: `Expected a key at ${i + 1}` };
        segments.push({ type: "key", key: key.text });
        i = key.end;
      }
    } else if (ch === "[") {
      const parsed = parseBracket(src, i);
      if ("error" in parsed) return parsed;
      segments.push(parsed.segment);
      i = parsed.end;
    } else {
      return { error: `Unexpected "${ch}" at ${i}` };
    }
    if (segments.length > JSONPATH_MAX_SEGMENTS)
      return { error: `Path has more than ${JSONPATH_MAX_SEGMENTS} segments` };
  }
  return segments;
}

function readIdent(src: string, start: number): { text: string; end: number } {
  if (src[start] === "*") return { text: "*", end: start + 1 };
  let end = start;
  while (end < src.length && IDENT.test(src[end])) end++;
  return { text: src.slice(start, end), end };
}

function readQuoted(
  src: string,
  start: number,
): { text: string; end: number } | { error: string } {
  const quote = src[start];
  let text = "";
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { text, end: i + 1 };
    text += ch;
    i++;
  }
  return { error: "Unterminated string" };
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && src[i] === " ") i++;
  return i;
}

function parseBracket(
  src: string,
  start: number,
): { segment: JsonPathSegment; end: number } | { error: string } {
  let i = skipSpaces(src, start + 1);
  const ch = src[i];
  let segment: JsonPathSegment;
  if (ch === "'" || ch === '"') {
    const q = readQuoted(src, i);
    if ("error" in q) return q;
    segment = { type: "key", key: q.text };
    i = q.end;
  } else if (ch === "*") {
    segment = { type: "wildcard" };
    i++;
  } else if (ch === "?") {
    const f = parseFilter(src, i + 1);
    if ("error" in f) return f;
    segment = f.segment;
    i = f.end;
  } else {
    const m = /^-?\d+/.exec(src.slice(i));
    if (!m) {
      if (src.slice(i).match(/^-?\d*:/))
        return { error: "Slices are not supported" };
      return {
        error: `Unexpected "${ch ?? "end of path"}" in brackets at ${i}`,
      };
    }
    segment = { type: "index", index: Number(m[0]) };
    i += m[0].length;
  }
  i = skipSpaces(src, i);
  if (src[i] !== "]") {
    if (src[i] === ":") return { error: "Slices are not supported" };
    return { error: `Expected "]" at ${i}` };
  }
  return { segment, end: i + 1 };
}

function parseFilter(
  src: string,
  start: number,
): { segment: JsonPathSegment; end: number } | { error: string } {
  let i = skipSpaces(src, start);
  if (src[i] !== "(") return { error: `Expected "(" at ${i}` };
  i = skipSpaces(src, i + 1);
  if (src[i] !== "@") return { error: `Filters must start with @ (at ${i})` };
  i++;
  const path: string[] = [];
  while (src[i] === ".") {
    if (src[i + 1] === ".")
      return { error: "Recursive descent (..) is not supported" };
    const key = readIdent(src, i + 1);
    if (!key.text || key.text === "*")
      return { error: `Expected a key at ${i + 1}` };
    path.push(key.text);
    i = key.end;
  }
  if (!path.length) return { error: "Filter needs a key after @" };
  i = skipSpaces(src, i);
  const op = src.slice(i, i + 2);
  if (op !== "==" && op !== "!=")
    return { error: `Filters support only == and != (at ${i})` };
  i = skipSpaces(src, i + 2);
  let value: JsonScalar;
  const ch = src[i];
  if (ch === "'" || ch === '"') {
    const q = readQuoted(src, i);
    if ("error" in q) return q;
    value = q.text;
    i = q.end;
  } else {
    const m = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      src.slice(i),
    );
    if (!m) return { error: `Expected a literal at ${i}` };
    value =
      m[1] === "true"
        ? true
        : m[1] === "false"
          ? false
          : m[1] === "null"
            ? null
            : Number(m[1]);
    i += m[1].length;
  }
  i = skipSpaces(src, i);
  if (src[i] !== ")") return { error: `Expected ")" at ${i}` };
  return { segment: { type: "filter", path, op, value }, end: i + 1 };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function children(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  if (isObject(node)) return Object.values(node);
  return [];
}

function readPath(node: unknown, path: string[]): unknown {
  let cur = node;
  for (const key of path) {
    if (!isObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function queryJsonPath(
  doc: unknown,
  path: string | JsonPathSegment[],
): unknown[] {
  const segments = typeof path === "string" ? parseJsonPath(path) : path;
  if (!Array.isArray(segments)) return [];
  let nodes: unknown[] = [doc];
  for (const segment of segments) {
    const next: unknown[] = [];
    const push = (v: unknown) => {
      if (next.length < JSONPATH_MAX_RESULTS) next.push(v);
    };
    for (const node of nodes) {
      if (next.length >= JSONPATH_MAX_RESULTS) break;
      switch (segment.type) {
        case "key":
          if (isObject(node) && Object.hasOwn(node, segment.key))
            push(node[segment.key]);
          break;
        case "index":
          if (Array.isArray(node)) {
            const idx =
              segment.index < 0 ? node.length + segment.index : segment.index;
            if (idx >= 0 && idx < node.length) push(node[idx]);
          }
          break;
        case "wildcard":
          for (const child of children(node)) {
            if (next.length >= JSONPATH_MAX_RESULTS) break;
            push(child);
          }
          break;
        case "filter":
          for (const child of children(node)) {
            if (next.length >= JSONPATH_MAX_RESULTS) break;
            const value = readPath(child, segment.path);
            const equal = value === segment.value;
            if (segment.op === "==" ? equal : !equal) push(child);
          }
          break;
      }
    }
    nodes = next;
    if (!nodes.length) break;
  }
  return nodes;
}
