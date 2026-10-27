# Plugins

ZParen users write Common Lisp, so they extend ZParen in Common Lisp, the
way Emacs users extend Emacs in Elisp. A plugin is Lisp code that every
project's SBCL loads when it starts. With a small API it adds commands with
keys, checks, settings and hooks. The editor learns what plugins add over
Swank, the channel every other Lisp feature uses, so a plugin needs no
TypeScript, no Rust and no rebuild of the app.

The code is in `resources/lisp/plugins.lisp` (Lisp) and `src/plugins.ts`
(editor). `crates/zparen-core/tests/ops.rs` and the end-to-end test "a plugin
adds a command with a key, a setting, a save hook and a REPL command" cover it.

## Where plugins live

Plugins are global: one folder, `~/.config/zparen/plugins/` (under
`$XDG_CONFIG_HOME` when it is set), loaded into every project's Lisp. Plugins
in the old place, `~/Library/Application Support/ZParen/plugins/`, move there
the first time ZParen starts a Lisp. Settings ▸ Plugins opens the folder and reloads it. In it:

- `name.lisp` is the plugin `name`.
- `name/init.lisp` is the plugin `name`, for a plugin of several files.
- `name/name.asd` is the plugin `name` as an ASDF system. Quicklisp fetches
  its dependencies when it is present.

Plugins load when Lisp starts, before Swank, and again on **Reload Plugins**.
Each loads on its own. The first error stops that plugin, Settings shows the
error, and the REPL notes it once. The others still load. A reload replaces
everything the plugins defined.

## Writing one

The package is `zparen-plugin`. A plugin gives it a local nickname.

```lisp
(defpackage #:my-tools
  (:use #:cl)
  (:local-nicknames (#:zp #:zparen-plugin)))
(in-package #:my-tools)

(zp:define-setting wrap-with :type :choice :choices ("time" "progn") :default "time")

(zp:define-command wrap-form (context) (:title "Wrap Form" :key "Mod-Alt-j")
  (let ((form (zp:context-form context)))
    (zp:replace-range (zp:form-start form) (zp:form-end form)
                      (format nil "(~a ~a)" (zp:setting 'wrap-with) (zp:form-text form)))))

(zp:define-check no-eval (file text)
  (let ((at (search "(eval " text)))
    (when at (list (zp:note at (+ at 5) "EVAL here; is it needed?")))))

(zp:add-hook :repl-input
             (lambda (input)
               (when (string= (string-trim " " input) ",hello")
                 (format t "hello~%")
                 :handled)))
```

### Commands

`define-command` adds a palette entry, and a key when `:key` gives one in
CodeMirror's notation, such as `"Mod-Alt-j"` for ⌥⌘J. `:emacs` gives a key
sequence in Emacs's notation, such as `"C-c t"`, which works with Emacs keys
on. The body gets the editor's state as a context:

| Accessor | Value |
| --- | --- |
| `context-file` | The file's path, or NIL |
| `context-text` | The buffer's text, unsaved edits included |
| `context-cursor` | The cursor's offset |
| `context-selection` | The selection's start and end, as two values |
| `context-package` | The buffer's package name |
| `context-form` | The top-level form at the cursor, with `form-start`, `form-end` and `form-text` |

The body asks for changes, and the editor makes them when it returns:

| Function | What the editor does |
| --- | --- |
| `(replace-range start end text)` | Replaces text in the buffer |
| `(insert text)` | Inserts at the cursor |
| `(open-file path &key line)` | Opens a file, at a line |
| `(message text)` | Shows a flash message |
| `(repl-print text)` | Writes to the REPL |

What the body prints goes to the REPL. Offsets count characters as Lisp
does. The editor counts UTF-16 code units, so text with characters outside
the Basic Multilingual Plane, such as emoji, shifts offsets after them.

`examples/plugins/insert-datetime.lisp` is a complete plugin. It inserts
the date and time at the cursor on C-c t, and a setting chooses whether it
inserts the time too. Copy it into the plugins folder and reload.

### Checks

`define-check` adds a function that runs with each live check of a file. It
gets the file's path (NIL for an unsaved buffer) and text, and returns notes
made with `(note start end message &key severity)`, where severity is
`:error`, `:warning`, `:style-warning` or `:note`. The notes show with the
compiler's, the check's name in brackets. A check gets half a second, and one
that takes longer is stopped and reported.

### Settings

`define-setting` adds a control to Settings ▸ Plugins. Its `:type` is
`:boolean`, `:string`, `:number` or `:choice` (one of `:choices`, a list of
strings), with a `:default`, a `:title` and a `:doc`. `(setting 'name)` reads
the value. Values persist in `plugins/settings.sexp` and survive reloads and
restarts.

### Hooks

`(add-hook event function)` runs the function when the event happens, and
`remove-hook` takes it off.

| Event | Arguments | Notes |
| --- | --- | --- |
| `:session-ready` | root | Lisp started for a project. Runs in its own thread. |
| `:before-save` | path, text | Before a file is written. `replace-range` changes what is written. |
| `:after-save` | path | After a file is written. |
| `:after-load-system` | name | After Load, or a session's reload, loads a system. |
| `:after-compile-file` | path, success | After ⌘B compiles a file. Live checks don't count. |
| `:tests-finished` | run | After a test run, a plist with `:passed`, `:failed`, `:skipped` and `:tests`. |
| `:debugger-entered` | condition | An error opened the debugger. |
| `:repl-input` | input | Before REPL input is evaluated. Return a string to evaluate instead, `:handled` to evaluate nothing, or NIL. |
| `:repl-result` | input, values | After REPL input is evaluated, with its values as a list. |

The REPL hooks run for the main REPL and for extra REPLs.

## Errors

Every call into a plugin runs inside a handler, so its errors never open the
debugger. That matters because a thread stopped in the debugger can hold the
image lock that checks and compiles wait for (see `*image-lock*` in
`zparen.lisp`). An error becomes a message naming the plugin. For a command
or an editor hook, it shows as a flash and in the REPL. For a hook that runs
inside Lisp, it shows in the REPL, and for a check, as a note.

## How the editor and Lisp talk

1. When a session is ready, the editor calls `zparen-plugin::manifest`. It
   returns JSON with the plugins and their errors, the commands, the settings
   and the events that have hooks.
2. A command runs through `zparen-plugin::run-command` with the editor's
   state, and answers with the effects and errors.
3. The editor runs `:before-save` and `:after-save` through
   `zparen-plugin::run-editor-hook`, only when a plugin hooks them. Every
   other event happens in Lisp, which wraps the Swank and ZParen functions
   involved with `sb-int:encapsulate`.
4. Checks run inside `zparen::check-text`, through `*check-functions*`.
5. Changing a setting or reloading answers with a new manifest.

## Why Lisp, not JavaScript

VS Code and Zed take plugins in JavaScript or WebAssembly. ZParen doesn't,
for three reasons:
- **Its users write Lisp.** A Lisp plugin can call the project's own code
  and the image's state directly.
- **Safety.** JavaScript in the webview would have the app's IPC, including
  file writes and process launches, and nothing between it and the page.
- **One language.** A Lisp-only API keeps one language to learn, test and
  debug, and the debugger already works on it.

The cost is that a plugin needs a running Lisp. Plugin commands and settings
appear once a session is ready.

## Later

- `define-completion-source`, whose candidates join Swank's completion.
- `define-theme`, so a plugin can carry themes for the theme pickers.
- Status-bar items.
