// Edits a system's :depends-on in its .asd file as text, so the rest of the
// file, comments and layout included, stays as the user wrote it.

import { type Node, parse } from "./tree";

const atom = (text: string, n: Node | undefined) => (n ? text.slice(n.start, n.to) : "");

/** The name a system designator in an .asd names: "foo", #:foo, :foo or foo. */
export function designatorName(text: string): string {
  return text.replace(/^#?:/, "").replace(/^"|"$/g, "").toLowerCase();
}

function forms(nodes: Node[]) {
  return nodes.filter((n) => n.kind !== "comment" && n.kind !== "blockComment");
}

/** The (defsystem NAME ...) form for `system`, and its keyword arguments. */
function findSystem(text: string, system: string) {
  for (const top of parse(text)) {
    if (top.kind !== "list") continue;
    const [head, name, ...rest] = forms(top.children);
    if (!/^(asdf:)?defsystem$/i.test(atom(text, head)) || designatorName(atom(text, name)) !== system.toLowerCase()) continue;
    return { form: top, name: name!, args: rest };
  }
  return null;
}

function dependsOn(text: string, args: Node[]) {
  for (let i = 0; i < args.length - 1; i++) {
    if (atom(text, args[i]).toLowerCase() === ":depends-on" && args[i + 1].kind === "list") return args[i + 1];
  }
  return null;
}

/** The dependencies `system` declares, as named in the file. */
export function dependencies(text: string, system: string): string[] {
  const found = findSystem(text, system);
  const list = found && dependsOn(text, found.args);
  return list ? forms(list.children).map((n) => text.slice(n.from, n.to)) : [];
}

/** `text` with `dep` added to `system`'s :depends-on, or null if the system is not defined there. */
export function addDependency(text: string, system: string, dep: string): string | null {
  const found = findSystem(text, system);
  if (!found) return null;
  const entry = JSON.stringify(dep);
  const list = dependsOn(text, found.args);
  if (list) {
    const items = forms(list.children);
    if (items.some((n) => n.kind === "string" || n.kind === "atom" ? designatorName(text.slice(n.start, n.to)) === dep.toLowerCase() : false)) return text;
    const close = list.to - 1;
    const sep = items.length ? " " : "";
    return text.slice(0, close) + sep + entry + text.slice(close);
  }
  // No :depends-on yet: put one on its own line after the name, indented like the next argument.
  const next = found.args[0];
  const indent = next ? next.from - (text.lastIndexOf("\n", next.from) + 1) : 2;
  const insert = `\n${" ".repeat(indent)}:depends-on (${entry})`;
  return text.slice(0, found.name.to) + insert + text.slice(found.name.to);
}

/** `text` without `dep` in `system`'s :depends-on. */
export function removeDependency(text: string, system: string, dep: string): string | null {
  const found = findSystem(text, system);
  const list = found && dependsOn(text, found.args);
  if (!list) return found ? text : null;
  const items = forms(list.children);
  const i = items.findIndex((n) => (n.kind === "string" || n.kind === "atom") && designatorName(text.slice(n.start, n.to)) === dep.toLowerCase());
  if (i < 0) return text;
  const item = items[i];
  // Take the space before the entry, or after it when it is first.
  let from = item.from;
  let to = item.to;
  if (i > 0) from = items[i - 1].to;
  else if (items.length > 1) to = items[1].from;
  return text.slice(0, from) + text.slice(to);
}
