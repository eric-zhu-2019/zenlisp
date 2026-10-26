// The name being typed when it could name a package or an ASDF system: a
// keyword, an uninterned symbol or a string. Whether it does is Lisp's call
// (`zenlisp::designator-at`), from the form around it.

import { formAtOrBefore, isSymbolChar } from "./forms";

export type DesignatorToken = {
  /** Where the name typed so far starts, after any `#:`, `:` or `"`. */
  from: number;
  /** The name typed so far, in lower case. */
  prefix: string;
  /** The text from the start of the top-level form to `pos`, for Lisp to read. */
  form: string;
};

export function designatorToken(text: string, pos: number): DesignatorToken | null {
  let start = pos;
  while (start > 0 && isSymbolChar(text[start - 1]) && text[start - 1] !== '"') start--;
  const inString = text[start - 1] === '"';
  const marker = inString ? "" : (/^#?:/.exec(text.slice(start, pos))?.[0] ?? "");
  if (!marker && !inString) return null;
  const from = start + marker.length;
  const top = formAtOrBefore(text, pos);
  return { from, prefix: text.slice(from, pos).toLowerCase(), form: text.slice(top && top.from <= pos ? top.from : 0, pos) };
}
