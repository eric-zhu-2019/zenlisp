// Getting started: a short list of things to try, each checked off when it is done.

import { get, set } from "./store";

export const TOUR = [
  { id: "project", title: "Open or create a project", how: "⌘O opens a folder; ⇧⌘N makes a new ASDF project." },
  { id: "eval", title: "Evaluate a form", how: "Put the cursor in a form and press ⌘↩. The value shows beside it." },
  { id: "repl", title: "Use the REPL", how: "⌘J goes to the REPL. ↩ at the end of a complete form runs it." },
  { id: "debug", title: "Meet the debugger", how: 'Run (error "oops") in the REPL. Lisp stops and shows its stack.' },
  { id: "restart", title: "Carry on from an error", how: "Pick a restart, or restart a frame after fixing the code, without losing state." },
  { id: "docs", title: "Look something up", how: "⇧⌘D shows a symbol's documentation, with its HyperSpec page." },
  { id: "tests", title: "Run the tests", how: "⌘U runs the project's tests and lists them by result." },
] as const;

export type TourStep = (typeof TOUR)[number]["id"];

const KEY = "zparen.tour";

type Saved = { done: TourStep[]; dismissed: boolean };

function load(): Saved {
  try {
    return { done: [], dismissed: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { done: [], dismissed: false };
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // The list just starts over.
  }
}

export const tourState = load;

export function markTour(step: TourStep) {
  const s = load();
  if (s.done.includes(step)) return;
  const next = { ...s, done: [...s.done, step] };
  save(next);
  set({ tourDone: next.done });
}

/** Opens the list the first time a project opens, unless it was closed before. */
export function offerTour() {
  if (!load().dismissed) set({ tourOpen: true, tourDone: load().done });
}

export function openTour() {
  set({ tourOpen: true, tourDone: load().done });
}

export function closeTour() {
  save({ ...load(), dismissed: true });
  set({ tourOpen: false });
}

export const tourComplete = () => TOUR.every((t) => get().tourDone.includes(t.id));
