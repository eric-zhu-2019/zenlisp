//! Project files on disk: changes made by other programs, and edits that
//! the file tree makes.

use notify::{RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

const IGNORED_DIRS: [&str; 5] = [".git", "node_modules", "target", ".qlot", ".DS_Store"];
/// Editors and git write several events per save; one batch per pause reads better.
const SETTLE: Duration = Duration::from_millis(150);

pub fn ignored(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "fasl")
        || path.components().any(|c| matches!(c, Component::Normal(n) if IGNORED_DIRS.iter().any(|d| n == *d)))
}

/// Watches `root` and calls `on_change` with each settled batch of changed
/// paths. Dropping the returned watcher stops it.
pub fn watch(root: &Path, on_change: impl Fn(Vec<String>) + Send + 'static) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(e) = event {
            for p in e.paths {
                let _ = tx.send(p);
            }
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = BTreeSet::from([first]);
            while let Ok(Some(p)) = tokio::time::timeout(SETTLE, rx.recv()).await {
                batch.insert(p);
            }
            let paths: Vec<String> = batch.into_iter().filter(|p| !ignored(p)).map(|p| p.display().to_string()).collect();
            if !paths.is_empty() {
                on_change(paths);
            }
        }
    });
    Ok(watcher)
}

pub fn create_file(path: &Path) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(path).map(|_| ())
}

pub fn create_dir(path: &Path) -> io::Result<()> {
    if path.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", path.display())));
    }
    std::fs::create_dir_all(path)
}

pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", to.display())));
    }
    std::fs::rename(from, to)
}

/// Moves `path` to the macOS Trash, so a deletion from the file tree can be undone.
/// NSFileManager rather than the default Finder script, which waits on an
/// Apple Events permission prompt.
pub fn trash(path: &Path) -> io::Result<()> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path).map_err(|e| io::Error::other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zenlisp-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn create_rename_and_refuse_to_overwrite() {
        let d = tmp("ops");
        create_file(&d.join("src/new.lisp")).unwrap();
        assert!(create_file(&d.join("src/new.lisp")).is_err(), "never overwrites");
        create_dir(&d.join("tests")).unwrap();
        create_file(&d.join("other.lisp")).unwrap();
        assert!(rename(&d.join("src/new.lisp"), &d.join("other.lisp")).is_err(), "never clobbers on rename");
        rename(&d.join("src/new.lisp"), &d.join("src/renamed.lisp")).unwrap();
        assert!(d.join("src/renamed.lisp").is_file());
    }

    #[test]
    fn ignores_build_noise() {
        assert!(ignored(Path::new("/p/src/a.fasl")));
        assert!(ignored(Path::new("/p/.git/index")));
        assert!(!ignored(Path::new("/p/src/a.lisp")));
    }

    #[tokio::test]
    async fn reports_changes_made_by_other_programs() {
        let d = tmp("watch");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _w = watch(&d, move |paths| {
            let _ = tx.send(paths);
        })
        .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        std::fs::write(d.join("a.lisp"), "(+ 1 2)").unwrap();
        std::fs::write(d.join("a.fasl"), "x").unwrap();
        let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event").unwrap();
        assert!(batch.iter().any(|p| p.ends_with("a.lisp")), "{batch:?}");
        assert!(!batch.iter().any(|p| p.ends_with(".fasl")), "{batch:?}");
    }
}
