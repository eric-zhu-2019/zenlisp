;;;; A stand-in for Coalton's interface: operators marked as Coalton marks
;;;; them, which signal outside Coalton as Coalton's do.

(defpackage #:coalton-impl/source
  (:use #:cl)
  (:export #:source-error #:source-warning #:notes #:location #:location-source #:location-span
           #:source-file-path #:span-start #:note-type #:message #:extract-source-text #:docstring))

(defpackage #:coalton
  (:use)
  (:export #:coalton-toplevel #:coalton #:define #:match #:describe-type-of
           #:lookup-type #:lookup-class #:kind-of #:shape))

(defmacro coalton:define (&rest forms)
  (declare (ignore forms))
  (error "The operator DEFINE is only valid in a Coalton toplevel."))
(setf (get 'coalton:define :coalton-repl-context) :toplevel)

(defmacro coalton:match (&rest forms)
  (declare (ignore forms))
  (error "The operator MATCH is only valid in a Coalton expression."))
(setf (get 'coalton:match :coalton-repl-context) :expression)

(in-package #:coalton-impl/source)

(defstruct source file-path text)
(defstruct location source span)
(defstruct note location (type :primary) (message "") (replace #'identity))
(defun span-start (span) (car span))
(defun replace-function (note) (note-replace note))
(defun message (note) (note-message note))
(defun extract-source-text (source span)
  (subseq (source-text source) (car span) (cdr span)))

(define-condition source-condition ()
  ((notes :initarg :notes :reader notes)))

(define-condition source-warning (source-condition warning) ()
  (:report "warn: Unused variable"))

(define-condition source-error (source-condition error) ()
  (:report (lambda (c s)
             (let ((location (note-location (first (notes c)))))
               (format s "error: Ambiguous predicate~%  --> ~a:~a"
                       (source-file-path (location-source location)) (span-start (location-span location)))))))

(defmethod location ((note note)) (note-location note))

(defgeneric docstring (entry))

(in-package #:cl-user)

(defvar cl-user::*compiled* nil)

(defun warned (forms)
  "As Coalton warns of an unused variable, with help to prefix it with _: here the variable in (UNUSED NAME) in FORMS."
  (let* ((file *compile-file-truename*)
         (text (and file (uiop:read-file-string file)))
         (at (and text (search "(unused " text))))
    (when (and at (search "(UNUSED" (prin1-to-string forms)))
      (let* ((start (+ at (length "(unused ")))
             (location (coalton-impl/source::make-location
                        :source (coalton-impl/source::make-source
                                 :file-path (or (getf sb-c::*source-plist* :emacs-buffer) file) :text text)
                        :span (cons start (position #\) text :start start)))))
        (warn 'coalton-impl/source:source-warning
              :notes (list (coalton-impl/source::make-note :location location :message "variable defined here")
                           (coalton-impl/source::make-note :location location :type :help
                                                            :message "prefix the variable with '_' to declare it unused"
                                                            :replace (lambda (name) (concatenate 'string "_" name)))))))))

(defun blamed (forms)
  "Where Coalton would blame a call to BAD in FORMS: in the file being compiled, when there is one."
  (warned forms)
  (when (search "(BAD" (prin1-to-string forms))
    (let* ((file *compile-file-truename*)
           (text (and file (uiop:read-file-string file))))
      (error 'coalton-impl/source:source-error
             :notes (list (coalton-impl/source::make-note
                           :location (coalton-impl/source::make-location
                                      :source (coalton-impl/source::make-source
                                               ;; As Coalton names it: by the editor buffer, when compiling one.
                                               :file-path (or (getf sb-c::*source-plist* :emacs-buffer) file "<macroexpansion>"))
                                      :span (let ((at (if text (search "(bad" text) 0))) (cons at (+ at 7))))))))))

(defmacro coalton:coalton-toplevel (&body forms)
  (blamed forms)
  `(progn (setf cl-user::*compiled* ',forms) :toplevel))

(defmacro coalton:coalton (form)
  `(list :expression ',form))

(defun cl-user::add2 (x) (+ x 2))

;; As Coalton compiles a function with a constraint: its instance is the first argument.
(defun cl-user::scale (num x) (declare (ignore num)) (* x 2))

(defun coalton:describe-type-of (symbol)
  (case symbol
    (cl-user::add2 (format t "(INTEGER → INTEGER)~%"))
    (cl-user::scale (format t "∀ :A. NUM :A ⇒ :A → :A~%"))
    (cl-user::box-of (format t "∀ :A. :A → BOX :A~%"))
    (cl-user::area (format t "∀ :A. SHAPE :A ⇒ :A → DOUBLE-FLOAT~%"))
    (t (write-line "unknown")))
  (values))

;;; Coalton's environment: a type BOX with the constructor BOX-OF, and a class SHAPE, exported as Coalton's are, with the method AREA.

(defpackage #:coalton-impl/typechecker
  (:use #:cl)
  (:export #:type-entry-constructors #:ty-class-predicate #:ty-class-superclasses
           #:ty-class-unqualified-methods #:ty-class-method-name))

(in-package #:coalton-impl/typechecker)

(defstruct (printed (:constructor printed (text))) text)
(defmethod print-object ((p printed) stream) (write-string (printed-text p) stream))
(defstruct type-entry constructors docstring)
(defstruct ty-class predicate superclasses unqualified-methods docstring)
(defstruct ty-class-method name)
(defmethod coalton-impl/source:docstring ((e type-entry)) (type-entry-docstring e))
(defmethod coalton-impl/source:docstring ((e ty-class)) (ty-class-docstring e))

(defun coalton:lookup-type (name)
  (when (eq name 'cl-user::box)
    (make-type-entry :constructors '(cl-user::box-of) :docstring "A box holding one value.")))

(defun coalton:lookup-class (name)
  (when (eq name 'coalton:shape)
    (make-ty-class :predicate (printed "SHAPE :A") :superclasses nil
                   :unqualified-methods (list (make-ty-class-method :name 'cl-user::area))
                   :docstring "Things with an area.")))

(defun coalton:kind-of (name)
  (when (eq name 'cl-user::box) (printed "* → *")))

(in-package #:cl-user)

;;; Coalton's compiler for .coal files: a package form, then definitions.
;;; Here (define name value) defines a variable, and a call to BAD is an error.

(defpackage #:coalton-impl/entry
  (:use #:cl)
  (:shadow #:compile)
  (:export #:compile))

(defun coalton-impl/source::make-source-file (file)
  (coalton-impl/source::make-source :file-path (namestring file)))

(defun coalton-impl/entry:compile (source &key (load t) output-file)
  (let* ((file (coalton-impl/source::source-file-path source))
         (text (uiop:read-file-string file))
         (bad (search "(bad" text)))
    (when bad
      (error 'coalton-impl/source:source-error
             :notes (list (coalton-impl/source::make-note
                           :location (coalton-impl/source::make-location
                                      :source source :span (cons bad (+ bad 7)))))))
    (let ((forms (with-input-from-string (s text)
                   (let ((*package* (make-package (gensym "COAL-READ") :use '())))
                     (loop for form = (read s nil s) until (eq form s) collect form))))
          (lisp (uiop:tmpize-pathname (merge-pathnames "coal.lisp" (uiop:temporary-directory)))))
      (with-open-file (out lisp :direction :output :if-exists :supersede)
        (let ((name (symbol-name (second (first forms)))))
          (format out "(defpackage ~s (:use #:cl))~%(in-package ~s)~%" name name)
          (dolist (form (rest forms))
            (format out "(defparameter ~a ~s)~%" (symbol-name (second form)) (third form)))))
      (cl:compile-file lisp :output-file output-file)
      (when load (load output-file))
      output-file)))
