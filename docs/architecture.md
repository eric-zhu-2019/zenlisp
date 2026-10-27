# How ZParen is built

ZParen has three layers. A React and CodeMirror UI runs in Tauri's webview.
A Rust backend owns the Lisp session, the project, the AI assistant, and the
MCP server. SBCL runs as a child process and speaks the Swank protocol, the
same one SLIME uses.

## Why Swank

Swank already has what an IDE needs from a running image: fuzzy completion,
argument lists, the debugger, restarts, frame locals, the inspector,
cross-references, and presentations. Writing a new protocol would mean
rewriting all of that, so ZParen vendors Swank from SLIME 2.30 into
`resources/swank` (see `scripts/vendor-swank.sh`) and loads only what it uses.

Two Swank details shape the client in `crates/zparen-core/src/swank.rs`.
REPL output arrives as `(:write-string text nil thread)`, and Swank blocks the
writing thread until the client answers `(:write-done thread)`. A client that
misses this stalls the first compile, which holds the compiler lock, and every
later request waits behind it. Errors never return a reply. They open a
debugger level instead, so every caller that waits on a reply must also watch
for a debugger event. `tools.rs` does this in `watch`.

## Why a cached core

Loading Swank from source at each start compiles its fasls into a shared
directory. Two SBCLs starting at once raced on those files, and one loaded a
half-written fasl. ZParen now builds an SBCL core with Swank preloaded,
writes it to a temporary file, and renames it into
`~/Library/Caches/ZParen`. The cache key covers the SBCL version and every
bundled Lisp file. A warm start takes about 50 ms. TurboLisp ships a saved
image for the same reason.

SBCL exits when its standard input closes. ZParen holds that pipe, so a
crashed IDE never leaves an orphan SBCL behind.

## One request type for every caller

`Workbench::handle` in `workbench.rs` takes a `Request` and returns a
`Response`. Tauri IPC, the `zparen-dev` WebSocket bridge, the MCP tools, and
the assistant all go through it, and the UI hears everything else as
`AppEvent`s. Lisp operations are one `Op` enum in `ops.rs`, where each variant
knows its Swank form and how to parse the reply. ts-rs generates the
TypeScript types in `src/protocol` from these Rust types, so the UI cannot
drift from the backend.

Project setup is a list of plain ASDF and UIOP forms from
`Project::setup_forms`. The live session evaluates them, and **Build** passes
the same forms to a clean SBCL that runs `asdf:make`. A build image therefore
carries no Swank.

## Parinfer in the editor

Parinfer runs as wasm built from parinfer-rust's core, vendored in
`crates/parinfer-wasm`. Upstream's own wasm build depends on `stdweb`, which no
longer builds. The CodeMirror extension in `src/editor/parinfer.ts` is a
transaction filter. It corrects each user edit inside the same transaction, so
one undo reverts the edit and the correction together. Programmatic edits,
undo, and redo pass through untouched.

## The assistant and MCP share tools

`tools.rs` is one table of tools with LLM-facing descriptions and typed
parameters. `mcp.rs` serves it over MCP Streamable HTTP with rmcp. It listens
only on loopback, needs a bearer token, and rejects foreign `Origin` headers.
`assistant.rs` offers the same table to Claude through the Messages API.

Rust has no official Anthropic SDK, so the assistant uses raw HTTP with
server-sent events. Its history only grows: each response is appended whole,
thinking blocks and signatures included, so prompt caching keeps working. A
refused turn is dropped. A tool call cut off by the output limit gets an error
result instead of running.

## How it is tested

Every Rust integration test starts a real SBCL. `ops.rs` tests the live-repair
loop: an error, eval in the failing frame, a redefinition, and Restart Frame
returning the fixed value. The Playwright tests in `e2e/` drive the real UI in
WebKit, the engine behind Tauri on macOS, through the `zparen-dev` bridge.
The assistant tests use a local server that streams the documented SSE
format.
