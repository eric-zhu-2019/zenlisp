# ZenLisp

ZenLisp is a Common Lisp IDE for macOS, built on SBCL. You work in one live
image: evaluate a form, click the result to inspect the real object, stop in
the debugger, fix the code, and restart the frame that failed. Claude can work
in the same image, from the built-in assistant or from Claude Code over MCP.

![The REPL, the debugger with its restarts and backtrace, and the inspector](docs/screenshots/debugger.png)

## Written entirely by Claude Code

ZenLisp is a vibe-coding project. [Claude Code](https://claude.com/claude-code)
wrote all of it: the Rust backend, the TypeScript UI, the Lisp that runs inside
SBCL, the tests, the build and release scripts, and these docs. It ran on
Claude Opus 5.5. The human author wrote no code. They asked for features,
used the app, reported bugs, and made the product calls.

Claude Code worked in a fixed loop. It read the code, made a change, ran
`scripts/verify.sh`, and committed only when every check passed. Bugs were
reproduced first, in the browser build driven by Playwright or against a real
SBCL, and fixes come with tests.

### Skills and agents involved

Claude Code ran with the pstack plugin's
`/pstack:poteto-mode`, which sets how it plans, builds and verifies work. These
are the skills it loaded while building ZenLisp:

| Skill | What it was used for |
| --- | --- |
| `pstack:poteto-mode` | The working mode: playbooks for features and bug fixes, and the principles below |
| `figure-it-out` | Planning the large multi-phase build-out |
| `feature` playbook | Each new feature, starting from its data shape |
| `show-me-your-work` | The decision trail kept during long autonomous runs |
| `technical-writing` | This README, the docs and the commit messages |
| `no-comments` | Keeping only comments that explain a non-obvious why |
| `claude-api` | The built-in assistant's Anthropic API client, model and streaming |
| Principles | `prove-it-works`, `foundational-thinking`, `model-the-domain`, `experience-first`, `exhaust-the-design-space`, `sequence-verifiable-units`, `laziness-protocol`, `build-the-lever`, `boundary-discipline`, `test-behavior-not-implementation`, `never-block-on-the-human` |

Subagents took on separate pieces. The coding agents each worked in their own git worktree:

| Agent | Work |
| --- | --- |
| `pstack:poteto-agent` | The SLIME-compatible indentation engine, paredit-style structural editing, the parinfer wasm crate, and the MCP server with its shared tool registry |
| `pstack:comment-sicko` | A pass that deleted comments restating the code |
| `Explore` | Research into the UX of other Lisp IDEs |
| `general-purpose` | Side tasks, including an independent review of the decision trail |

## What it does

- **REPL and inspector.** Results are live objects: click one to use it in the
  next input, ⌘-click to inspect it. ⌃R searches earlier input. Extra REPLs run
  in their own threads.
- **Debugger.** Restarts, backtrace, frame locals, restart a frame, form
  breakpoints and stepping.
- **Checking as you type.** Each file is compiled in the background, without
  loading it, and warnings mark the exact symbol. Saving compiles only the
  top-level forms that changed into the running Lisp.
- **Navigation.** `gd` goes to local bindings first, then to Lisp's own record
  of a definition, then to definitions in code not loaded yet. ⌃O goes back.
- **Tools.** Trace and Profile panels, macroexpansion in place, disassembly,
  and a test runner for FiveAM, Parachute and Rove.
- **Documentation.** A Docs panel with argument lists, docstrings, apropos and
  the HyperSpec.
- **Projects.** ASDF systems with Quicklisp, qlot, ocicl or vendored
  dependencies, a dependency editor, and startup images.
- **Editor.** Vim keys, SLIME's Emacs sequences, parinfer, structural editing,
  split panes, a git gutter with inline diffs, and a choice of editor and
  interface fonts.
- **Mac app.** Signed releases that carry their own SBCL, and in-app updates.

![Ask AI to fix: the assistant reads the warning and edits the file](docs/screenshots/ask-ai-to-fix.png)

## Run it

You need Node.js, Rust and SBCL. ZenLisp looks for `sbcl` on `PATH`, then in
`/opt/homebrew/bin`, `/usr/local/bin`, and `/opt/local/bin`. Release builds
carry their own SBCL, so they run on Macs without one.

To build and open the app:

```sh
npm install
npx tauri build --bundles app
open target/release/bundle/macos/ZenLisp.app
```

For development, run `npx tauri dev`.

The first start builds an SBCL core with Swank preloaded and caches it in
`~/Library/Caches/ZenLisp`. That takes about two seconds. Later starts take
milliseconds, and the core rebuilds by itself when SBCL or the bundled Lisp
files change.

## Work in a project

Open a folder with **Open Project…**, or create one with **New Project**. A new
project has an ASDF system, a test system, and an executable build target.

ZenLisp finds the dependency manager from the files in the project root:

| Found in the root | Manager | Dependencies come from |
| --- | --- | --- |
| `qlfile` | qlot | `.qlot/setup.lisp`, after **Install Dependencies** runs `qlot install` |
| `ocicl.csv` or `ocicl/` | ocicl | ocicl's runtime, which fetches missing systems as they load |
| `vendor/`, `lib/`, `third_party/`, or `deps/` holding `.asd` files | vendor | those directories, added to the ASDF source registry |
| none of the above | Quicklisp | `~/quicklisp`, `~/.quicklisp`, or Roswell's Quicklisp |

qlot replaces the global Quicklisp, so a project with a `qlfile` never loads
both.

The **Systems** sidebar lists every system in the project's `.asd` files.
**Load** loads a system and fetches its dependencies. **Test** runs
`asdf:test-system`. **Build** runs `asdf:make` in a separate SBCL and streams
the output to the **Output** panel.

## Use Claude

Open the assistant with ⌘L. It needs an Anthropic API key, which you can paste
in the assistant settings. ZenLisp also uses `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile when one exists. The
assistant uses `claude-opus-5-5` and the same tools as the MCP server below.
Code it proposes in a reply has **Insert** and **Eval** buttons.

To let Claude Code work in your image, copy the command from the assistant
settings and run it in a terminal. It looks like this:

```sh
claude mcp add --transport http zenlisp http://127.0.0.1:7337/mcp --header "Authorization: Bearer <token>"
```

The server listens only on `127.0.0.1` and checks the token on every request.
The token lives in `~/Library/Application Support/ZenLisp/mcp-token`.

The tools are `eval`, `compile_form`, `describe_symbol`, `apropos`,
`find_definitions`, `who_calls`, `macroexpand`, `list_packages`,
`project_info`, `load_system`, `run_tests`, `debugger_state`,
`invoke_restart`, `read_file`, `edit_file`, and `list_files`.

Every warning and error mark has an **Ask AI to fix** button, in the hover
box, in the box that opens when the cursor reaches a mark, and in the lint
panel. It sends SBCL's message, the file, the line and the code to the
assistant, which finds the cause and changes the file with `edit_file`. The
change shows in the editor at once, and one undo takes it back.

## Keys

Press ⇧⌘/ for every shortcut, with a filter. The list comes from the same
table that defines the bindings, so it is always current. These are the
ones you use most:

| Action | Shortcut | Vim |
| --- | --- | --- |
| Evaluate the form at the cursor | ⌘↩ | `,e` |
| Compile the form, with compiler notes | ⇧⌘↩ | `,c` |
| Compile and load the file | ⌘B | `,l` |
| Go to definition, find references | F12, ⇧F12 | `gd`, `gr` |
| Go back, go forward | ⌃O, ⌃⇧O | same in Vim |
| Slurp, barf | ⌃), ⌃} | `>)`, `<)` |
| Select a form | ⌃⇧⌘→ | `vaf` |
| Search in project | ⇧⌘F | |
| Command palette | ⇧⌘P | |

SLIME's Emacs sequences work too, in any Vim mode: `C-x C-e` evaluates the
form before the cursor, `C-M-x` the top-level form, `C-c C-c` compiles it,
`C-c C-k` compiles and loads the file, `M-.` and `M-,` jump to a definition
and back, and `C-c C-z` switches to the REPL. The status bar shows a prefix
while you type it, and `C-g` cancels.

Hover a symbol to see its documentation, or its argument list when it has
none. Turn off Vim keys, Emacs sequences, parinfer or checking as you type in
Settings (⌘,).

## Edit code

Parinfer keeps parentheses balanced as you type, and typing `(` or `"` over
a selection wraps it. The structural commands move code by whole forms:
slurp, barf, raise, splice, kill, transpose, split, and join. In Vim,
`af`, `if`, `aF`, and `iF` select a form, its inside, or the whole top-level
form, so `daf` and `cif` work as you would expect.

The file tree creates, renames, and moves files to the Trash. When another
program changes an open file, ZenLisp reloads it if you have no unsaved
edits, and asks otherwise. It also asks before closing a file or quitting
with unsaved changes.

**Search** in the sidebar finds and replaces across the project, with the
same `.gitignore` rules as ripgrep. The **Problems** panel lists compiler
notes from every file.

## Develop

`scripts/verify.sh` runs every check: the Rust tests against a real SBCL, the
parinfer wasm tests, the TypeScript tests, and the WebKit end-to-end tests.
Add `--network` to include the ocicl test, which downloads from `ghcr.io`.

To run the UI in a browser against a real SBCL, start the bridge and Vite:

```sh
cargo run -p zenlisp-dev
npx vite --port 1420
```

Set `ZENLISP_TRACE=1` to log every Swank message.

## Release

`scripts/release.sh` builds `ZenLisp.app` and its disk image signed with a
Developer ID, and checks the signatures. The app carries the installed SBCL
(`scripts/bundle-sbcl.sh`), signed with the hardened runtime and the
entitlements SBCL needs to compile code, so it runs on Macs without SBCL.

```sh
security find-identity -v -p codesigning            # pick a Developer ID Application identity
ZENLISP_SIGN_IDENTITY="Developer ID Application: …" scripts/release.sh
```

To notarize, save notarytool credentials once, then pass the profile:

```sh
xcrun notarytool store-credentials zenlisp --apple-id you@example.com --team-id TEAMID
ZENLISP_SIGN_IDENTITY="…" NOTARY_PROFILE=zenlisp scripts/release.sh
```

The script submits the disk image, waits for Apple, and staples the ticket to
the image and the app, so Gatekeeper opens them offline.

To ship updates, make a key pair once with `npx tauri signer generate` and
keep the private half safe. Builds made with the update variables check for a
newer release at launch and from ZenLisp ▸ Check for Updates…, and install only
archives signed with that key:

```sh
ZENLISP_UPDATE_URL=https://example.com/zenlisp/latest.json \
ZENLISP_UPDATE_DOWNLOAD=https://example.com/zenlisp/ZenLisp.app.tar.gz \
ZENLISP_UPDATE_PUBKEY="$(cat zenlisp.key.pub)" TAURI_SIGNING_PRIVATE_KEY="$(cat zenlisp.key)" \
ZENLISP_SIGN_IDENTITY="…" scripts/release.sh
```

It writes `latest.json` beside the archive; publish both at those URLs. A
build without these variables has updates off and says so.

## Learn more

[How ZenLisp is built](docs/architecture.md) explains the design.
[What ZenLisp borrows from TurboLisp](docs/inspiration.md) lists the ideas taken
from TurboLisp and WhateverCLIM.

## License

ZenLisp is MIT licensed, see [LICENSE](LICENSE). It includes Swank from
[SLIME](https://github.com/slime/slime) in `resources/swank`, which is in the
public domain, and the parinfer engine from
[parinfer-rust](https://github.com/eraserhd/parinfer-rust) in
`crates/parinfer-wasm`, which is ISC licensed.
