// Font choices for the editor and the interface. A web view cannot list the
// installed fonts, so common families are offered when this Mac has them, and
// any other family can be typed in.

export const CODE_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Courier New",
  "PT Mono",
  "Andale Mono",
  "JetBrains Mono",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Cascadia Code",
  "Hack",
  "Iosevka",
  "Iosevka Term",
  "Inconsolata",
  "Ubuntu Mono",
  "Roboto Mono",
  "Victor Mono",
  "Geist Mono",
  "Commit Mono",
  "Monaspace Neon",
  "Berkeley Mono",
  "Input Mono",
  "Operator Mono",
  "Hasklig",
  "DejaVu Sans Mono",
];

export const UI_FONTS = [
  "Helvetica Neue",
  "Helvetica",
  "Avenir Next",
  "Avenir",
  "Lucida Grande",
  "Gill Sans",
  "Futura",
  "Optima",
  "Verdana",
  "Inter",
  "IBM Plex Sans",
  "Source Sans 3",
  "Roboto",
  "Open Sans",
  "Geist",
  "Noto Sans",
];

let canvas: CanvasRenderingContext2D | null = null;

/** Whether `family` is installed: text set in it measures differently from the fallbacks. */
export function installed(family: string): boolean {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return false;
  const sample = "mmmmmmmmmmlli10OO@#";
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    canvas!.font = `72px ${generic}`;
    const base = canvas!.measureText(sample).width;
    canvas!.font = `72px ${quote(family)}, ${generic}`;
    return canvas!.measureText(sample).width !== base;
  });
}

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

/** A CSS font stack with `family` first, or null to keep the default. */
export function fontStack(family: string, fallback: "monospace" | "sans-serif"): string | null {
  const name = family.trim();
  if (!name) return null;
  return fallback === "monospace" ? `${quote(name)}, "SF Mono", ui-monospace, Menlo, monospace` : `${quote(name)}, -apple-system, BlinkMacSystemFont, sans-serif`;
}
