use std::fmt;

/// The subset of Lisp data that crosses the Swank wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Sexp {
    Nil,
    Int(i64),
    /// Floats, ratios and bignums, kept as printed text.
    Num(String),
    Str(String),
    Sym(String),
    Kw(String),
    List(Vec<Sexp>),
    Dotted(Vec<Sexp>, Box<Sexp>),
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ParseError {
    #[error("unexpected end of input")]
    Eof,
    #[error("unexpected '{0}' at byte {1}")]
    Unexpected(char, usize),
    #[error("trailing input at byte {0}")]
    Trailing(usize),
}

impl Sexp {
    pub fn sym(s: &str) -> Sexp {
        Sexp::Sym(s.to_string())
    }
    pub fn kw(s: &str) -> Sexp {
        Sexp::Kw(s.to_string())
    }
    pub fn str(s: &str) -> Sexp {
        Sexp::Str(s.to_string())
    }
    pub fn list(items: impl IntoIterator<Item = Sexp>) -> Sexp {
        Sexp::List(items.into_iter().collect())
    }
    pub fn t() -> Sexp {
        Sexp::sym("t")
    }
    pub fn bool(b: bool) -> Sexp {
        if b { Sexp::t() } else { Sexp::Nil }
    }

    pub fn is_nil(&self) -> bool {
        matches!(self, Sexp::Nil) || matches!(self, Sexp::List(v) if v.is_empty())
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Sexp::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Sexp::Int(i) => Some(*i),
            _ => None,
        }
    }
    pub fn is_kw(&self, name: &str) -> bool {
        matches!(self, Sexp::Kw(k) if k.eq_ignore_ascii_case(name))
    }
    /// Elements of a proper list. `nil` is the empty list.
    pub fn items(&self) -> &[Sexp] {
        match self {
            Sexp::List(v) => v,
            _ => &[],
        }
    }
    /// Looks up `key` in a keyword property list such as `(:a 1 :b 2)`.
    pub fn plist_get(&self, key: &str) -> Option<&Sexp> {
        self.items()
            .chunks(2)
            .find(|pair| pair[0].is_kw(key))
            .and_then(|pair| pair.get(1))
    }

    pub fn parse(input: &str) -> Result<Sexp, ParseError> {
        let mut p = Parser { src: input, pos: 0 };
        let v = p.read()?;
        p.skip_ws();
        if p.pos != input.len() {
            return Err(ParseError::Trailing(p.pos));
        }
        Ok(v)
    }
}

impl fmt::Display for Sexp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Sexp::Nil => f.write_str("nil"),
            Sexp::Int(i) => write!(f, "{i}"),
            Sexp::Num(n) | Sexp::Sym(n) => f.write_str(n),
            Sexp::Kw(k) => write!(f, ":{k}"),
            Sexp::Str(s) => {
                f.write_str("\"")?;
                for c in s.chars() {
                    if c == '"' || c == '\\' {
                        f.write_str("\\")?;
                    }
                    write!(f, "{c}")?;
                }
                f.write_str("\"")
            }
            Sexp::List(v) => {
                f.write_str("(")?;
                for (i, x) in v.iter().enumerate() {
                    if i > 0 {
                        f.write_str(" ")?;
                    }
                    write!(f, "{x}")?;
                }
                f.write_str(")")
            }
            Sexp::Dotted(v, tail) => {
                f.write_str("(")?;
                for x in v {
                    write!(f, "{x} ")?;
                }
                write!(f, ". {tail})")
            }
        }
    }
}

struct Parser<'a> {
    src: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.bump();
            } else if c == ';' {
                while let Some(c) = self.bump() {
                    if c == '\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }

    fn read(&mut self) -> Result<Sexp, ParseError> {
        self.skip_ws();
        match self.peek().ok_or(ParseError::Eof)? {
            '(' => {
                self.bump();
                self.read_list()
            }
            ')' => Err(ParseError::Unexpected(')', self.pos)),
            '"' => {
                self.bump();
                self.read_string()
            }
            '\'' => {
                self.bump();
                Ok(Sexp::list([Sexp::sym("quote"), self.read()?]))
            }
            _ => self.read_atom(),
        }
    }

    fn read_list(&mut self) -> Result<Sexp, ParseError> {
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            match self.peek().ok_or(ParseError::Eof)? {
                ')' => {
                    self.bump();
                    return Ok(if items.is_empty() { Sexp::Nil } else { Sexp::List(items) });
                }
                '.' if self.is_lone_dot() => {
                    self.bump();
                    let tail = self.read()?;
                    self.skip_ws();
                    return match self.bump() {
                        Some(')') => Ok(Sexp::Dotted(items, Box::new(tail))),
                        Some(c) => Err(ParseError::Unexpected(c, self.pos - c.len_utf8())),
                        None => Err(ParseError::Eof),
                    };
                }
                _ => items.push(self.read()?),
            }
        }
    }

    fn is_lone_dot(&self) -> bool {
        let next = self.src[self.pos + 1..].chars().next();
        next.is_none_or(|c| c.is_whitespace() || c == '(' || c == ')')
    }

    fn read_string(&mut self) -> Result<Sexp, ParseError> {
        let mut out = String::new();
        loop {
            match self.bump().ok_or(ParseError::Eof)? {
                '"' => return Ok(Sexp::Str(out)),
                '\\' => out.push(self.bump().ok_or(ParseError::Eof)?),
                c => out.push(c),
            }
        }
    }

    fn read_atom(&mut self) -> Result<Sexp, ParseError> {
        let mut tok = String::new();
        while let Some(c) = self.peek() {
            match c {
                '(' | ')' | '"' | '\'' | ';' => break,
                c if c.is_whitespace() => break,
                '|' => {
                    self.bump();
                    tok.push('|');
                    while let Some(c) = self.bump() {
                        tok.push(c);
                        if c == '|' {
                            break;
                        }
                    }
                }
                '\\' => {
                    tok.push(self.bump().unwrap());
                    tok.extend(self.bump());
                }
                _ => tok.push(self.bump().unwrap()),
            }
        }
        if tok.is_empty() {
            return Err(ParseError::Unexpected(self.peek().unwrap_or(' '), self.pos));
        }
        Ok(atom(tok))
    }
}

fn atom(tok: String) -> Sexp {
    if tok.eq_ignore_ascii_case("nil") {
        return Sexp::Nil;
    }
    if let Some(k) = tok.strip_prefix(':') {
        return Sexp::Kw(k.to_string());
    }
    if let Ok(i) = tok.parse::<i64>() {
        return Sexp::Int(i);
    }
    let numeric = tok.starts_with(|c: char| c.is_ascii_digit())
        || (tok.len() > 1
            && tok.starts_with(['-', '+', '.'])
            && tok[1..].starts_with(|c: char| c.is_ascii_digit()));
    if numeric {
        Sexp::Num(tok)
    } else {
        Sexp::Sym(tok)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_swank_messages() {
        let src = r#"(:return (:ok ("3" "3")) 1)"#;
        assert_eq!(Sexp::parse(src).unwrap().to_string(), src);
    }

    #[test]
    fn reads_atoms() {
        assert_eq!(Sexp::parse("nil").unwrap(), Sexp::Nil);
        assert_eq!(Sexp::parse("()").unwrap(), Sexp::Nil);
        assert_eq!(Sexp::parse("-42").unwrap(), Sexp::Int(-42));
        assert_eq!(Sexp::parse("1/3").unwrap(), Sexp::Num("1/3".into()));
        assert_eq!(Sexp::parse("1.5d0").unwrap(), Sexp::Num("1.5d0".into()));
        assert_eq!(Sexp::parse("swank:foo").unwrap(), Sexp::sym("swank:foo"));
        assert_eq!(Sexp::parse("|a b|").unwrap(), Sexp::sym("|a b|"));
        assert_eq!(Sexp::parse("-").unwrap(), Sexp::sym("-"));
    }

    #[test]
    fn escapes_strings_both_ways() {
        let s = Sexp::str("say \"hi\" \\ λ");
        assert_eq!(s.to_string(), r#""say \"hi\" \\ λ""#);
        assert_eq!(Sexp::parse(&s.to_string()).unwrap(), s);
    }

    #[test]
    fn reads_dotted_pairs() {
        let v = Sexp::parse("(a . 1)").unwrap();
        assert_eq!(v, Sexp::Dotted(vec![Sexp::sym("a")], Box::new(Sexp::Int(1))));
        assert_eq!(v.to_string(), "(a . 1)");
        assert_eq!(Sexp::parse("(.5)").unwrap(), Sexp::list([Sexp::Num(".5".into())]));
    }

    #[test]
    fn plist_lookup() {
        let v = Sexp::parse("(:title \"x\" :id 3)").unwrap();
        assert_eq!(v.plist_get("id"), Some(&Sexp::Int(3)));
        assert_eq!(v.plist_get("missing"), None);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(Sexp::parse("(a"), Err(ParseError::Eof));
        assert_eq!(Sexp::parse("a b"), Err(ParseError::Trailing(2)));
    }
}
