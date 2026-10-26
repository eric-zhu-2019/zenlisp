;;;; Builds the ZenLisp SBCL core: Swank, its contribs and the zenlisp
;;;; helpers preloaded. Run with --non-interactive --no-userinit.
;;;; Env: ZENLISP_SWANK_DIR, ZENLISP_LISP_DIR, ZENLISP_FASL_DIR, ZENLISP_CORE_OUT.

(require :asdf)
(require :sb-introspect)
(require :sb-posix)

(defun env-dir (name) (pathname (sb-ext:posix-getenv name)))

(load (merge-pathnames "swank-loader.lisp" (env-dir "ZENLISP_SWANK_DIR")))
(setf (symbol-value (find-symbol "*FASL-DIRECTORY*" "SWANK-LOADER")) (env-dir "ZENLISP_FASL_DIR"))
(funcall (find-symbol "INIT" "SWANK-LOADER") :load-contribs nil :setup t :quiet t)
(funcall (find-symbol "SWANK-REQUIRE" "SWANK")
         '(:swank-repl :swank-fuzzy :swank-arglists :swank-c-p-c
           :swank-fancy-inspector :swank-presentations :swank-asdf
           :swank-package-fu :swank-macrostep :swank-trace-dialog :swank-mrepl))
(require :sb-sprof)
(load (merge-pathnames "zenlisp.lisp" (env-dir "ZENLISP_LISP_DIR")))
(load (merge-pathnames "breakpoints.lisp" (env-dir "ZENLISP_LISP_DIR")))
(load (merge-pathnames "tools.lisp" (env-dir "ZENLISP_LISP_DIR")))
(load (merge-pathnames "tests.lisp" (env-dir "ZENLISP_LISP_DIR")))
(load (merge-pathnames "plugins.lisp" (env-dir "ZENLISP_LISP_DIR")))

(sb-ext:save-lisp-and-die (sb-ext:posix-getenv "ZENLISP_CORE_OUT"))
