// Common Lisp indentation, ported from SLIME's slime-cl-indent.el
// (`common-lisp-indent-function` with the "basic" style) and the parts of
// Emacs's `calculate-lisp-indent` that feed it.

import { type IndentContext, indentService } from "@codemirror/language";
import { regionOf, toRegion } from "./region";
import { type EditorState, type Extension, Facet, type StateCommand, type Text, type TransactionSpec } from "@codemirror/state";
import { forms, parse, parseRange, type Node } from "../lisp/tree";

/** Indentation specs from Swank: lowercase symbol name to a SLIME spec as JSON. */
export type IndentSpecs = Record<string, unknown>;

/** A SLIME indentation spec. Symbols such as &body, or a function such as
 * lisp-indent-tagbody, are strings; nil is null. */
type Spec = null | number | string | Spec[];

const DEFUN: Spec[] = [4, "&lambda", "&body"];
const AS = (name: string): Spec => ["as", name];

const BUILTIN: Record<string, Spec> = {
  block: 1,
  case: [4, "&rest", ["&whole", 2, "&rest", 1]],
  ccase: AS("case"),
  ecase: AS("case"),
  typecase: AS("case"),
  etypecase: AS("case"),
  ctypecase: AS("case"),
  catch: 1,
  cond: ["&rest", ["&whole", 2, "&rest", null]],
  ":constructor": [4, "&lambda"],
  defvar: [4, 2, 2],
  defclass: [6, ["&whole", 4, "&rest", 1], ["&whole", 2, "&rest", 1], ["&whole", 2, "&rest", 1]],
  defconstant: AS("defvar"),
  defcustom: [4, 2, 2, 2],
  "define-compiler-macro": AS("defun"),
  defparameter: AS("defvar"),
  defconst: AS("defcustom"),
  "define-condition": AS("defclass"),
  "define-modify-macro": [4, "&lambda", "&body"],
  defsetf: "lisp-indent-defsetf",
  defun: DEFUN,
  defgeneric: [4, "&lambda", "&body"],
  "define-setf-method": AS("defun"),
  "define-setf-expander": AS("defun"),
  defmacro: AS("defun"),
  defsubst: AS("defun"),
  deftype: AS("defun"),
  defmethod: "lisp-indent-defmethod",
  defpackage: [4, 2],
  defstruct: [["&whole", 4, "&rest", ["&whole", 2, "&rest", 1]], "&rest", ["&whole", 2, "&rest", 1]],
  "destructuring-bind": ["&lambda", 4, "&body"],
  do: "lisp-indent-do",
  "do*": AS("do"),
  dolist: [["&whole", 4, 2, 1], "&body"],
  dotimes: AS("dolist"),
  "eval-when": 1,
  flet: [["&whole", 4, "&rest", ["&whole", 1, 4, "&lambda", "&body"]], "&body"],
  labels: AS("flet"),
  macrolet: AS("flet"),
  "generic-flet": AS("flet"),
  "generic-labels": AS("flet"),
  "handler-case": [4, "&rest", ["&whole", 2, 2, 4, "&body"]],
  "restart-case": AS("handler-case"),
  if: ["&rest", null],
  "if*": "common-lisp-indent-if*",
  lambda: ["&lambda", "&rest", "lisp-indent-function-lambda-hack"],
  let: [["&whole", 4, "&rest", ["&whole", 1, 1, 2]], "&body"],
  "let*": AS("let"),
  "compiler-let": AS("let"),
  "handler-bind": AS("let"),
  "restart-bind": AS("let"),
  locally: 1,
  loop: "lisp-indent-loop",
  ":method": "lisp-indent-defmethod",
  "multiple-value-bind": [["&whole", 6, "&rest", 1], 4, "&body"],
  "multiple-value-call": [4, "&body"],
  "multiple-value-prog1": 1,
  "multiple-value-setq": [4, 2],
  "multiple-value-setf": AS("multiple-value-setq"),
  "named-lambda": [4, "&lambda", "&rest", "lisp-indent-function-lambda-hack"],
  "pprint-logical-block": [4, 2],
  "print-unreadable-object": [["&whole", 4, 1, "&rest", 1], "&body"],
  prog: ["&lambda", "&rest", "lisp-indent-tagbody"],
  "prog*": AS("prog"),
  prog1: 1,
  prog2: 2,
  progn: 0,
  progv: [4, 4, "&body"],
  return: 0,
  "return-from": [null, "&body"],
  "symbol-macrolet": AS("let"),
  tagbody: "lisp-indent-tagbody",
  throw: 1,
  unless: 1,
  "unwind-protect": [5, "&body"],
  when: 1,
  "with-accessors": AS("multiple-value-bind"),
  "with-compilation-unit": [["&whole", 4, "&rest", 1], "&body"],
  "with-condition-restarts": AS("multiple-value-bind"),
  "with-output-to-string": [4, 2],
  "with-slots": AS("multiple-value-bind"),
  "with-standard-io-syntax": [2],
};

const MAX_BACKTRACKING = 6;
const BODY_INDENT = 2;
const TAG_INDENT = 1;
const TAG_BODY_INDENT = 3;
const LAMBDA_PARAMETER_INDENT = 2;
const LOOP_CLAUSES_INDENT = 2;
const LOOP_BODY_FORMS_INDENT = 3;
const SIMPLE_LOOP_INDENT = 2;

const WORD = /[\p{L}\p{N}]/u;
const SYMBOL = /[^\s()"';`,#|\\]/;
const LAMBDA_KEYWORD = /^&(optional|rest|key|allow-other-keys|aux|whole|body|environment|more)\b/i;
const SINGLE_ARG_KEYWORD = /^&(whole|environment)\b/i;
const LOOP_BODY_KEYWORD = /^(#?:)?(do(ing)?|finally|initially)/i;
const LOOP_PREFIX_KEYWORD = /^(#?:)?(and|else)/i;
const LOOP_JOINING_KEYWORD = /^(#?:)?and/i;
const LOOP_ELSE_KEYWORD = /^(#?:)?else/i;
const LOOP_CONDITIONAL_KEYWORD = /^(#?:)?(when|unless|if)/i;
// Copied from SLIME, whose unescaped parens make "(from" and "to)" literal,
// so plain FROM and TO never match.
const LOOP_SUBCLAUSE_KEYWORD =
  /^(#?:)?((up|down)?\(from|to\)|below|above|in(to)?|on|=|then|across|being|each|the|of|using|(present-|external-)?symbols?|fixnum|float|t|nil|of-type)/i;
const LOOP_CLAUSE_START = /^((#?:)?[\p{L}\p{N}]+|\)|\n)/iu;
// SLIME's own spelling: "threnret" never matches, so THENRET matches "then".
const IF_STAR_KEYWORD = /^(threnret|elseif|then|else)/i;

/** One sexp as Emacs's sexp motion sees it, which SLIME's rules count in:
 * #+feature is a sexp of its own, unlike in the shared tree. */
type Sexp = { from: number; to: number; node: Node | null; feature: boolean };

type Level = { list: Node; open: number; sexps: Sexp[]; n: number };

/** A parsed text, with what indenting it needs to look up repeatedly. */
class Parsed {
  readonly roots: Node[];
  readonly lineStarts: number[] = [0];
  private sexpCache = new Map<Node[], Sexp[]>();

  constructor(readonly text: string) {
    this.roots = parse(text);
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
  }

  /** The sexps among `children`, a list's or the top level's. */
  sexps(children: Node[]): Sexp[] {
    let out = this.sexpCache.get(children);
    if (!out) {
      out = splitSexps(this.text, children);
      this.sexpCache.set(children, out);
    }
    return out;
  }
}

/** A parsed text whose lines may have been reindented since it was parsed. */
class Source {
  readonly text: string;
  readonly roots: Node[];
  readonly lineStarts: number[];

  constructor(
    readonly parsed: Parsed,
    /** The indentation a line has been given since parsing, if it changed. */
    readonly reindented: (line: number) => number | null = () => null,
  ) {
    ({ text: this.text, roots: this.roots, lineStarts: this.lineStarts } = parsed);
  }

  sexps(children: Node[]): Sexp[] {
    return this.parsed.sexps(children);
  }

  lineOf(pos: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineStart(pos: number): number {
    return this.lineStarts[this.lineOf(pos)];
  }

  lineEnd(pos: number): number {
    const i = this.text.indexOf("\n", pos);
    return i < 0 ? this.text.length : i;
  }

  indentationEnd(pos: number): number {
    return skipBlanks(this.text, this.lineStart(pos));
  }

  sameLine(a: number, b: number): boolean {
    return this.lineOf(a) === this.lineOf(b);
  }

  col(pos: number): number {
    const line = this.lineOf(pos);
    const start = this.lineStarts[line];
    const now = this.reindented(line);
    return pos - start + (now === null ? 0 : now - (skipBlanks(this.text, start) - start));
  }
}

function skipBlanks(text: string, pos: number): number {
  while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos++;
  return pos;
}

function openParen(text: string, list: Node): number {
  return text[list.start] === "#" ? list.start + 1 : list.start;
}

// Emacs reads #+(or a b) as the symbol + after a # prefix, then a list, so
// the list is a sexp of its own and lines inside it indent as a list.
function splitSexps(text: string, children: Node[]): Sexp[] {
  const out: Sexp[] = [];
  for (const child of forms(children)) {
    let prefix = -1;
    let i = child.from;
    while (i < child.start) {
      const ch = text[i];
      // Like Emacs's backward-sexp, a prefix only joins a form it touches.
      if (/\s/.test(ch)) (i++, (prefix = -1));
      else if (ch === ";") (i = text.indexOf("\n", i) < 0 ? child.start : text.indexOf("\n", i)), (prefix = -1);
      else if (ch === "#" && (text[i + 1] === "+" || text[i + 1] === "-")) {
        const list = text[i + 2] === "(" ? parseRange(text, i + 2, child.start)[0] : undefined;
        if (list?.kind === "list") {
          out.push({ from: i, to: i + 2, node: null, feature: true });
          out.push({ from: list.from, to: list.to, node: list, feature: false });
          i = list.to;
        } else {
          let to = i + 2;
          while (to < child.start && !/[\s()";]/.test(text[to])) to++;
          out.push({ from: i, to, node: null, feature: true });
          i = to;
        }
      } else {
        if (prefix < 0) prefix = i;
        i += (ch === "," && text[i + 1] === "@") || (ch === "#" && text[i + 1] === "'") ? 2 : 1;
      }
    }
    out.push({ from: prefix < 0 ? child.start : prefix, to: child.to, node: child, feature: false });
  }
  return out;
}

/** Number of sexps that end before `pos`. */
function countBefore(sexps: Sexp[], pos: number): number {
  let lo = 0;
  let hi = sexps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sexps[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where Emacs's parser says a sexp starts: after its reader prefixes. */
function sexpStart(text: string, s: Sexp): number {
  let i = s.from;
  while (/[#'`,]/.test(text[i]) || (text[i] === "@" && text[i - 1] === ",")) i++;
  return i < s.to ? i : s.from;
}

const contains = (list: Node, pos: number) => list.start < pos && (pos < list.to || !list.closed);

/** The lists containing `bol`, outermost first, or null when it is inside a
 * string or block comment. */
function containingLists(src: Source, bol: number): Node[] | null {
  const { text } = src;
  const out: Node[] = [];
  let level = src.roots;
  for (;;) {
    let lo = 0;
    let hi = level.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (level[mid].start < bol) lo = mid + 1;
      else hi = mid;
    }
    const hit: Node | undefined = level[lo - 1];
    let inner = hit?.kind === "list" && contains(hit, bol) ? hit : undefined;
    if (!inner && hit && (hit.kind === "string" || hit.kind === "blockComment") && hit.start < bol) {
      if (bol < hit.to) return null;
      if (hit.kind === "string" && hit.to === text.length && (hit.to - hit.start < 2 || text[hit.to - 1] !== '"')) return null;
    }
    let next: Node | undefined = level[lo];
    for (let i = lo; next && (next.kind === "comment" || next.kind === "blockComment"); ) next = level[++i];
    if (!inner && next && next.from < bol) {
      inner = src.sexps(level).find((s) => s.node !== next && s.node?.kind === "list" && contains(s.node, bol))?.node ?? undefined;
    }
    if (!inner) return out;
    out.push(inner);
    level = inner.children;
  }
}

type Specs = Map<string, Spec>;

const normalized = new WeakMap<IndentSpecs, Specs>();

function toSpec(v: unknown): Spec | undefined {
  if (v === null || (typeof v === "number" && Number.isInteger(v))) return v;
  if (typeof v === "string") return v.toLowerCase() === "nil" ? null : v.toLowerCase();
  if (Array.isArray(v)) {
    const out: Spec[] = [];
    for (const e of v) {
      const s = toSpec(e);
      if (s === undefined) return undefined;
      out.push(s);
    }
    return out;
  }
  return undefined;
}

function normalize(specs: IndentSpecs): Specs {
  let out = normalized.get(specs);
  if (!out) {
    out = new Map();
    for (const [name, v] of Object.entries(specs)) {
      const s = toSpec(v);
      if (s !== undefined && s !== null) out.set(name.toLowerCase(), s);
    }
    normalized.set(specs, out);
  }
  return out;
}

function methodOf(specs: Specs, name: string): Spec | undefined {
  for (let hops = 0; hops < 8; hops++) {
    const m = specs.get(name) ?? BUILTIN[name];
    if (Array.isArray(m) && m[0] === "as" && typeof m[1] === "string") name = m[1];
    else return m ?? undefined;
  }
  return undefined;
}

type Ctx = {
  src: Source;
  specs: Specs;
  bol: number;
  /** First non-blank position on the line being indented. */
  first: number;
  /** Containing lists, innermost first. */
  levels: Level[];
  /** Column of the innermost containing list's open paren. */
  sexpCol: number;
};

type IndentFunction = (cx: Ctx, path: number[], level: Level, normal: number) => number | null;

const at = (cx: Ctx, pos: number) => cx.src.text.slice(pos, pos + 40);

/** Column for the line starting at `bol`, or null to leave it alone. */
function lineIndent(src: Source, specs: Specs, bol: number): number | null {
  const { text } = src;
  const first = skipBlanks(text, bol);
  const lists = containingLists(src, bol);
  if (lists === null || text.startsWith(";;;", first)) return null;
  if (!lists.length) return 0;

  const levels: Level[] = [];
  for (let i = lists.length - 1; i >= 0 && levels.length < MAX_BACKTRACKING; i--) {
    const sexps = src.sexps(lists[i].children);
    levels.push({ list: lists[i], open: openParen(text, lists[i]), sexps, n: countBefore(sexps, bol) });
  }
  const inner = levels[0];
  const cx: Ctx = { src, specs, bol, first, levels, sexpCol: src.col(inner.open) };
  const E = inner.sexps;
  const k = inner.n;
  if (k === 0) return cx.sexpCol + 1;

  const last = E[k - 1];
  const e0 = E[0];
  let normalPos: number;
  // SLIME, but not Emacs's own fallback, aligns under the comma of ,(...).
  let splicePos: number | null = null;
  if (e0.node?.kind === "list") {
    normalPos = openParen(text, e0.node);
    if (text[normalPos - 1] === "," || text.slice(normalPos - 2, normalPos) === ",@") {
      let q = normalPos;
      while (/[,@']/.test(text[q - 1])) q--;
      if (text[q] === ",") splicePos = q;
    }
  } else if (src.sameLine(e0.from, last.from)) {
    normalPos = k === 1 || /[ \t]/.test(text[inner.open + 1]) ? e0.from : E[1].from;
  } else {
    const lineStart = src.lineStart(last.from);
    const lastStart = sexpStart(text, last);
    normalPos = lineStart;
    while (normalPos < lastStart && /[ \t)'`,@#]/.test(text[normalPos])) normalPos++;
    while (normalPos > lineStart && /['`,@#]/.test(text[normalPos - 1])) normalPos--;
  }
  const normal = src.col(normalPos);

  return commonLispIndent(cx, src.col(splicePos ?? normalPos)) ?? keywordUnderKeyword(cx) ?? normal;
}

/** `calculate-lisp-indent`'s own fallback: a keyword on a line goes under a
 * keyword that starts the line of the previous form. */
function keywordUnderKeyword(cx: Ctx): number | null {
  const { text } = cx.src;
  if (text[cx.first] !== ":") return null;
  const E = cx.levels[0].sexps;
  let j = cx.levels[0].n - 1;
  const firstOnLine = (s: Sexp) => {
    const before = cx.src.lineStart(s.from);
    return !/\S/.test(text.slice(before, s.from)) || !/\S/.test(text.slice(cx.levels[0].open + 1, s.from));
  };
  while (j > 0 && !firstOnLine(E[j])) j--;
  if (j <= 0) return null;
  return text[E[j].from] === ":" ? cx.src.col(E[j].from) : null;
}

function commonLispIndent(cx: Ctx, normal: number): number | null {
  const { text } = cx.src;
  const path: number[] = [];
  let tentative: number | null = null;

  for (const level of cx.levels) {
    path.unshift(level.n);
    const head = level.sexps[0];
    let fn: string | null = null;
    let method: Spec | undefined;
    if (head?.node?.kind === "atom" && SYMBOL.test(text[head.node.start])) {
      fn = text.slice(head.node.start, head.node.to).toLowerCase();
      method = methodOf(cx.specs, fn);
      const qualified = method === undefined ? /:[^:]+/.exec(fn) : null;
      if (qualified) {
        fn = fn.slice(qualified.index + 1);
        method = methodOf(cx.specs, fn);
      }
    }
    let tentativeDefun = false;
    if (method === undefined && fn && path.length === 1) {
      if (/^def/.test(fn) && !/^(default|definition|definer)/.test(fn)) tentativeDefun = true;
      else if (/^(with|without|do)-/.test(fn)) method = ["&lambda", "&body"];
    }

    let calculated = featureExpressionColumn(cx);

    const before = text[level.open - 1];
    if (before === "'" && text[level.open - 2] !== "#") calculated = cx.sexpCol + 1;
    else if (before === "#") calculated = cx.sexpCol + 1;
    else if (method === undefined) {
      if (tentativeDefun) {
        tentative = callMethod(cx, DEFUN, path, level, normal) ?? normal;
        normal = tentative;
      } else {
        calculated = keywordArgumentColumn(cx) ?? calculated;
      }
    } else if (typeof method === "number") {
      const n = path[0];
      if (path.length > 1) calculated = normal;
      else if (n <= method) calculated = cx.sexpCol + 4;
      else if (n === method + 1) calculated = cx.sexpCol + BODY_INDENT;
      else calculated = normal;
    } else {
      calculated = callMethod(cx, method, path, level, normal);
    }
    if (calculated !== null) return calculated;
  }
  return tentative ?? fallback(cx);
}

/** Lines after a #+feature expression line up with it. */
function featureExpressionColumn(cx: Ctx): number | null {
  const E = cx.levels[0].sexps;
  const k = cx.levels[0].n;
  if (E[k - 1].feature) return cx.src.col(E[k - 1].from);
  if (k < 2 || !E[k - 2].feature) return null;
  let j = k - 2;
  const line = cx.src.lineOf(E[j].from);
  while (j >= 2 && E[j - 2].feature && cx.src.lineOf(E[j - 2].from) === line) j -= 2;
  return cx.src.col(E[j].from);
}

/** In a call with no spec, a keyword argument goes under the first keyword. */
function keywordArgumentColumn(cx: Ctx): number | null {
  const { text } = cx.src;
  const E = cx.levels[0].sexps;
  const isKeyword = (i: number): boolean =>
    i < E.length && (text[E[i].from] === ":" || (E[i].feature && isKeyword(i + 1)));
  const back = (i: number): number | null => {
    if (i < 2) return null;
    i -= 2;
    if (E[i].feature) {
      if (i >= 2 && E[i - 2].feature) i = back(i) ?? i;
      else if (i >= 1 && text[E[i - 1].from] === ":") i -= 1;
    }
    return i;
  };
  let i: number | null = cx.levels[0].n;
  if (E[i]?.from !== cx.first || !isKeyword(i)) return null;
  let column: number | null = null;
  while ((i = back(i)) !== null) if (isKeyword(i)) column = cx.src.col(E[i].from);
  return column;
}

/** Emacs's last resort when no spec applies. */
function fallback(cx: Ctx): number | null {
  const { text } = cx.src;
  const inner = cx.levels[0];
  const E = inner.sexps;
  const one = cx.src.col(inner.open + 1);
  const afterOpen = skipBlanks(text, inner.open + 1);
  if (afterOpen >= text.length || text[afterOpen] === "\n" || text[afterOpen] === ";") return one;
  if (E.length < 2) return null;
  if (cx.first !== E[1].from) return cx.src.col(E[1].from);
  const afterHead = skipBlanks(text, E[0].to);
  return text[afterHead] === ";" ? cx.src.col(E[0].to) + 1 : null;
}

function callMethod(cx: Ctx, method: Spec, path: number[], level: Level, normal: number): number | null {
  if (typeof method === "string") {
    if (method === "defun") return indent259(cx, DEFUN, path, level, normal);
    const fn = FUNCTIONS[method];
    return fn ? fn(cx, path, level, normal) : normal;
  }
  if (Array.isArray(method)) return indent259(cx, method, path, level, normal);
  return normal;
}

/** Whether the form at the current level's position is a list, which is how
 * SLIME tells a lambda list from a symbol. */
function atList(level: Level): boolean {
  const s = level.sexps[level.n];
  return !!s && s.node?.kind === "list" && s.node.closed;
}

/** SLIME's `lisp-indent-259`: walk a spec along `path`. */
function indent259(cx: Ctx, method: Spec[], path: number[], level: Level, normal: number): number | null {
  let p = path.slice(1);
  let n = path[0] - 1;
  let m: Spec[] = method;
  let i = 0;
  let tail = false;
  for (;;) {
    const tem = i < m.length ? m[i] : null;
    if (tem === "&body") return p.length ? normal : cx.sexpCol + BODY_INDENT;
    if (tem === "&rest") {
      tail = n > 0;
      n = 0;
      i++;
      continue;
    }
    if (n > 0) {
      n--;
      i++;
      continue;
    }
    if (tem === null) return normal;
    if (tem === "&lambda") {
      if (!atList(level)) return p.length ? normal : cx.sexpCol + BODY_INDENT;
      if (initialValueForm(cx, level)) return normal;
      if (!p.length) return cx.sexpCol + 4;
      return lambdaListIndent(cx);
    }
    if (typeof tem === "number") return p.length ? normal : cx.sexpCol + tem;
    if (typeof tem === "string") return callMethod(cx, tem, path, level, normal);
    if (p.length) {
      m = tem;
      i = 2;
      n = p[0];
      p = p.slice(1);
      tail = false;
      continue;
    }
    const whole = tem[0] === "&whole";
    const arg = tem.length > 1 ? tem[1] : null;
    if (tail) {
      return whole && typeof arg === "number" && WORD.test(cx.src.text[cx.first] ?? "") ? cx.sexpCol + arg : normal;
    }
    if (arg === null) return normal;
    if (typeof arg === "number") return cx.sexpCol + arg;
    return callMethod(cx, arg, path, level, normal);
  }
}

function lambdaListIndent(cx: Ctx): number {
  const { text } = cx.src;
  if (LAMBDA_KEYWORD.test(at(cx, cx.first))) return cx.sexpCol + 1;
  const E = cx.levels[0].sexps;
  let indent: number | null = null;
  for (let j = cx.levels[0].n - 1; j >= 0; j--) {
    const c = cx.src.col(E[j].from);
    const here = text.slice(E[j].from, E[j].from + 40);
    if (SINGLE_ARG_KEYWORD.test(here)) return c;
    if (LAMBDA_KEYWORD.test(here)) return c + LAMBDA_PARAMETER_INDENT;
    indent = c;
  }
  return indent ?? cx.sexpCol + 1;
}

/** SLIME's `common-lisp-lambda-list-initial-value-form-p`: is the line inside
 * the default value of an &optional, &key or &aux parameter? */
function initialValueForm(cx: Ctx, level: Level): boolean {
  const { src } = cx;
  const { text } = src;
  let list = level.sexps[level.n].node!;
  let xs = src.sexps(list.children);
  let pos = openParen(text, list) + 1;
  let next = 0;
  let target: number | null = cx.first;
  let state: "x" | "key" | "var" | "form" = "x";
  while (target !== null && pos < target) {
    const here = text.slice(pos, pos + 40);
    if (/^&(key|optional|aux)/i.test(here)) state = "key";
    else if (LAMBDA_KEYWORD.test(here)) state = "x";
    if (next >= xs.length) {
      target = null;
      break;
    }
    const passed = next;
    next++;
    pos = next < xs.length ? xs[next].from : xs[passed].to;
    if (pos > target) {
      pos = xs[passed].from;
      if (state === "var") state = "x";
      const inner = xs.slice(passed).find((s) => s.node?.kind === "list");
      if (!inner) {
        target = null;
        break;
      }
      const inside = openParen(text, inner.node!) + 1;
      if (inside > target) {
        pos = inside - 1;
      } else {
        if (state === "key") state = "var";
        list = inner.node!;
        xs = src.sexps(list.children);
        pos = inside;
        next = 0;
      }
    } else if (state === "var") {
      state = "form";
    }
  }
  return state === "form";
}

function tagbody(bodyIndent: number): IndentFunction {
  return (cx, path, _level, normal) => {
    if (path.length > 1) return normal;
    return cx.sexpCol + (SYMBOL.test(cx.src.text[cx.first] ?? "") ? TAG_INDENT : bodyIndent);
  };
}

function defmethodQualifiers(cx: Ctx, level: Level): number | null {
  const { text } = cx.src;
  for (const lv of cx.levels.slice(cx.levels.indexOf(level))) {
    const m = /^\((defmethod|:method)/i.exec(text.slice(lv.open, lv.open + 12));
    if (!m) continue;
    const xs = lv.sexps;
    let i = m[1].toLowerCase() === "defmethod" ? 2 : 1;
    let count = i - 1;
    if (xs.length < i) return null;
    let pos = xs[i - 1].to;
    while (i < xs.length && !/[^ \t\n]/.test(text.slice(pos, xs[i].from)) && SYMBOL.test(text[xs[i].from])) {
      count++;
      pos = xs[i].to;
      i++;
    }
    return count;
  }
  return null;
}

const FUNCTIONS: Record<string, IndentFunction> = {
  "lisp-indent-tagbody": tagbody(TAG_BODY_INDENT),

  "lisp-indent-do": (cx, path, level, normal) =>
    path[0] >= 3
      ? tagbody(BODY_INDENT)(cx, path, level, normal)
      : indent259(cx, [["&whole", null, "&rest"], ["&whole", null, "&rest", 1]], path, level, normal),

  "lisp-indent-defsetf": (cx, path) => {
    const n = path[0];
    if (n === 2 && path.length > 1) return lambdaListIndent(cx);
    const third = cx.levels[0].sexps[2];
    const long = path.length > 1 || (!!third && /^(nil|\()/i.test(at(cx, third.from)));
    return cx.sexpCol + (n === 1 || n === 2 || (long && n === 3) ? 4 : 2);
  },

  "lisp-indent-defmethod": (cx, path, level, normal) => {
    const skip = defmethodQualifiers(cx, level);
    if (skip !== null) return indent259(cx, [...Array(skip).fill(4), "&lambda", "&body"], path, level, normal);
    return callMethod(cx, methodOf(cx.specs, "defun") ?? DEFUN, path, level, normal);
  },

  "lisp-indent-function-lambda-hack": (cx, path, _level, normal) => {
    if (path.length > 1 || path[0] > 3) return normal;
    const parent = cx.levels[1];
    if (parent && /^(lisp:+)?function[^]/i.test(cx.src.text.slice(parent.open + 1, parent.open + 20))) {
      return cx.src.col(parent.open + 1) + BODY_INDENT - 1;
    }
    return cx.sexpCol + BODY_INDENT;
  },

  "lisp-indent-loop": (cx, path, level, normal) => {
    if (path.length > 1) return normal;
    const type = loopType(cx, level);
    return type === "extended" || type === "extended/split" ? loopMacroIndent(cx, level) : loopPartIndent(cx, level, type);
  },

  "common-lisp-indent-if*": (cx) => ifStarIndent(cx, cx.levels[0]),
};

type LoopType = "simple" | "simple/split" | "extended" | "extended/split";

function loopType(cx: Ctx, level: Level): LoopType {
  const { src } = cx;
  const { text } = src;
  const xs = level.sexps;
  let maybeSplit = true;
  let commentSplit = false;
  if (xs[0]) {
    const m = /^[ \t]*\n*;/.exec(text.slice(xs[0].to, xs[0].to + 200));
    if (m) {
      if (src.sameLine(xs[0].to + m[0].length - 1, level.open)) maybeSplit = false;
      else commentSplit = true;
    }
  }
  const clause = xs[1];
  if (!clause) return commentSplit ? "simple/split" : "simple";
  const sameLine = !maybeSplit || src.sameLine(clause.from, level.open);
  if (text[clause.from] === "(") return sameLine ? "simple" : "simple/split";
  return sameLine ? "extended" : "extended/split";
}

/** Column of a comment that ends the line of the previous form, if any. */
function trailingComment(cx: Ctx): number | null {
  const { text } = cx.src;
  const prev = cx.levels[0].sexps[cx.levels[0].n - 1];
  if (!prev) return null;
  const m = /^[ \t]*;/.exec(text.slice(prev.to, prev.to + 200));
  return m ? cx.src.col(prev.to + m[0].length - 1) : null;
}

function loopPartIndent(cx: Ctx, level: Level, type: LoopType): number {
  const { src } = cx;
  const { text } = src;
  const base = src.col(level.open) - (type === "extended/split" ? 4 : 0);
  if (type === "simple/split") return base + SIMPLE_LOOP_INDENT;
  if (type === "simple") return base + 6;
  const clauseStart = (pos: number) => LOOP_CLAUSE_START.test(text.slice(pos, pos + 40));
  if (!clauseStart(cx.first)) {
    let indent: number | null = null;
    let j = level.n - 1;
    while (j >= 0 && !clauseStart(level.sexps[j].from)) {
      indent = src.col(level.sexps[j].from);
      j--;
    }
    if (indent !== null && j >= 0 && LOOP_BODY_KEYWORD.test(at(cx, level.sexps[j].from))) return indent;
  }
  if (text[cx.first] === ";") return trailingComment(cx) ?? base + 6;
  return clauseStart(cx.first) ? base + 6 : base + 9;
}

/** Emacs `forward-word` then skip blanks: the new position, and its column
 * unless the line ended. */
function pastKeyword(cx: Ctx, pos: number): { pos: number; col: number | null } {
  const { text } = cx.src;
  while (pos < text.length && !WORD.test(text[pos])) pos++;
  while (pos < text.length && WORD.test(text[pos])) pos++;
  pos = skipBlanks(text, pos);
  return { pos, col: pos >= text.length || text[pos] === "\n" ? null : cx.src.col(pos) };
}

function loopMacroIndent(cx: Ctx, level: Level): number {
  const { src } = cx;
  const { text } = src;
  const loopCol = src.col(level.open);
  let firstClause = pastKeyword(cx, level.open).pos;
  if (firstClause >= text.length || text[firstClause] === "\n") {
    const nextLine = src.lineEnd(firstClause) + 1;
    if (cx.bol <= src.lineEnd(nextLine)) return loopCol + LOOP_CLAUSES_INDENT;
    firstClause = skipBlanks(text, nextLine);
  }
  const prev = sexpStart(text, level.sexps[level.n - 1]);
  let defaultValue = src.col(firstClause);
  let bodyP = false;
  let bodyIndent: number;
  let clauseIndent = defaultValue + 2;

  if (LOOP_BODY_KEYWORD.test(at(cx, prev))) {
    const keywordCol = src.col(prev);
    bodyP = true;
    const past = pastKeyword(cx, prev);
    if (past.col !== null) bodyIndent = past.col;
    else {
      const c = src.col(src.indentationEnd(prev));
      bodyIndent = c !== keywordCol ? c + 2 : LOOP_BODY_FORMS_INDENT + keywordCol;
    }
  } else {
    let q = Math.max(src.indentationEnd(prev), firstClause);
    while (LOOP_PREFIX_KEYWORD.test(at(cx, q))) {
      const past = pastKeyword(cx, q);
      if (past.col === null) {
        q = src.indentationEnd(q);
        break;
      }
      q = past.pos;
    }
    if (text[q] === "(") {
      bodyP = true;
      bodyIndent = src.col(q);
    } else if (LOOP_BODY_KEYWORD.test(at(cx, q))) {
      bodyP = true;
      bodyIndent = src.col(pastKeyword(cx, q).pos);
    } else {
      if (LOOP_CONDITIONAL_KEYWORD.test(at(cx, q)) || LOOP_PREFIX_KEYWORD.test(at(cx, q))) defaultValue = src.col(q) + 2;
      clauseIndent = src.col(q) + 2;
      bodyIndent = src.col(prev);
    }
  }

  const here = at(cx, cx.first);
  if (here.startsWith("(")) return bodyIndent;
  if (here === "" || here.startsWith("\n") || here.startsWith(";")) {
    if (bodyP) return bodyIndent;
    return (here.startsWith(";") ? trailingComment(cx) : null) ?? defaultValue;
  }
  if (LOOP_SUBCLAUSE_KEYWORD.test(here)) return clauseIndent;
  if (LOOP_JOINING_KEYWORD.test(here)) {
    for (let line = src.lineOf(cx.bol) - 1; line >= 0 && src.lineStarts[line] > firstClause; line--) {
      let q = skipBlanks(text, src.lineStarts[line]);
      if (src.col(q) < bodyIndent && /^(#?:)?[\p{L}\p{N}]/u.test(at(cx, q))) {
        if (LOOP_ELSE_KEYWORD.test(at(cx, q))) q = pastKeyword(cx, q).pos;
        return src.col(q);
      }
    }
  }
  return defaultValue;
}

function ifStarIndent(cx: Ctx, level: Level): number {
  const { src } = cx;
  const { text } = src;
  const startCol = src.col(level.open);
  const firstClause = pastKeyword(cx, level.open).pos;
  const prev = sexpStart(text, level.sexps[level.n - 1]);
  const defaultValue = src.col(firstClause);
  let bodyP = true;
  let bodyIndent: number;
  const q = Math.max(src.indentationEnd(prev), firstClause);
  if (IF_STAR_KEYWORD.test(at(cx, q))) bodyIndent = src.col(pastKeyword(cx, q).pos);
  else if (/^(#'|'|\()/.test(at(cx, q))) bodyIndent = src.col(q);
  else {
    bodyP = false;
    bodyIndent = src.col(prev);
  }
  const here = at(cx, cx.first);
  if (here === "" || here.startsWith("\n") || here.startsWith(";")) return bodyP ? bodyIndent : defaultValue;
  const m = IF_STAR_KEYWORD.exec(here);
  return m ? 7 + startCol - m[0].length : bodyIndent;
}

/** The column SLIME would indent the line starting at `lineStart` to. Lines
 * that start inside a string or block comment, and ;;; comment lines, keep
 * their current indentation. */
export function indentColumn(text: string, lineStart: number, specs: IndentSpecs): number {
  return lineIndent(new Source(new Parsed(text)), normalize(specs), lineStart) ?? skipBlanks(text, lineStart) - lineStart;
}

const parsedDocs = new WeakMap<Text, Parsed>();

function parsedDoc(doc: Text): Parsed {
  let p = parsedDocs.get(doc);
  if (!p) {
    p = new Parsed(doc.toString());
    parsedDocs.set(doc, p);
  }
  return p;
}

function serviceIndent(cx: IndentContext, pos: number, specs: Specs): number | null {
  const doc = cx.state.doc;
  const brk = cx.simulatedBreak;
  const region = regionOf(cx.state);
  if (region.from > 0) {
    // Indent only the live input, measured in the columns the user sees after the prompt.
    const at = toRegion(region, brk !== null && brk === pos ? pos : doc.lineAt(pos).from);
    if (at === null || (brk !== pos && doc.lineAt(pos).from < region.from)) return null;
    const text = region.text.toString();
    if (brk !== null && brk === pos) {
      return lineIndent(new Source(new Parsed(`${text.slice(0, at)}\n${text.slice(at)}`)), specs, at + 1);
    }
    return lineIndent(new Source(new Parsed(text)), specs, at);
  }
  if (brk !== null && brk === pos) {
    const whole = doc.toString();
    const rest = whole.slice(brk);
    const double = cx.lineAt(pos, 1).text === "" && /^[^\n]*\S/.test(rest);
    const text = whole.slice(0, brk) + (double ? "\n\n" : "\n") + rest;
    return lineIndent(new Source(new Parsed(text)), specs, brk + 1);
  }
  const reindented = (line: number) => {
    const l = doc.line(line + 1);
    const now = cx.lineIndent(l.from);
    const was = cx.countColumn(l.text, l.text.search(/\S|$/));
    return now === was ? null : now;
  };
  return lineIndent(new Source(parsedDoc(doc), reindented), specs, doc.lineAt(pos).from);
}

const specSource = Facet.define<() => IndentSpecs, () => IndentSpecs>({
  combine: (getters) => getters[0] ?? (() => ({})),
});

const specsOf = (state: EditorState) => normalize(state.facet(specSource)());

/** Lisp indentation for Enter, Tab and Vim's `=`, reading Swank's specs
 * through `specs` each time. */
export function lispIndentation(specs: () => IndentSpecs): Extension {
  return [specSource.of(specs), indentService.of((cx, pos) => serviceIndent(cx, pos, specsOf(cx.state)))];
}

/** Reindent every line touching `from`..`to`, as one "indent" edit. */
export function reindentRange(state: EditorState, from: number, to: number): TransactionSpec {
  const given = new Map<number, number>();
  const src = new Source(parsedDoc(state.doc), (line) => given.get(line) ?? null);
  const normalizedSpecs = specsOf(state);
  const changes: { from: number; to: number; insert: string }[] = [];
  const last = state.doc.lineAt(to).number;
  for (let n = state.doc.lineAt(from).number; n <= last; n++) {
    const line = state.doc.line(n);
    const blank = !/\S/.test(line.text);
    const indent = blank ? 0 : lineIndent(src, normalizedSpecs, line.from);
    if (indent === null) continue;
    const current = /^[ \t]*/.exec(line.text)![0];
    const wanted = " ".repeat(indent);
    if (blank ? line.text !== "" : current !== wanted) {
      changes.push({ from: line.from, to: line.from + (blank ? line.text.length : current.length), insert: wanted });
    }
    given.set(n - 1, indent);
  }
  return { changes, userEvent: "indent" };
}

/** Reindent the top-level form at the cursor. */
export const reindentForm: StateCommand = ({ state, dispatch }) => {
  const pos = state.selection.main.head;
  const form = forms(parsedDoc(state.doc).roots).find((n) => n.from <= pos && pos <= n.to);
  if (!form) return false;
  const spec = reindentRange(state, form.from, form.to);
  if ((spec.changes as unknown[]).length) dispatch(state.update(spec));
  return true;
};
