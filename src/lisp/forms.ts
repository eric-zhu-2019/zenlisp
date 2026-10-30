import type { AutodocArg } from "../protocol/AutodocArg";

const SYMBOL_CHAR = /[^\s()'"`,;|#]/;

export function isSymbolChar(ch: string): boolean {
  return SYMBOL_CHAR.test(ch) || ch === "#";
}

type Scan = { depth: number; inString: boolean; inComment: boolean; inBlock: number; inBar: boolean };

function scan(
  text: string,
  from: number,
  to: number,
  visit: (ch: string, i: number, s: Scan) => void,
  s: Scan = { depth: 0, inString: false, inComment: false, inBlock: 0, inBar: false },
): Scan {
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (s.inComment) {
      if (ch === "\n") s.inComment = false;
      continue;
    }
    if (s.inBlock > 0) {
      if (ch === "|" && text[i + 1] === "#") {
        s.inBlock--;
        i++;
      } else if (ch === "#" && text[i + 1] === "|") {
        s.inBlock++;
        i++;
      }
      continue;
    }
    if (s.inString) {
      if (ch === "\\") i++;
      else if (ch === '"') s.inString = false;
      continue;
    }
    if (s.inBar) {
      if (ch === "|") s.inBar = false;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "#" && text[i + 1] === "\\") {
      i += 2;
      continue;
    }
    if (ch === "#" && text[i + 1] === "|") {
      s.inBlock = 1;
      i++;
      continue;
    }
    if (ch === ";") s.inComment = true;
    else if (ch === '"') s.inString = true;
    else if (ch === "|") s.inBar = true;
    else visit(ch, i, s);
  }
  return s;
}

export type Range = { from: number; to: number };

export function topLevelForms(text: string): Range[] {
  const forms: Range[] = [];
  let start = -1;
  scan(text, 0, text.length, (ch, i, s) => {
    if (ch === "(") {
      if (s.depth === 0) {
        start = i;
        while (start > 0 && /['`#,@]/.test(text[start - 1])) start--;
      }
      s.depth++;
    } else if (ch === ")" && s.depth > 0) {
      s.depth--;
      if (s.depth === 0 && start >= 0) {
        forms.push({ from: start, to: i + 1 });
        start = -1;
      }
    }
  });
  return forms;
}

export function formAtOrBefore(text: string, pos: number): Range | null {
  const forms = topLevelForms(text);
  let best: Range | null = null;
  for (const f of forms) {
    if (f.from <= pos && pos <= f.to) return f;
    if (f.to <= pos) best = f;
  }
  return best;
}

export function packageAt(text: string, pos: number): string | null {
  const re = /\(\s*(?:cl:|common-lisp:)?in-package\s+(?:#?:|')?"?([^\s)"]+)"?\s*\)/gi;
  // A file in Coalton's .coal syntax starts with a package form, which names its package.
  const header = /^(?:\s|;[^\n]*(?:\n|$)|#\|[\s\S]*?\|#)*\(\s*package\s+(?:#?:)?([^\s()"]+)/i.exec(text);
  let found: string | null = header ? header[1] : null;
  for (const m of text.slice(0, pos).matchAll(re)) found = m[1];
  return found ? found.toUpperCase() : null;
}

export function symbolAt(text: string, pos: number): (Range & { name: string }) | null {
  let from = pos;
  let to = pos;
  while (from > 0 && isSymbolChar(text[from - 1])) from--;
  while (to < text.length && isSymbolChar(text[to])) to++;
  if (from === to) return null;
  const name = text.slice(from, to).replace(/^#'/, "");
  if (/^[0-9.+-]+$/.test(name)) return null;
  return { from, to, name };
}

export function enclosingLists(text: string, pos: number, from = 0): number[] {
  const stack: number[] = [];
  scan(text, from, pos, (ch, i) => {
    if (ch === "(") stack.push(i);
    else if (ch === ")") stack.pop();
  });
  return stack;
}

const CURSOR: AutodocArg = { cursor: true };

/**
 * The call around `pos` in the shape `swank:autodoc` expects. Only the
 * innermost two levels are kept, enough for destructuring argument help.
 */
export function autodocForm(text: string, pos: number): AutodocArg[] | null {
  const top = formAtOrBefore(text, pos);
  const start = top && top.from <= pos ? top.from : 0;
  const lists = enclosingLists(text, pos, start);
  if (lists.length === 0) return null;
  const outer = lists[Math.max(0, lists.length - 2)];
  const root: AutodocArg[] = [];
  const stack: AutodocArg[][] = [];
  let current: AutodocArg[] | null = null;
  let token = "";
  const flush = () => {
    if (token && current) current.push(token);
    token = "";
  };
  scan(text, outer, pos, (ch) => {
    if (ch === "(") {
      flush();
      const list: AutodocArg[] = [];
      if (current) {
        current.push(list);
        stack.push(current);
      } else root.push(list);
      current = list;
    } else if (ch === ")") {
      flush();
      current = stack.pop() ?? null;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (current) {
      token += ch;
    }
  });
  if (!current) return null;
  const inner = current as AutodocArg[];
  // In whitespace the cursor starts a new argument, which SLIME marks with
  // an empty token; without it Swank highlights nothing.
  inner.push(token || "");
  inner.push(CURSOR);
  const first = root[0];
  return Array.isArray(first) && typeof first[0] === "string" ? first : null;
}

export function isComplete(text: string): boolean {
  let sawForm = false;
  const end = scan(text, 0, text.length, (ch, _i, s) => {
    if (ch === "(") s.depth++;
    else if (ch === ")") s.depth--;
    else if (!/\s/.test(ch)) sawForm = true;
    if (ch === ")") sawForm = true;
  });
  return sawForm && end.depth <= 0 && !end.inString && !end.inBar && end.inBlock === 0;
}

export function listEnd(text: string, start: number): number | undefined {
  let end: number | undefined;
  scan(text, start, text.length, (ch, i, s) => {
    if (end !== undefined) return;
    if (ch === "(") s.depth++;
    else if (ch === ")" && --s.depth === 0) end = i + 1;
  });
  return end;
}
