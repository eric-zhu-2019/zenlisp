//! What git knows about the project's files: their text at HEAD, for change
//! markers and diffs, and their status, for the file tree. It runs the `git`
//! program, so it works with any repository git itself can read.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GitState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitFile {
    pub path: String,
    pub state: GitState,
}

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// The repository's top directory, when `dir` is inside one.
pub fn toplevel(dir: &Path) -> Option<PathBuf> {
    let out = git(dir, &["rev-parse", "--show-toplevel"])?;
    Some(PathBuf::from(String::from_utf8(out).ok()?.trim_end()))
}

/// The file's text in the last commit; None when it is untracked or outside a repository.
pub fn head_text(path: &Path) -> Option<String> {
    let dir = path.parent()?;
    let name = path.file_name()?.to_str()?;
    let out = git(dir, &["show", &format!("HEAD:./{name}")])?;
    String::from_utf8(out).ok()
}

/// Changed and untracked files under `dir`, with absolute paths.
pub fn status(dir: &Path) -> Vec<GitFile> {
    let (Some(top), Some(out)) = (toplevel(dir), git(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    let mut entries = out.split(|b| *b == 0).filter(|e| e.len() > 3);
    while let Some(e) = entries.next() {
        let (x, y) = (e[0], e[1]);
        let path = String::from_utf8_lossy(&e[3..]).into_owned();
        let state = match (x, y) {
            (b'?', b'?') => GitState::Untracked,
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => GitState::Conflicted,
            (b'R', _) => {
                // A rename names its old path in the next entry.
                entries.next();
                GitState::Renamed
            }
            (b'A', _) => GitState::Added,
            (b'D', _) | (_, b'D') => GitState::Deleted,
            _ => GitState::Modified,
        };
        files.push(GitFile { path: top.join(path).display().to_string(), state });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zenlisp-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success(), "{args:?}");
        run(&["init", "-q"]);
        std::fs::write(dir.join("src/a.lisp"), "(a)\n").unwrap();
        std::fs::write(dir.join("gone.lisp"), "(g)\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]);
        dir.canonicalize().unwrap()
    }

    #[test]
    fn reads_committed_text_and_reports_status() {
        let dir = repo();
        std::fs::write(dir.join("src/a.lisp"), "(a b)\n").unwrap();
        std::fs::write(dir.join("src/new.lisp"), "(n)\n").unwrap();
        std::fs::remove_file(dir.join("gone.lisp")).unwrap();
        assert_eq!(head_text(&dir.join("src/a.lisp")).as_deref(), Some("(a)\n"), "the committed text, not the edit");
        assert_eq!(head_text(&dir.join("src/new.lisp")), None);
        let mut st = status(&dir.join("src"));
        st.sort_by(|a, b| a.path.cmp(&b.path));
        let short: Vec<_> = st.iter().map(|f| (f.path.strip_prefix(&dir.display().to_string()).unwrap().to_string(), f.state)).collect();
        assert_eq!(
            short,
            [
                ("/gone.lisp".to_string(), GitState::Deleted),
                ("/src/a.lisp".to_string(), GitState::Modified),
                ("/src/new.lisp".to_string(), GitState::Untracked)
            ]
        );
    }

    #[test]
    fn outside_a_repository_there_is_nothing() {
        let dir = std::env::temp_dir().join(format!("zenlisp-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.lisp"), "x").unwrap();
        assert!(status(&dir).is_empty());
        assert_eq!(head_text(&dir.join("x.lisp")), None);
    }
}
