# What ZParen borrows from TurboLisp

TurboLisp ships WhateverCLIM's Listener, Inspector, Debugger and Zeta editor
as a native Mac app. We read both projects for
product ideas. No code is reused.

Ranked ideas to borrow:

1. Live repair. The debugger keeps the stack while the REPL and editor stay
   usable. Fix the data or redefine the function, then invoke Retry.
2. An editor evaluation that errors marks the form in the source with a short
   message. Clicking the mark opens the debugger.
3. Clickable live values. Click a result to inspect it, right-click for a
   menu, insert it into the current input. Swank presentations provide this.
4. Inline argument help with the current argument highlighted, plus a
   Describe card (`swank:autodoc`).
5. Form breakpoints and stepping (`sb-di` breakpoints, SBCL stepper
   restarts), with honest pending and installed states.
6. A read-only inspector with back and forward, breadcrumbs, a slot filter
   and per-type views.
7. Inline condition cards in the REPL transcript showing level, thread and
   condition type.
8. A threads sidebar.
9. Inline macroexpansion under the form, closed with Escape.
10. A toolbar package picker that updates the prompt, with a debugger-level
    badge.
11. Saved-image startup. A prebuilt SBCL core starts in milliseconds.

Gaps in WhateverCLIM that ZParen fills: compiler-note annotations, xref and
jump to definition, apropos, ASDF and package-manager project management,
Restart Frame.
