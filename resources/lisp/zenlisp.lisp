(defpackage #:zenlisp
  (:use #:cl)
  (:export #:ping #:start-server #:project-systems
           #:load-system #:test-system #:run-system-tests #:rerun-tests))

(in-package #:zenlisp)

(defun start-server (&key (debug-code t))
  "Starts Swank on a free port and announces it as ZENLISP-PORT <n>."
  (sb-ext:enable-debugger)
  ;; Code compiled during development keeps its locals and can be single-stepped.
  ;; Debug 2 leaves step instrumentation off, and a merged tail call hides the
  ;; stepped frame, so it takes debug 3. Builds run in a separate process with
  ;; their own policy.
  (when debug-code
    (sb-ext:restrict-compiler-policy 'debug 3))
  (setf swank-repl::*globally-redirect-io* t)
  (swank::init-presentations)
  (let ((port (swank:create-server :port 0 :dont-close t :style :spawn)))
    (format t "~&ZENLISP-PORT ~D~%" port)
    (finish-output))
  ;; ZenLisp holds our stdin open. EOF means it is gone, so exit rather
  ;; than linger as an orphan. Swank rebinds *standard-input*, so read the fd.
  (loop while (read-char sb-sys:*stdin* nil nil))
  (sb-ext:exit :abort t))

(defun ping ()
  (list :lisp (lisp-implementation-type)
        :version (lisp-implementation-version)
        :pid (sb-posix:getpid)))

(defun asd-files (root)
  (let ((skip '("ocicl" ".qlot" "node_modules" ".git" "target")))
    (labels ((walk (dir)
               (append (uiop:directory-files dir "*.asd")
                       (loop for sub in (uiop:subdirectories dir)
                             unless (member (car (last (pathname-directory sub))) skip
                                            :test #'string=)
                               append (walk sub)))))
      (walk (uiop:ensure-directory-pathname root)))))

(defun system-info (system)
  (list :name (asdf:component-name system)
        :file (namestring (asdf:system-source-file system))
        :description (or (asdf:system-description system) "")
        :version (or (asdf:component-version system) "")
        :depends-on (mapcar (lambda (d) (princ-to-string (if (consp d) (car (last d)) d)))
                            (asdf:system-depends-on system))
        :loaded (and (asdf:component-loaded-p system) t)))

(defun project-systems (root)
  "Systems defined by the .asd files under ROOT, excluding dependency caches."
  (loop for asd in (asd-files root)
        do (handler-case (asdf:load-asd asd)
             (error (e) (format *error-output* "~&; could not load ~a: ~a~%" asd e)))
        append (loop for name in (asdf:registered-systems)
                     for system = (asdf:registered-system name)
                     when (and system (equal (asdf:system-source-file system) asd))
                       collect (system-info system))))

(defun load-system (name)
  "Loads NAME, fetching missing dependencies through Quicklisp when present."
  (let ((ql (find-package "QL")))
    (if ql
        (funcall (find-symbol "QUICKLOAD" ql) name)
        (asdf:load-system name))
    (system-info (asdf:find-system name))))

(defun end-thread (id)
  "Ends the thread Swank numbers ID, such as a closed REPL's listener."
  (let ((thread (swank/backend:find-thread id)))
    (when (and thread (swank/backend:thread-alive-p thread))
      (sb-thread:terminate-thread thread)
      t)))

(defun test-system (name)
  "Runs NAME's tests and summarizes them, naming each failing check."
  (let ((run (run-system-tests name)))
    (format nil "~d passed, ~d failed~@[, ~d skipped~]~{~%~a~}"
            (getf run :passed) (getf run :failed)
            (and (plusp (getf run :skipped)) (getf run :skipped))
            (failure-lines (getf run :tests)))))

(defun find-systems (query &optional (limit 60))
  "Systems whose names contain QUERY, as (NAME SOURCE INSTALLED): Quicklisp's
dists, then systems ASDF already knows."
  (let ((found '())
        (q (string-downcase query)))
    (let ((ql (find-package "QL")))
      (when ql
        (dolist (s (funcall (find-symbol "SYSTEM-APROPOS-LIST" ql) q))
          (let ((name (funcall (find-symbol "NAME" "QL-DIST") s)))
            (push (list name "quicklisp"
                        (and (funcall (find-symbol "INSTALLEDP" "QL-DIST") (funcall (find-symbol "RELEASE" "QL-DIST") s)) t))
                  found)))))
    (dolist (name (asdf:registered-systems))
      (when (and (search q (string-downcase name)) (not (find name found :key #'first :test #'string-equal)))
        (push (list name "local" t) found)))
    ;; Names that start with the query first, then the shortest.
    (let ((sorted (sort found (lambda (a b)
                                (let ((pa (eql 0 (search q (first a)))) (pb (eql 0 (search q (first b)))))
                                  (if (eq pa pb) (< (length (first a)) (length (first b))) pa))))))
      (subseq sorted 0 (min limit (length sorted))))))

(defun create-repl (remote)
  "Starts an extra REPL as swank-mrepl does, answering once its listener thread
runs. SBCL's thread ids are OS thread ids, which a thread has only once it has
started, and the REPL is closed and interrupted by its thread's id."
  (destructuring-bind (channel-id thread-id &rest more) (swank-mrepl:create-mrepl remote)
    (let ((thread (swank::channel-thread (swank::find-channel channel-id))))
      (loop repeat 1000
            while (eql thread-id 0)
            do (sleep 0.001)
               (setf thread-id (swank/backend:thread-id thread)))
      (list* channel-id thread-id more))))

(defvar *check-lock* (sb-thread:make-mutex :name "zenlisp check"))

;; A check must always answer: a compile-time error such as a DEFPACKAGE that
;; uses a missing package would otherwise stop the check thread in the
;; debugger, holding the lock every later check waits for.
(defun check-text (text)
  "Compiles TEXT as a file, without loading it, for the compiler's notes on code
as it is being written. The file is compiled whole, so it sees the functions
and macros it defines itself; positions in the notes are positions in TEXT.
Compiling evaluates what the file asks for at compile time, as any compile does.
An error at compile time becomes an error note, and the check goes on past it
when the error allows that, or stops there."
  (sb-thread:with-mutex (*check-lock*)
    (let* ((dir (uiop:ensure-directory-pathname
                 (merge-pathnames (format nil "zenlisp-check-~d/" (sb-posix:getpid)) (uiop:temporary-directory))))
           (file (merge-pathnames "buffer.lisp" dir))
           (stopped '()))
      (ensure-directories-exist dir)
      (with-open-file (s file :direction :output :if-exists :supersede :external-format :utf-8)
        (write-string text s))
      (let ((stand-ins (mapcar (lambda (name) (make-package name :use '("COMMON-LISP"))) (missing-packages text))))
        (unwind-protect
             (let ((*standard-output* (make-broadcast-stream))
                   (*error-output* (make-broadcast-stream)))
               (let ((result (handler-bind ((error (lambda (c)
                                                     (push (check-error-note c file text) stopped)
                                                     (let ((r (or (find-restart 'continue c) (find-restart 'abort c))))
                                                       (when r (invoke-restart r))))))
                               (swank:compile-file-for-emacs (namestring file) nil))))
                 (when stopped
                   (setf (swank::compilation-result-notes result)
                         (append (swank::compilation-result-notes result) (reverse stopped))
                         (swank::compilation-result-successp result) nil))
                 result))
          (dolist (p stand-ins)
            (dolist (user (copy-list (package-used-by-list p))) (unuse-package p user))
            (delete-package p))
          (uiop:delete-directory-tree dir :validate t :if-does-not-exist :ignore))))))

(defun check-error-note (condition file text)
  "An error note for CONDITION, signalled while the check compiled the top-level
form it was at, placed at that form's start in TEXT."
  (let* ((info (and (boundp 'sb-c::*source-info*) sb-c::*source-info*
                    (ignore-errors (sb-c::source-info-file-info sb-c::*source-info*))))
         (form (and (boundp 'sb-c::*current-path*) (car (last sb-c::*current-path*))))
         (from (or (and info (integerp form) (ignore-errors (aref (sb-c::file-info-positions info) form))) 0))
         (start (or (position-if-not (lambda (ch) (member ch '(#\Space #\Tab #\Newline #\Return))) text :start (min from (length text))) from)))
    (list :message (princ-to-string condition)
          :severity :error
          :location (swank/backend:make-location (list :file (namestring file)) (list :position (1+ start)))
          :references nil)))

(defun missing-packages (text)
  "Packages that TEXT's top-level IN-PACKAGE forms name, or its DEFPACKAGE forms
use or import from, that Lisp lacks and TEXT does not define, as in a project
not loaded yet. A check stands an empty package in for each, so the rest of the
file can still be read and compiled."
  (let ((names '())
        (defined '())
        (scratch (make-package (format nil "ZENLISP-CHECK-READ-~d" (random most-positive-fixnum)) :use '())))
    (flet ((want (designator)
             (when (typep designator '(or symbol string))
               (let ((name (string designator)))
                 (unless (or (find-package name) (member name names :test #'string=))
                   (push name names))))))
      (unwind-protect
           (with-input-from-string (s text)
             (handler-case
                 (let ((*read-eval* nil)
                       (*package* scratch))
                   (loop for form = (read s nil s)
                         until (eq form s)
                         when (consp form)
                           do (let ((head (and (symbolp (first form)) (symbol-name (first form)))))
                                (cond ((equal head "IN-PACKAGE") (want (second form)))
                                      ((equal head "DEFPACKAGE")
                                       (when (typep (second form) '(or symbol string))
                                         (push (string (second form)) defined))
                                       (dolist (option (cddr form))
                                         (when (consp option)
                                           (let ((kind (and (symbolp (first option)) (symbol-name (first option)))))
                                             (cond ((equal kind "USE") (mapc #'want (rest option)))
                                                   ((member kind '("IMPORT-FROM" "SHADOWING-IMPORT-FROM") :test #'equal)
                                                    (want (second option))))))))))))
               ;; Reading stops at the first form that needs a missing package; what came before counts.
               (error () nil)))
        (delete-package scratch)))
    (set-difference names defined :test #'string=)))
