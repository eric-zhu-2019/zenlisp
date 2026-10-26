import { closeTour, TOUR } from "../tour";
import { useStore } from "../store";
import { Icon } from "./Icon";

/** The getting-started list: things to try, checked off as they are done. */
export function Tour() {
  const open = useStore((s) => s.tourOpen);
  const done = useStore((s) => s.tourDone);
  if (!open) return null;
  const count = TOUR.filter((t) => done.includes(t.id)).length;
  const next = TOUR.find((t) => !done.includes(t.id));
  return (
    <aside className="tour" aria-label="Getting started" data-testid="tour">
      <div className="tour-head">
        <strong>Getting started</strong>
        <span className="dim">
          {count} of {TOUR.length}
        </span>
        <button className="icon-btn" title="Close the list" onClick={closeTour}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <ol>
        {TOUR.map((t) => {
          const isDone = done.includes(t.id);
          return (
            <li key={t.id} className={isDone ? "done" : t === next ? "next" : ""}>
              <span className="tick" aria-label={isDone ? "done" : "to do"}>
                {isDone ? "✓" : ""}
              </span>
              <div>
                <div className="tour-title">{t.title}</div>
                {t === next && <div className="tour-how">{t.how}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {!next && <div className="tour-how">That is the whole loop: edit, evaluate, debug, carry on. Help ▸ Getting Started shows this again.</div>}
    </aside>
  );
}
