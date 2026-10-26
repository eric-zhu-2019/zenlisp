import { Marked } from "marked";
import { useMemo } from "react";
import * as actions from "../actions";
import { openExternal } from "../platform";
import { useStore } from "../store";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// HTML written in the file is shown as text, never run: a script in a cloned
// README would otherwise run inside the app. Only web images load; a local
// one shows its description, as the app cannot serve files to the page.
const markdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ href, text }) =>
      /^https?:\/\//.test(href) ? `<img src="${escape(href)}" alt="${escape(text)}">` : `<span class="md-image">${escape(text || href)}</span>`,
  },
});

export const isMarkdown = (path: string | null) => !!path && /\.(md|markdown)$/i.test(path);

/** Where a link in `from` leads: a web page, another file of the project, or nowhere. */
function follow(from: string, href: string) {
  if (/^(https?:|mailto:)/i.test(href)) return void openExternal(href);
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return;
  const [file] = href.split("#");
  const parts = from.split("/").slice(0, -1);
  for (const p of decodeURIComponent(file).split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  void actions.navigate(parts.join("/"));
}

/** A Markdown file as it reads, from its current text, unsaved edits included. */
export function MarkdownPreview({ path }: { path: string }) {
  const text = useStore((s) => s.tabs.find((t) => t.path === path)?.text ?? "");
  const html = useMemo(() => markdown.parse(text) as string, [text]);
  return (
    <div
      className="md-preview"
      data-testid="markdown-preview"
      onClick={(e) => {
        const link = e.target instanceof Element ? e.target.closest("a") : null;
        if (!link) return;
        e.preventDefault();
        follow(path, link.getAttribute("href") ?? "");
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
