(defpackage #:demo
  (:use #:cl)
  (:local-nicknames (#:zp #:zenlisp-plugin)))
(in-package #:demo)

(zp:define-setting wrap-with :type :choice :choices ("time" "progn") :default "time" :title "Wrap with")

(zp:define-command wrap-form (context) (:title "Wrap form" :key "Mod-Alt-t")
  (let ((form (zp:context-form context)))
    (zp:replace-range (zp:form-start form) (zp:form-end form)
                      (format nil "(~a ~a)" (zp:setting 'wrap-with) (zp:form-text form)))))

(zp:define-check no-eval (file text)
  (let ((at (search "(eval " text)))
    (when at (list (zp:note at (+ at 5) "EVAL here")))))

(zp:add-hook :repl-input
             (lambda (input)
               (when (string= (string-trim " " input) ",hello")
                 (format t "hello from a plugin~%")
                 :handled)))

(defvar *compiled* nil)
(zp:add-hook :after-compile-file (lambda (path success) (push (list (file-namestring path) success) *compiled*)))
