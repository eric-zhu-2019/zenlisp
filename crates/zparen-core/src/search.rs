//! Find and replace across a project, with ripgrep's libraries: the same
//! .gitignore handling and regex engine as `rg`.

use grep_matcher::{Captures, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Query {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// Character columns of each match in `text`, end exclusive.
    pub spans: Vec<(usize, usize)>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileMatches {
    pub path: String,
    pub lines: Vec<LineMatch>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub matches: usize,
    /// The search stopped at `MAX_MATCHES`.
    pub truncated: bool,
}

pub const MAX_MATCHES: usize = 5000;

fn matcher(q: &Query) -> Result<RegexMatcher, String> {
    let pattern = if q.regex { q.pattern.clone() } else { regex_syntax_escape(&q.pattern) };
    RegexMatcherBuilder::new()
        .case_insensitive(!q.case_sensitive)
        .word(q.whole_word)
        .build(&pattern)
        .map_err(|e| e.to_string())
}

fn regex_syntax_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn byte_to_char(text: &str, byte: usize) -> usize {
    text[..byte.min(text.len())].chars().count()
}

fn walker(root: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(true)
        .filter_entry(|e| !crate::files::ignored(e.path()))
        .build()
}

pub fn search(root: &Path, q: &Query) -> Result<SearchResult, String> {
    if q.pattern.is_empty() {
        return Ok(SearchResult { files: vec![], matches: 0, truncated: false });
    }
    let m = matcher(q)?;
    let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(b'\0')).line_number(true).build();
    let mut result = SearchResult { files: vec![], matches: 0, truncated: false };
    for entry in walker(root).filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let mut lines = Vec::new();
        let _ = searcher.search_path(
            &m,
            entry.path(),
            UTF8(|line, text| {
                let text = text.trim_end_matches(['\n', '\r']);
                let mut spans = Vec::new();
                let _ = m.find_iter(text.as_bytes(), |hit| {
                    spans.push((byte_to_char(text, hit.start()), byte_to_char(text, hit.end())));
                    true
                });
                result.matches += spans.len().max(1);
                lines.push(LineMatch { line, text: text.to_string(), spans });
                Ok(result.matches < MAX_MATCHES)
            }),
        );
        if !lines.is_empty() {
            result.files.push(FileMatches { path: entry.path().display().to_string(), lines });
        }
        if result.matches >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
    }
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

/// Replaces every match in `paths`, which must be files `search` returned.
/// Returns the number of replacements. `replacement` may use $1 for regex groups.
pub fn replace(paths: &[String], q: &Query, replacement: &str) -> Result<usize, String> {
    let m = matcher(q)?;
    let mut count = 0;
    for path in paths {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        let mut out = Vec::with_capacity(text.len());
        let mut caps = m.new_captures().map_err(|e| e.to_string())?;
        let mut n = 0;
        m.replace_with_captures(text.as_bytes(), &mut caps, &mut out, |caps, dst| {
            n += 1;
            if q.regex {
                caps.interpolate(|name| m.capture_index(name), text.as_bytes(), replacement.as_bytes(), dst);
            } else {
                dst.extend_from_slice(replacement.as_bytes());
            }
            true
        })
        .map_err(|e| e.to_string())?;
        if n > 0 {
            std::fs::write(path, out).map_err(|e| format!("{path}: {e}"))?;
            count += n;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("zparen-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join("src/a.lisp"), "(defun greet (name)\n  (format nil \"Hi ~a\" name))\n(greet \"λ\")\n").unwrap();
        std::fs::write(d.join("src/b.lisp"), "(defun greeting () :hello)\n").unwrap();
        std::fs::write(d.join("src/a.fasl"), "greet").unwrap();
        std::fs::write(d.join(".git/HEAD"), "greet").unwrap();
        d
    }

    fn q(pattern: &str) -> Query {
        Query { pattern: pattern.into(), regex: false, case_sensitive: false, whole_word: false }
    }

    #[test]
    fn finds_matches_with_columns_and_skips_build_noise() {
        let d = project("find");
        let r = search(&d, &q("greet")).unwrap();
        assert_eq!(r.files.len(), 2, "{r:?}");
        let a = &r.files[0];
        assert!(a.path.ends_with("src/a.lisp"));
        assert_eq!(a.lines[0].line, 1);
        assert_eq!(a.lines[0].spans, vec![(7, 12)]);
        assert_eq!(r.matches, 3);
    }

    #[test]
    fn whole_word_regex_and_case() {
        let d = project("modes");
        assert_eq!(search(&d, &Query { whole_word: true, ..q("greet") }).unwrap().matches, 2);
        assert_eq!(search(&d, &Query { regex: true, ..q(r"\(defun \w+") }).unwrap().matches, 2);
        assert_eq!(search(&d, &Query { case_sensitive: true, ..q("GREET") }).unwrap().matches, 0);
        assert!(search(&d, &Query { regex: true, ..q("(") }).is_err(), "bad regex is an error, not a crash");
        assert_eq!(search(&d, &q("(greet \"λ\")")).unwrap().files[0].lines[0].spans, vec![(0, 11)]);
    }

    #[test]
    fn replaces_in_the_matched_files() {
        let d = project("replace");
        let query = Query { regex: true, whole_word: true, ..q("gre(et)") };
        let r = search(&d, &query).unwrap();
        let paths: Vec<String> = r.files.iter().map(|f| f.path.clone()).collect();
        assert_eq!(replace(&paths, &query, "salut$1").unwrap(), 2);
        let a = std::fs::read_to_string(d.join("src/a.lisp")).unwrap();
        assert!(a.starts_with("(defun salutet (name)"), "{a}");
        assert!(std::fs::read_to_string(d.join("src/b.lisp")).unwrap().contains("greeting"), "whole word left greeting alone");
    }
}
