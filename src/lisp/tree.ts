// A Lisp source text as a tree of nodes with exact ranges, for structural
// editing and indentation. It never runs the reader, so any text parses.

export type NodeKind = "list" | "atom" | "string" | "char" | "comment" | "blockComment";

export type Node = {
  kind: NodeKind;
  /** Start of the node, including reader prefixes such as ' ` , ,@ #' #+x. */
  from: number;
  /** Start of the node itself, after its prefixes. */
  start: number;
  to: number;
  /** Lists only. Comments are children too, so edits can keep them. */
  children: Node[];
  /** Lists only: false when the text ends before the closing paren. */
  closed: boolean;
};

const DELIMITER = /[\s()";]/;

function node(kind: NodeKind, from: number, start: number, to: number): Node {
  return { kind, from, start, to, children: [], closed: true };
}

export function parse(text: string): Node[] {
  const root: Node[] = [];
  const stack: Node[] = [];
  const out = () => (stack.length ? stack[stack.length - 1].children : root);
  let prefixFrom = -1;
  let i = 0;
  const take = (n: Node) => {
    if (prefixFrom >= 0 && n.kind !== "comment" && n.kind !== "blockComment") {
      n.from = prefixFrom;
      prefixFrom = -1;
    }
    out().push(n);
  };

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === ";") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      out().push(node("comment", i, i, j));
      i = j;
      continue;
    }
    if (ch === "#" && text[i + 1] === "|") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "|" && text[j + 1] === "#") (depth--, (j += 2));
        else if (text[j] === "#" && text[j + 1] === "|") (depth++, (j += 2));
        else j++;
      }
      out().push(node("blockComment", i, i, j));
      i = j;
      continue;
    }
    if (ch === "'" || ch === "`" || ch === ",") {
      if (prefixFrom < 0) prefixFrom = i;
      i += ch === "," && text[i + 1] === "@" ? 2 : 1;
      continue;
    }
    if (ch === "#" && (text[i + 1] === "'" || text[i + 1] === "+" || text[i + 1] === "-")) {
      if (prefixFrom < 0) prefixFrom = i;
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      // #+feature and #-feature: the feature expression is part of the prefix.
      i += 2;
      if (text[i] === "(") {
        let depth = 0;
        do {
          if (text[i] === "(") depth++;
          else if (text[i] === ")") depth--;
          i++;
        } while (i < text.length && depth > 0);
      } else {
        while (i < text.length && !DELIMITER.test(text[i])) i++;
      }
      continue;
    }
    if (ch === "#" && text[i + 1] === "\\") {
      let j = i + 3;
      while (j < text.length && !DELIMITER.test(text[j])) j++;
      take(node("char", i, i, j));
      i = j;
      continue;
    }
    if (ch === "(" || (ch === "#" && text[i + 1] === "(")) {
      const n = node("list", i, i, i);
      n.closed = false;
      take(n);
      stack.push(n);
      i += ch === "#" ? 2 : 1;
      continue;
    }
    if (ch === ")") {
      const n = stack.pop();
      if (n) {
        n.to = i + 1;
        n.closed = true;
      }
      prefixFrom = -1;
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      take(node("string", i, i, Math.min(j + 1, text.length)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !DELIMITER.test(text[j])) {
      if (text[j] === "\\") j++;
      else if (text[j] === "|") {
        j++;
        while (j < text.length && text[j] !== "|") j += text[j] === "\\" ? 2 : 1;
      }
      j++;
    }
    take(node("atom", i, i, Math.min(j, text.length)));
    i = j;
  }
  for (const n of stack) n.to = text.length;
  return root;
}

/** Parse `text` between `from` and `to`, with ranges in `text`'s coordinates. */
export function parseRange(text: string, from: number, to: number): Node[] {
  const shift = (nodes: Node[]): Node[] => {
    for (const n of nodes) {
      n.from += from;
      n.start += from;
      n.to += from;
      shift(n.children);
    }
    return nodes;
  };
  return shift(parse(text.slice(from, to)));
}

/** Nodes that are code, leaving out comments. */
export function forms(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.kind !== "comment" && n.kind !== "blockComment");
}

/** The chain of nodes containing `pos`, outermost first. A list contains its
 * inside, not the position just before its prefix or just after its close. */
export function pathAt(nodes: Node[], pos: number): Node[] {
  const path: Node[] = [];
  let level = nodes;
  for (;;) {
    const hit = level.find((n) => (n.kind === "list" ? n.start < pos && (pos < n.to || !n.closed) : n.from <= pos && pos <= n.to));
    if (!hit) return path;
    path.push(hit);
    if (hit.kind !== "list") return path;
    level = hit.children;
  }
}

/** The innermost list containing `pos`, if any. */
export function enclosingList(nodes: Node[], pos: number): Node | null {
  const path = pathAt(nodes, pos).filter((n) => n.kind === "list");
  return path.length ? path[path.length - 1] : null;
}

/** The form that `pos` touches: inside an atom, or at either edge of a form. */
export function formAt(nodes: Node[], pos: number): Node | null {
  const level = enclosingList(nodes, pos)?.children ?? nodes;
  const code = forms(level);
  return code.find((n) => n.from <= pos && pos <= n.to) ?? null;
}

/** Text of a list's head symbol, such as "defun". */
export function headName(text: string, list: Node): string | null {
  const head = forms(list.children)[0];
  return head && head.kind === "atom" ? text.slice(head.start, head.to) : null;
}

export type Definition = { kind: string; name: string; offset: number };

/** Top-level definitions, such as (defun name ...) or (define-condition name ...). */
export function definitions(text: string): Definition[] {
  return forms(parse(text)).flatMap((n) => {
    if (n.kind !== "list") return [];
    const [head, name] = forms(n.children);
    const kind = head?.kind === "atom" ? text.slice(head.start, head.to).toLowerCase() : "";
    if (!/^(cl:)?def|^define-/.test(kind) || !name) return [];
    const nameNode = name.kind === "list" ? forms(name.children)[0] ?? name : name;
    return [{ kind: kind.replace(/^cl:/, ""), name: text.slice(nameNode.start, nameNode.to), offset: n.start }];
  });
}

/** A symbol's name without its package, in upper case, as Lisp compares names read without bars. */
const bare = (symbol: string) => symbol.replace(/^.*?::?(?=[^:])/, "").toUpperCase();

/**
 * Where `text` defines `symbol` at top level, when it does. This finds code
 * that is written but not loaded yet, which Lisp itself knows nothing of.
 */
export function definitionOf(text: string, symbol: string): number | null {
  const want = bare(symbol);
  return definitions(text).find((d) => bare(d.name) === want)?.offset ?? null;
}

/** Where a list's contents begin, after "(" or "#(". */
export function bodyStart(text: string, list: Node): number {
  return list.start + (text[list.start] === "#" ? 2 : 1);
}

/** Where a list's contents end: before its ")", or at the end of the text when unclosed. */
export function bodyEnd(list: Node): number {
  return list.closed ? list.to - 1 : list.to;
}

/**
 * The form that ends at or before `pos` in the innermost list holding `pos`,
 * the way Emacs's C-x C-e picks the expression before point.
 */
export function formBefore(text: string, pos: number): Node | null {
  const nodes = parse(text);
  const path = pathAt(nodes, pos).filter((n) => n.kind === "list" && n.start < pos && (pos < n.to || !n.closed));
  const level = path.length ? path[path.length - 1].children : nodes;
  let best: Node | null = null;
  for (const n of forms(level)) if (n.to <= pos) best = n;
  return best;
}

/**
 * The form a breakpoint on the line [from, to] covers: the first call starting
 * on that line inside a top-level form. A top-level form itself is not one, so
 * a click on a `(defun` line picks the first call in its body there, if any.
 */
export function breakpointForm(text: string, from: number, to: number): { from: number; to: number } | null {
  const visit = (nodes: Node[], depth: number): Node | null => {
    for (const n of forms(nodes)) {
      if (n.kind !== "list" || n.to < from || n.start > to) continue;
      if (depth > 0 && n.start >= from && n.closed && headName(text, n)) return n;
      const inner = visit(n.children, depth + 1);
      if (inner) return inner;
    }
    return null;
  };
  const hit = visit(parse(text), 0);
  return hit && { from: hit.start, to: hit.to };
}
