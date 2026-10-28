;;;; A stand-in for Coalton's interface: operators marked as Coalton marks
;;;; them, which signal outside Coalton as Coalton's do.

(defpackage #:coalton
  (:use)
  (:export #:coalton-toplevel #:coalton #:define #:match #:describe-type-of))

(defmacro coalton:define (&rest forms)
  (declare (ignore forms))
  (error "The operator DEFINE is only valid in a Coalton toplevel."))
(setf (get 'coalton:define :coalton-repl-context) :toplevel)

(defmacro coalton:match (&rest forms)
  (declare (ignore forms))
  (error "The operator MATCH is only valid in a Coalton expression."))
(setf (get 'coalton:match :coalton-repl-context) :expression)

(defvar cl-user::*compiled* nil)

(defmacro coalton:coalton-toplevel (&body forms)
  `(progn (setf cl-user::*compiled* ',forms) :toplevel))

(defmacro coalton:coalton (form)
  `(list :expression ',form))

(defun cl-user::add2 (x) (+ x 2))

(defun coalton:describe-type-of (symbol)
  (if (eq symbol 'cl-user::add2)
      (format t "(INTEGER → INTEGER)~%")
      (write-line "unknown"))
  (values))
