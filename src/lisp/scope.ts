// Where a symbol is bound locally: by a lambda list, LET, FLET and LABELS,
// DESTRUCTURING-BIND, DO, DOLIST, LOOP and the like. This is what Vim's gd
// means, and code being written is often not loaded, so it is read from text.

import { forms, type Node, parse, pathAt } from "./tree";

const name = (text: string, n: Node | undefined) => (n && n.kind === "atom" ? text.slice(n.start, n.to).toLowerCase() : null);

const head = (text: string, list: Node) => name(text, forms(list.children)[0])?.replace(/^(cl|common-lisp):/, "") ?? null;

/** The variables a lambda list binds, with their nodes: required, &optional, &key, &rest, &aux and destructured parts. */
function lambdaListVars(text: string, list: Node | undefined, specialized = false): Node[] {
  if (!list || list.kind !== "list") return list && list.kind === "atom" ? [list] : [];
  const out: Node[] = [];
  let section = "required";
  for (const p of forms(list.children)) {
    const atom = name(text, p);
    if (atom?.startsWith("&")) {
      section = atom;
      continue;
    }
    if (p.kind === "atom") out.push(p);
    else if (p.kind === "list") {
      const [first, , third] = forms(p.children);
      if (section === "required" && !specialized) out.push(...lambdaListVars(text, p));
      else if (section === "&key" && first?.kind === "list") out.push(...forms(first.children).slice(1, 2));
      else if (first) out.push(first);
      // (name default supplied-p) binds the supplied-p variable too.
      if ((section === "&optional" || section === "&key") && third?.kind === "atom") out.push(third);
    }
  }
  return out;
}

/** The lambda list of a defining or LAMBDA form, after its name and any method qualifiers. */
function definitionLambdaList(kind: string, parts: Node[]): { list?: Node; specialized: boolean } {
  if (kind === "lambda") return { list: parts[1], specialized: false };
  if (kind === "defmethod") {
    const list = parts.slice(2).find((p) => p.kind === "list");
    return { list, specialized: true };
  }
  return { list: parts[2], specialized: false };
}

/** What `list` binds that is visible at `pos` inside it, by kind of form. */
function bound(text: string, list: Node, pos: number): Node[] {
  const kind = head(text, list);
  if (!kind) return [];
  const parts = forms(list.children);
  const inBody = (from: number) => pos > from;
  switch (kind) {
    case "defun":
    case "defmacro":
    case "defmethod":
    case "defgeneric":
    case "lambda":
    case "define-compiler-macro": {
      const { list: ll, specialized } = definitionLambdaList(kind, parts);
      return ll && inBody(ll.from) ? lambdaListVars(text, ll, specialized) : [];
    }
    case "let":
    case "let*":
    case "symbol-macrolet":
    case "prog":
    case "prog*": {
      const bindings = parts[1];
      if (!bindings || bindings.kind !== "list") return [];
      return forms(bindings.children).flatMap((b) => (b.kind === "atom" ? [b] : b.kind === "list" ? forms(b.children).slice(0, 1) : []));
    }
    case "flet":
    case "labels":
    case "macrolet": {
      const defs = parts[1];
      if (!defs || defs.kind !== "list") return [];
      const local = forms(defs.children).filter((d) => d.kind === "list");
      // Inside one local function, its own parameters are bound too.
      const inside = local.find((d) => d.start < pos && pos < d.to);
      const params = inside ? lambdaListVars(text, forms(inside.children)[1]) : [];
      return [...params, ...local.map((d) => forms(d.children)[0]).filter(Boolean)];
    }
    case "destructuring-bind":
    case "multiple-value-bind":
      return parts[1] && inBody(parts[1].to) ? lambdaListVars(text, parts[1]) : [];
    case "dolist":
    case "dotimes":
    case "do-symbols":
    case "do-external-symbols":
    case "with-open-file":
    case "with-open-stream":
    case "with-input-from-string":
    case "with-output-to-string":
    case "with-slots":
    case "with-accessors":
    case "handler-bind": {
      const spec = parts[1];
      if (!spec || spec.kind !== "list") return [];
      const first = forms(spec.children)[0];
      if (kind === "with-slots") return forms(spec.children).flatMap((s) => (s.kind === "atom" ? [s] : forms(s.children).slice(0, 1)));
      return first?.kind === "atom" ? [first] : [];
    }
    case "do":
    case "do*": {
      const vars = parts[1];
      return vars?.kind === "list" ? forms(vars.children).flatMap((v) => (v.kind === "list" ? forms(v.children).slice(0, 1) : [v])) : [];
    }
    case "loop": {
      // LOOP's FOR, AS and WITH name a variable, or a destructuring list of them.
      const out: Node[] = [];
      for (let i = 1; i < parts.length - 1; i++) {
        if (/^:?(for|as|with)$/.test(name(text, parts[i]) ?? "")) out.push(...lambdaListVars(text, parts[i + 1]));
      }
      return out;
    }
    default:
      // Other WITH- macros conventionally bind their first argument's first symbol.
      if (kind.startsWith("with-") && parts[1]?.kind === "list") {
        const first = forms(parts[1].children)[0];
        return first?.kind === "atom" ? [first] : [];
      }
      return [];
  }
}

/**
 * Where the symbol at `pos` is bound locally, as the start of the binding
 * symbol, or null when no enclosing form binds it. The innermost binding wins.
 */
export function localBinding(text: string, pos: number): number | null {
  const path = pathAt(parse(text), pos);
  const at = path[path.length - 1];
  const symbol = name(text, at);
  if (!at || !symbol || /^[:&]/.test(symbol)) return null;
  for (const list of path.slice(0, -1).reverse()) {
    if (list.kind !== "list") continue;
    const hit = bound(text, list, pos).find((n) => name(text, n) === symbol);
    if (hit) return hit.start;
  }
  return null;
}
