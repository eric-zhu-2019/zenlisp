import { useRef } from "react";

/**
 * The draggable edge of a side panel. `side` is the panel's edge it sits on:
 * "right" for the left sidebar, whose width grows as the edge moves right, and
 * "left" for the right panel. Double-click restores the default width; with
 * focus, the arrow keys move the edge too.
 */
export function EdgeHandle({ side, width, min, max, fallback, onResize, label }: {
  side: "left" | "right";
  width: number;
  min: number;
  max: () => number;
  fallback: number;
  onResize: (width: number) => void;
  label: string;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(max(), w)));
  const sign = side === "right" ? 1 : -1;
  return (
    <div
      className={`edge-handle ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize; double-click for the default width"
      // Capturing the pointer keeps the drag going over iframes such as the HyperSpec page.
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(clamp(drag.current.w + sign * (e.clientX - drag.current.x)));
      }}
      onPointerUp={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onResize(clamp(fallback))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") onResize(clamp(width - sign * step));
        else if (e.key === "ArrowRight") onResize(clamp(width + sign * step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
