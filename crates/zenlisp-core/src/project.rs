use crate::sexp::Sexp;
use serde::Serialize;
use std::path::{Path, PathBuf};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum DepManager {
    /// A project-local Quicklisp from `qlot install`.
    #[serde(rename_all = "camelCase")]
    Qlot { setup: String, installed: bool },
    /// ocicl's runtime fetches missing systems into `ocicl/` on load.
    #[serde(rename_all = "camelCase")]
    Ocicl { runtime: String },
    /// Dependency source trees checked into the project.
    #[serde(rename_all = "camelCase")]
    Vendor { dirs: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Quicklisp { setup: String },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub root: String,
    pub name: String,
    pub managers: Vec<DepManager>,
}

const VENDOR_DIRS: [&str; 4] = ["vendor", "lib", "third_party", "deps"];

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

pub fn quicklisp_setup() -> Option<PathBuf> {
    let h = home();
    [h.join("quicklisp/setup.lisp"), h.join(".quicklisp/setup.lisp"), h.join(".roswell/lisp/quicklisp/setup.lisp")]
        .into_iter()
        .find(|p| p.is_file())
}

pub fn ocicl_runtime() -> Option<PathBuf> {
    let p = home().join(".local/share/ocicl/ocicl-runtime.lisp");
    p.is_file().then_some(p)
}

fn has_asd(dir: &Path) -> bool {
    walk_has_asd(dir, 3)
}

fn walk_has_asd(dir: &Path, depth: usize) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.filter_map(Result::ok).any(|e| {
        let p = e.path();
        if p.is_dir() {
            depth > 0 && walk_has_asd(&p, depth - 1)
        } else {
            p.extension().is_some_and(|x| x == "asd")
        }
    })
}

impl Project {
    pub fn detect(root: &Path) -> Project {
        let mut managers = Vec::new();
        if root.join("qlfile").is_file() {
            let setup = root.join(".qlot/setup.lisp");
            managers.push(DepManager::Qlot { installed: setup.is_file(), setup: setup.display().to_string() });
        }
        if root.join("ocicl.csv").is_file() || root.join("ocicl").is_dir() {
            if let Some(runtime) = ocicl_runtime() {
                managers.push(DepManager::Ocicl { runtime: runtime.display().to_string() });
            }
        }
        let vendor: Vec<String> = VENDOR_DIRS
            .iter()
            .map(|d| root.join(d))
            .filter(|d| d.is_dir() && has_asd(d))
            .map(|d| d.display().to_string())
            .collect();
        if !vendor.is_empty() {
            managers.push(DepManager::Vendor { dirs: vendor });
        }
        // qlot ships its own Quicklisp, so the global one would shadow it.
        let has_qlot = managers.iter().any(|m| matches!(m, DepManager::Qlot { .. }));
        if !has_qlot {
            if let Some(setup) = quicklisp_setup() {
                managers.push(DepManager::Quicklisp { setup: setup.display().to_string() });
            }
        }
        Project {
            root: root.display().to_string(),
            name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            managers,
        }
    }

    /// Plain ASDF forms that prepare an image for this project, in load order.
    pub fn setup_forms(&self) -> Vec<Sexp> {
        let load = |path: &str| Sexp::list([Sexp::sym("cl:load"), Sexp::str(path)]);
        let dir = |path: &str| Sexp::list([Sexp::sym("uiop:ensure-directory-pathname"), Sexp::str(path)]);
        let tree = |path: &str| Sexp::list([Sexp::sym("cl:list"), Sexp::kw("tree"), dir(path)]);
        let mut forms = vec![Sexp::list([Sexp::sym("cl:require"), Sexp::kw("asdf")])];
        let mut trees = vec![tree(&self.root)];
        for m in &self.managers {
            match m {
                DepManager::Qlot { setup, installed: true } | DepManager::Quicklisp { setup } => forms.push(load(setup)),
                DepManager::Qlot { installed: false, .. } => {}
                DepManager::Ocicl { runtime } => forms.push(load(runtime)),
                DepManager::Vendor { dirs } => trees.extend(dirs.iter().map(|d| tree(d))),
            }
        }
        forms.push(Sexp::list([Sexp::sym("uiop:chdir"), dir(&self.root)]));
        forms.push(Sexp::list([Sexp::sym("cl:setf"), Sexp::sym("cl:*default-pathname-defaults*"), dir(&self.root)]));
        let mut registry = vec![Sexp::sym("cl:list"), Sexp::kw("source-registry")];
        registry.extend(trees);
        registry.push(Sexp::kw("inherit-configuration"));
        forms.push(Sexp::list([Sexp::sym("asdf:initialize-source-registry"), Sexp::List(registry)]));
        forms
    }

    /// `sbcl` arguments that build SYSTEM's executable with `asdf:make`.
    pub fn build_args(&self, system: &str) -> Vec<String> {
        let mut args = vec!["--noinform".to_string(), "--non-interactive".into(), "--no-userinit".into()];
        for f in self.setup_forms() {
            args.push("--eval".into());
            args.push(f.to_string());
        }
        args.push("--eval".into());
        args.push(Sexp::list([Sexp::sym("asdf:make"), Sexp::str(system)]).to_string());
        args
    }

    /// The shell command that installs declared dependencies, when the
    /// project's manager has one.
    pub fn install_command(&self) -> Option<Vec<String>> {
        self.managers.iter().find_map(|m| match m {
            DepManager::Qlot { .. } => Some(vec!["qlot".into(), "install".into()]),
            DepManager::Ocicl { .. } if Path::new(&self.root).join("ocicl.csv").is_file() => {
                Some(vec!["ocicl".into(), "install".into()])
            }
            _ => None,
        })
    }

    /// The shell command that updates dependencies to their latest releases,
    /// for managers run as programs. Quicklisp updates from inside the image.
    pub fn update_command(&self) -> Option<Vec<String>> {
        self.managers.iter().find_map(|m| match m {
            DepManager::Qlot { .. } => Some(vec!["qlot".into(), "update".into()]),
            DepManager::Ocicl { .. } => Some(vec!["ocicl".into(), "latest".into()]),
            _ => None,
        })
    }

    /// The shell command that fetches a newly declared dependency.
    pub fn fetch_command(&self, system: &str) -> Option<Vec<String>> {
        self.managers.iter().find_map(|m| match m {
            DepManager::Qlot { .. } => Some(vec!["qlot".into(), "install".into()]),
            DepManager::Ocicl { .. } => Some(vec!["ocicl".into(), "install".into(), system.into()]),
            _ => None,
        })
    }
}

/// Creates a new ASDF project with a package, a main file and a test system.
pub fn create(parent: &Path, name: &str) -> std::io::Result<PathBuf> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(std::io::Error::other("project names use lowercase letters, digits and dashes"));
    }
    let root = parent.join(name);
    if root.exists() {
        return Err(std::io::Error::other(format!("{} already exists", root.display())));
    }
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(root.join("tests"))?;
    let files = [
        (
            format!("{name}.asd"),
            format!(
                r#"(defsystem "{name}"
  :description "{name}"
  :version "0.1.0"
  :depends-on ()
  :components ((:module "src"
                :components ((:file "package")
                             (:file "main" :depends-on ("package")))))
  :in-order-to ((test-op (test-op "{name}/tests")))
  :build-operation "program-op"
  :build-pathname "bin/{name}"
  :entry-point "{name}:main")

(defsystem "{name}/tests"
  :depends-on ("{name}")
  :components ((:module "tests" :components ((:file "main"))))
  :perform (test-op (op c) (symbol-call :{name}/tests :run)))
"#
            ),
        ),
        (
            "src/package.lisp".into(),
            format!("(defpackage #:{name}\n  (:use #:cl)\n  (:export #:main #:greet))\n"),
        ),
        (
            "src/main.lisp".into(),
            format!(
                r#"(in-package #:{name})

(defun greet (name)
  (format nil "Hello, ~a!" name))

(defun main ()
  (write-line (greet "world")))
"#
            ),
        ),
        (
            "tests/main.lisp".into(),
            format!(
                r#"(defpackage #:{name}/tests
  (:use #:cl)
  (:export #:run))

(in-package #:{name}/tests)

(defun run ()
  (assert (string= ({name}:greet "Lisp") "Hello, Lisp!"))
  (format t "~&All tests passed.~%")
  t)
"#
            ),
        ),
        (".gitignore".into(), "*.fasl\nbin/\n.qlot/\n".into()),
    ];
    for (path, body) in files {
        std::fs::write(root.join(path), body)?;
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zenlisp-project-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_vendor_and_qlot() {
        let root = tmp("detect");
        std::fs::create_dir_all(root.join("vendor/dep")).unwrap();
        std::fs::write(root.join("vendor/dep/dep.asd"), "(defsystem \"dep\")").unwrap();
        std::fs::write(root.join("qlfile"), "ql alexandria :latest").unwrap();
        let p = Project::detect(&root);
        assert!(matches!(&p.managers[0], DepManager::Qlot { installed: false, .. }));
        assert!(matches!(&p.managers[1], DepManager::Vendor { dirs } if dirs.len() == 1));
        assert!(!p.managers.iter().any(|m| matches!(m, DepManager::Quicklisp { .. })), "qlot replaces global quicklisp");
        assert_eq!(p.install_command(), Some(vec!["qlot".to_string(), "install".to_string()]));
    }

    #[test]
    fn setup_ends_with_project_registration() {
        let root = tmp("setup");
        let forms = Project::detect(&root).setup_forms();
        assert!(forms.last().unwrap().to_string().starts_with("(asdf:initialize-source-registry"));
    }

    #[test]
    fn creates_projects_and_rejects_bad_names() {
        let parent = tmp("create");
        let root = create(&parent, "hello-zen").unwrap();
        assert!(root.join("hello-zen.asd").is_file());
        assert!(create(&parent, "hello-zen").is_err());
        assert!(create(&parent, "Bad Name").is_err());
    }
}
