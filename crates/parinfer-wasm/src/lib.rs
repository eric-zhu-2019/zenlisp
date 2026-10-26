#[macro_use]
extern crate serde_derive;

// Vendored verbatim from upstream; see VENDORED.md.
mod changes;
#[allow(mismatched_lifetime_syntaxes)]
pub mod parinfer;
#[allow(mismatched_lifetime_syntaxes)]
pub mod types;

use types::{Answer, Error, Request};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use wasm_bindgen::prelude::*;

/// Runs parinfer on a JSON `{mode, text, options}` request and returns the JSON answer,
/// the same contract as upstream's `run_parinfer`.
#[wasm_bindgen]
pub fn run_parinfer(request: &str) -> String {
    let answer = match serde_json::from_str::<Request>(request) {
        Ok(request) => serde_json::to_string(&parinfer::process(&request)),
        Err(e) => serde_json::to_string(&Answer::from(Error::from(e))),
    };
    answer.unwrap()
}

/// The column parinfer assigns to the end of `text`. Parinfer counts columns in display
/// width per grapheme and widens code tabs to two spaces, so callers convert editor
/// offsets through this rather than assuming one column per UTF-16 unit.
#[wasm_bindgen]
pub fn text_width(text: &str) -> usize {
    text.graphemes(true)
        .map(|g| if g == "\t" { 2 } else { UnicodeWidthStr::width(g) })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::ErrorName;
    use serde_json::{json, Value};

    fn smart(text: &str, options: Value) -> Value {
        let request = json!({ "mode": "smart", "text": text, "options": options });
        serde_json::from_str(&run_parinfer(&request.to_string())).unwrap()
    }

    fn lisp(extra: Value) -> Value {
        let mut options = json!({ "lispVlineSymbols": true, "lispBlockComments": true });
        options.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        options
    }

    #[test]
    fn closes_open_forms() {
        let answer = smart("(defun f (x", lisp(json!({ "cursorX": 11, "cursorLine": 0 })));
        assert_eq!(answer["text"], "(defun f (x))");
    }

    #[test]
    fn char_literal_paren_is_not_an_opener() {
        let answer = smart("(list #\\( x", lisp(json!({})));
        assert_eq!(answer["success"], true);
        assert_eq!(answer["text"], "(list #\\( x)");
    }

    #[test]
    fn vline_symbol_hides_parens() {
        let answer = smart("(list |sym(| x", lisp(json!({})));
        assert_eq!(answer["text"], "(list |sym(| x)");
    }

    #[test]
    fn block_comment_hides_parens() {
        let answer = smart("#| (( |#\n(foo", lisp(json!({})));
        assert_eq!(answer["text"], "#| (( |#\n(foo)");
    }

    #[test]
    fn unclosed_quote_reports_without_rewriting() {
        let answer = smart("(foo \"bar", lisp(json!({})));
        assert_eq!(answer["success"], false);
        assert_eq!(answer["error"]["name"], "unclosed-quote");
    }

    #[test]
    fn malformed_request_is_an_error_answer() {
        let answer: Value = serde_json::from_str(&run_parinfer("{")).unwrap();
        assert_eq!(answer["success"], false);
        assert_eq!(answer["error"]["name"], ErrorName::JsonEncodingError.to_string());
    }

    #[test]
    fn width_counts_wide_graphemes_and_tabs() {
        assert_eq!(text_width("(a"), 2);
        assert_eq!(text_width("\t"), 2);
        assert_eq!(text_width("漢"), 2);
        assert_eq!(text_width("e\u{301}"), 1);
    }
}
