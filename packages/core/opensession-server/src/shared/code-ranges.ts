export interface CodeRange {
  start: number;
  end: number;
}

/**
 * A fenced block (```` ``` ```` or `~~~`, closed by the same fence; an
 * unclosed one runs to the end), or an inline code span opened and closed by
 * the same run of backticks (`` `x` ``, ``` ``a `b` c`` ```) on one line.
 */
const CODE = /(```|~~~)[\s\S]*?(?:\1|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\2(?!`)/g;

/** Where `text` holds code, in order. The composer keeps pills out of these
 *  and the server ignores mentions inside them, so both read code alike. */
export function codeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  for (const match of text.matchAll(CODE))
    ranges.push({ start: match.index, end: match.index + match[0].length });
  return ranges;
}
