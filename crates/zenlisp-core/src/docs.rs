//! The Common Lisp HyperSpec, from a local copy such as Quicklisp's "clhs"
//! release. Its license allows showing complete, unmodified copies, so ZenLisp
//! serves the pages as they are and only reads the symbol index to find them.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

pub struct HyperSpec {
    /// The `HyperSpec` directory, holding `Front`, `Body` and `Data`.
    pub root: PathBuf,
    /// Upper-case symbol names to their page, relative to `root`, such as `Body/f_car.htm`.
    symbols: HashMap<String, String>,
}

impl HyperSpec {
    pub fn load(root: PathBuf) -> Option<HyperSpec> {
        let index = std::fs::read_to_string(root.join("Data/Map_Sym.txt")).ok()?;
        let mut lines = index.lines();
        let mut symbols = HashMap::new();
        while let (Some(name), Some(page)) = (lines.next(), lines.next()) {
            let page = page.trim().trim_start_matches("../");
            symbols.insert(name.trim().to_string(), page.to_string());
        }
        Some(HyperSpec { root, symbols })
    }

    /// The page for a Common Lisp symbol. A package prefix such as `cl:` is ignored.
    pub fn page(&self, symbol: &str) -> Option<&str> {
        let name = symbol.rsplit(':').next().unwrap_or(symbol).to_uppercase();
        self.symbols.get(&name).map(String::as_str)
    }

    /// A file of the HyperSpec, for display. Paths that leave it are refused.
    pub fn read(&self, path: &str) -> Option<(Vec<u8>, &'static str)> {
        let rel = Path::new(path.trim_start_matches('/'));
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        // The spec's own stylesheet is replaced by ZenLisp's, which every page links.
        if rel == Path::new("Data/clhs.css") {
            return Some((include_bytes!("clhs.css").to_vec(), "text/css"));
        }
        let bytes = std::fs::read(self.root.join(rel)).ok()?;
        let mime = match rel.extension().and_then(|e| e.to_str()).unwrap_or_default() {
            "htm" | "html" => "text/html; charset=iso-8859-1",
            "gif" => "image/gif",
            "txt" | "text" => "text/plain; charset=iso-8859-1",
            "css" => "text/css",
            _ => "application/octet-stream",
        };
        Some((bytes, mime))
    }
}

/// Where a HyperSpec may be: `$ZENLISP_HYPERSPEC`, then Quicklisp's clhs releases.
pub fn find_root() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ZENLISP_HYPERSPEC").map(PathBuf::from) {
        return p.join("Data/Map_Sym.txt").is_file().then_some(p);
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let dists = ["quicklisp", ".quicklisp", ".roswell/lisp/quicklisp"].map(|q| home.join(q).join("dists/quicklisp/software"));
    let mut found: Vec<PathBuf> = dists
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("clhs-")))
        .map(|p| p.join("HyperSpec-7-0/HyperSpec"))
        .filter(|p| p.join("Data/Map_Sym.txt").is_file())
        .collect();
    // The newest release sorts last.
    found.sort();
    found.pop()
}

static LOADED: OnceLock<std::sync::Mutex<Option<std::sync::Arc<HyperSpec>>>> = OnceLock::new();

/// The local HyperSpec, looked for again until one is found, so installing it
/// while ZenLisp runs takes effect at once.
pub fn hyperspec() -> Option<std::sync::Arc<HyperSpec>> {
    let cell = LOADED.get_or_init(Default::default);
    let mut slot = cell.lock().unwrap();
    if slot.is_none() {
        *slot = find_root().and_then(HyperSpec::load).map(std::sync::Arc::new);
    }
    slot.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (PathBuf, HyperSpec) {
        let root = std::env::temp_dir().join(format!("zenlisp-clhs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Data")).unwrap();
        std::fs::create_dir_all(root.join("Body")).unwrap();
        std::fs::write(root.join("Data/Map_Sym.txt"), "CAR\n../Body/f_car_c.htm\nMAPCAR\n../Body/f_mapc_.htm\n").unwrap();
        std::fs::write(root.join("Body/f_car_c.htm"), "<html>car</html>").unwrap();
        let hs = HyperSpec::load(root.clone()).unwrap();
        (root, hs)
    }

    #[test]
    fn finds_pages_by_symbol_in_any_case_and_package() {
        let (_, hs) = sample();
        assert_eq!(hs.page("mapcar"), Some("Body/f_mapc_.htm"));
        assert_eq!(hs.page("cl:car"), Some("Body/f_car_c.htm"));
        assert_eq!(hs.page("my-function"), None);
    }

    #[test]
    fn serves_only_its_own_files() {
        let (_, hs) = sample();
        let (bytes, mime) = hs.read("Body/f_car_c.htm").unwrap();
        assert_eq!((bytes.as_slice(), mime), (&b"<html>car</html>"[..], "text/html; charset=iso-8859-1"));
        assert!(hs.read("../Data/Map_Sym.txt").is_none());
        assert!(hs.read("/etc/passwd").is_none(), "an absolute path stays inside the HyperSpec");
    }
}
