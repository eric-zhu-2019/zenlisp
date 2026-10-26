# Vendored parinfer-rust

`src/parinfer.rs`, `src/types.rs`, `src/changes.rs`, and `LICENSE.md` are copied unmodified from
[parinfer-rust](https://github.com/eraserhd/parinfer-rust) at commit
`0d33495` ("Merge pull request #163 from agorgl/filetype-options"). They are ISC licensed.

Upstream's own wasm target depends on `stdweb`, which no longer builds, so this crate keeps only
the engine and exposes it through `wasm-bindgen` in `src/lib.rs`.

To update, copy those three files and the license from a newer upstream checkout, update the
commit above, then run `scripts/build-parinfer.sh` and `cargo test` here.
