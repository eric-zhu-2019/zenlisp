import { useEffect, useRef } from "react";
import { activeEditor } from "../editor/commands";

/** Gives focus back to whatever had it when an overlay opened, or to the editor. */
export function useReturnFocus(open: boolean) {
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      previous.current = document.activeElement as HTMLElement | null;
      return;
    }
    const el = previous.current;
    previous.current = null;
    if (el && el.isConnected && el !== document.body) el.focus();
    else activeEditor.view?.focus();
  }, [open]);
}
