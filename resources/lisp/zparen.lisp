(defpackage #:zparen
  (:use #:cl)
  (:export #:ping #:start-server #:project-systems
           #:load-system #:test-system #:run-system-tests #:rerun-tests))

(in-package #:zparen)

(defun use-own-fasl-cache (debug-code)
  "Keeps the fasls this image compiles apart from ASDF's usual cache. Builds run
in a separate SBCL with that cache and their own policy, and must not pick up
fasls compiled here for debugging. A compile from the editor writes its fasl
where ASDF looks for it, not beside the source, so a later load uses it."
  (setf uiop:*user-cache*
        (uiop:ensure-directory-pathname
         (merge-pathnames (format nil "Library/Caches/ZParen/fasl/~a/~:[plain~;debug~]/"
                                  (uiop:implementation-identifier) debug-code)
                          (user-homedir-pathname))))
  (asdf:initialize-output-translations)
  (setf swank::*fasl-pathname-function*
        (lambda (input options)
          (declare (ignore options))
          (ensure-directories-exist (asdf:apply-output-translations (compile-file-pathname input))))))

(defun start-server (&key (debug-code t) plugins)
  "Starts Swank on a free port and announces it as ZPAREN-PORT <n>. PLUGINS
is the plugins folder, whose plugins load first."
  (sb-ext:enable-debugger)
  ;; Code compiled during development keeps its locals and can be single-stepped.
  ;; Debug 2 leaves step instrumentation off, and a merged tail call hides the
  ;; stepped frame, so it takes debug 3. Builds run in a separate process with
  ;; their own policy.
  (when debug-code
    (sb-ext:restrict-compiler-policy 'debug 3))
  (use-own-fasl-cache debug-code)
  (setf swank-repl::*globally-redirect-io* t)
  (lock-image-changes)
  (accept-coalton-forms)
  (swank::init-presentations)
  (when plugins (uiop:symbol-call :zparen-plugin :load-plugins plugins))
  (let ((port (swank:create-server :port 0 :dont-close t :style :spawn)))
    (format t "~&ZPAREN-PORT ~D~%" port)
    (finish-output))
  (when plugins (uiop:symbol-call :zparen-plugin :session-ready))
  ;; ZParen holds our stdin open. EOF means it is gone, so exit rather
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
        :loaded (and (asdf:component-loaded-p system) t)
        ;; The function a built program starts in, such as "my-app:main", or "".
        :entry-point (let ((e (asdf/system:component-entry-point system))) (if (stringp e) e ""))))

(defun asd-systems (asd)
  "The names of the registered systems that ASD defines."
  (loop for name in (asdf:registered-systems)
        for system = (asdf:registered-system name)
        when (and system (equal (asdf:system-source-file system) asd))
          collect name))

(defvar *asd-texts* (make-hash-table :test #'equal)
  "Each .asd file's text when PROJECT-SYSTEMS last read it.")

(defun asd-current (asd)
  "Reads ASD again when its text differs from the text read last, or when it
defines no system yet."
  (let ((text (uiop:read-file-string asd)))
    (unless (and (asd-systems asd) (equal text (gethash (namestring asd) *asd-texts*)))
      (asdf:load-asd asd)
      (setf (gethash (namestring asd) *asd-texts*) text))))

(defun project-systems (root)
  "Systems defined by the .asd files under ROOT, excluding dependency caches.
An .asd is read again only when its text changed: reading it redefines its
systems, and ASDF then forgets they were loaded. Its text is compared, not its
date, which has a resolution of a second."
  (loop for asd in (asd-files root)
        do (handler-case (asd-current asd)
             (error (e) (format *error-output* "~&; could not load ~a: ~a~%" asd e)))
        append (loop for name in (asdf:registered-systems)
                     for system = (asdf:registered-system name)
                     when (and system (equal (asdf:system-source-file system) asd))
                       collect (system-info system))))

(defun ocicl-pins (root)
  "The versions ROOT's ocicl.csv pins, as (NAME VERSION DIRECTORY) lists. Each
line names a system, its registry reference and the directory it unpacks to,
such as split-sequence-2.0.1/, whose suffix after the name is the version."
  (let ((csv (merge-pathnames "ocicl.csv" (uiop:ensure-directory-pathname root))))
    (when (probe-file csv)
      (loop for line in (uiop:read-file-lines csv)
            for fields = (mapcar (lambda (f) (string-trim " " f)) (uiop:split-string line :separator ","))
            for (name nil path) = fields
            for dir = (and path (subseq path 0 (or (position #\/ path) (length path))))
            when (and name dir (plusp (length name)))
              collect (list name
                            (if (and (> (length dir) (1+ (length name))) (string= (concatenate 'string name "-") dir :end2 (1+ (length name))))
                                (subseq dir (1+ (length name)))
                                dir)
                            dir)))))

(defun dependency-info (root names)
  "For each system in NAMES, where it comes from and in which version: pinned
in ROOT's ocicl.csv, a Quicklisp release, a system ASDF knows, or missing."
  (let ((pins (ocicl-pins root))
        (ql (find-package "QL-DIST")))
    (flet ((loaded (name)
             (let ((s (asdf:registered-system name))) (and s (asdf:component-loaded-p s) t))))
      (loop for name in names
            for pin = (find name pins :key #'first :test #'string-equal)
            for release = (and (not pin) ql
                               (let ((s (funcall (find-symbol "FIND-SYSTEM" ql) name)))
                                 (and s (funcall (find-symbol "RELEASE" ql) s))))
            collect
            (cond (pin
                   (list :name name :version (second pin) :source "ocicl"
                         :installed (and (probe-file (merge-pathnames (format nil "ocicl/~a/" (third pin)) (uiop:ensure-directory-pathname root))) t)
                         :loaded (loaded name)))
                  (release
                   (let* ((project (funcall (find-symbol "NAME" ql) release))
                          (prefix (funcall (find-symbol "PREFIX" ql) release)))
                     (list :name name
                           :version (if (and (> (length prefix) (1+ (length project))) (string= (concatenate 'string project "-") prefix :end2 (1+ (length project))))
                                        (subseq prefix (1+ (length project)))
                                        prefix)
                           :source "quicklisp"
                           :installed (and (funcall (find-symbol "INSTALLEDP" ql) release) t)
                           :loaded (loaded name))))
                  ((asdf:registered-system name)
                   (list :name name :version (or (asdf:component-version (asdf:registered-system name)) "") :source "local"
                         :installed t :loaded (loaded name)))
                  (t (list :name name :version "" :source "missing" :installed nil :loaded nil)))))))

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

(defun loaded-source-files (root)
  "The Lisp source files under ROOT that belong to systems ASDF has loaded, as
paths relative to ROOT, one per line. Lisp has the code of these files as they
were on disk, so a later change to one can be compiled form by form."
  (let ((top (uiop:ensure-directory-pathname (truename root)))
        (out '()))
    (labels ((walk (c)
               (typecase c
                 (asdf:cl-source-file
                  (let ((p (ignore-errors (truename (asdf:component-pathname c)))))
                    (when (and p (uiop:subpathp p top))
                      (pushnew (uiop:native-namestring (uiop:enough-pathname p top)) out :test #'string=))))
                 (asdf:parent-component (mapc #'walk (asdf:component-children c))))))
      (dolist (name (asdf:already-loaded-systems))
        (let ((system (asdf:registered-system name)))
          (when system (walk system)))))
    (format nil "~{~a~%~}" (sort out #'string<))))

;; A check undoes what its compile added to the image, so nothing else may add
;; to the image meanwhile: a load that defines a package the check also saw as
;; new would lose it. Loading and compiling hold this lock too, through the
;; encapsulations START-SERVER installs, including a quickload typed in the REPL.
(defvar *image-lock* (sb-thread:make-mutex :name "zparen image"))

(defun hold-image-lock (function &rest args)
  "Calls FUNCTION with the image lock held, except while its thread sits in the
debugger: a compile stopped there would otherwise hold up every check and
compile until a restart is chosen."
  (sb-thread:with-recursive-lock (*image-lock*)
    (let* ((outer (or sb-ext:*invoke-debugger-hook* *debugger-hook*))
           (sb-ext:*invoke-debugger-hook*
             (lambda (condition hook)
               (cond ((not outer) nil)
                     ((sb-thread:holding-mutex-p *image-lock*)
                      (sb-thread:release-mutex *image-lock*)
                      (unwind-protect (funcall outer condition hook)
                        (sb-thread:grab-mutex *image-lock*)))
                     (t (funcall outer condition hook))))))
      (apply function args))))

;; SBCL raises some package errors, such as a DEFPACKAGE using a missing
;; package, while it holds its package graph lock, and a debugger opened there
;; keeps it held: every other thread that touches packages, so every compile
;; and check, then waits until a restart is chosen. A compile from the editor
;; reports such an error as a note on the form instead, and stops.
(defun graph-locked-error-note (condition location)
  (list :message (format nil "~a" condition) :severity :error :location location :references nil))

(defun compile-reporting-graph-errors (location function &rest args)
  "Calls the Swank compile FUNCTION with ARGS. An error while this thread holds
SBCL's package graph lock becomes an error note placed by LOCATION, a function
of the condition, and aborts the compile."
  (let* ((stopped nil)
         (result (handler-bind ((error (lambda (c)
                                         (when (sb-thread:holding-mutex-p sb-impl::*package-graph-lock*)
                                           (setf stopped (graph-locked-error-note c (funcall location c)))
                                           (let ((r (find-restart 'abort c)))
                                             (when r (invoke-restart r)))))))
                   (apply #'hold-image-lock function args))))
    (when (and stopped (consp result) (eq (first result) :compilation-result))
      ;; Aborting the form can make SBCL report the error itself.
      (unless (find (getf stopped :message) (swank::compilation-result-notes result)
                    :key (lambda (n) (getf n :message)) :test #'equal)
        (setf (swank::compilation-result-notes result) (append (swank::compilation-result-notes result) (list stopped))))
      (setf (swank::compilation-result-successp result) nil))
    result))

(defun compile-file-reporting (function file &rest args)
  ;; Loading a file needs what it depends on loaded first, as a build does.
  (when (first args) (load-prerequisites file))
  (apply #'compile-reporting-graph-errors
         (lambda (c)
           (getf (check-error-note c file (or (ignore-errors (uiop:read-file-string file)) "")) :location))
         function file args))

(defun compile-string-reporting (function string buffer position &rest args)
  (apply #'compile-reporting-graph-errors
         (lambda (c)
           (declare (ignore c))
           (swank/backend:make-location (list :buffer-and-file buffer (or (first args) buffer)) (list :offset position 0)))
         function string buffer position args))

(defun lock-image-changes ()
  ;; Swank's indentation thread walks every package, so it must not run while a check deletes one.
  (loop for (name wrapper) in '((asdf:operate hold-image-lock)
                                (swank:compile-file-for-emacs compile-file-reporting)
                                (swank:compile-string-for-emacs compile-string-reporting)
                                (swank::perform-indentation-update hold-image-lock))
        unless (sb-int:encapsulated-p name 'image-lock)
          do (sb-int:encapsulate name 'image-lock (symbol-function wrapper))))

;; Coalton defines each of its operators as a Lisp macro that only signals
;; that it is valid inside Coalton, and marks it with where it is valid. A
;; form typed in the REPL or evaluated from the editor, such as (define x 1) or
;; (match ...), runs as if written inside COALTON-TOPLEVEL or COALTON.
(defun coalton-operator (string)
  "When STRING holds exactly one form headed by a Coalton operator, the Coalton
macro that form belongs in, and the form's head."
  (let ((coalton (find-package "COALTON")))
    (when coalton
      (ignore-errors
       (swank::with-buffer-syntax ()
         (let ((*read-eval* nil))
           (multiple-value-bind (form end) (read-from-string string)
             (when (and (consp form) (symbolp (car form))
                        (eq (read-from-string string nil string :start end) string))
               (let ((op (case (get (car form) :coalton-repl-context)
                           (:toplevel (find-symbol "COALTON-TOPLEVEL" coalton))
                           (:expression (find-symbol "COALTON" coalton)))))
                 (when op (values op (car form))))))))))))

(defun call-as-coalton (string function)
  "Calls FUNCTION, which evaluates or compiles STRING. A Coalton form in STRING
expands inside its Coalton macro, so the compiler still places notes on it."
  (multiple-value-bind (op head) (coalton-operator string)
    (if (null op)
        (funcall function)
        (let* ((previous *macroexpand-hook*)
               (done nil)
               (*macroexpand-hook*
                 (lambda (expander form env)
                   (if (and (not done) (consp form) (eq (car form) head))
                       (progn (setf done t) (list op form))
                       (funcall previous expander form env)))))
          (funcall function)))))

(defun coalton-type (symbol-name)
  "The Coalton type of the value SYMBOL-NAME names, as Coalton prints it, or NIL."
  (let ((describe (and (find-package "COALTON") (find-symbol "DESCRIBE-TYPE-OF" "COALTON"))))
    (when (and describe (fboundp describe))
      (ignore-errors
       (swank::with-buffer-syntax ()
         (multiple-value-bind (symbol found) (swank::parse-symbol symbol-name)
           (when found
             (let ((type (string-trim '(#\Space #\Newline)
                                      (with-output-to-string (*standard-output*) (funcall describe symbol)))))
               (unless (member type '("" "unknown" "macro") :test #'string=) type)))))))))

(defun document-with-coalton-type (function symbol-name)
  (let ((doc (funcall function symbol-name))
        (type (coalton-type symbol-name)))
    (if (and type (stringp doc))
        (let ((body (search (format nil "~2%") doc)))
          (format nil "~a~2%Coalton type: ~a~2%~a" (subseq doc 0 (or body 0))
                  type (string-left-trim '(#\Newline) (remove-not-documented (subseq doc (or body 0))))))
        doc)))

(defun remove-not-documented (text)
  (let ((at (search "Not documented." text)))
    (if at (concatenate 'string (subseq text 0 at) (subseq text (+ at (length "Not documented.")))) text)))

(defun coalton-symbol (name package)
  (let ((p (find-package package)))
    (and p (find-symbol name p))))

(defun coalton-readtable ()
  "Coalton's readtable. Code read with it keeps its place in the file, so
Coalton's errors point at the expression they are about."
  (let ((find (coalton-symbol "FIND-READTABLE" "NAMED-READTABLES"))
        (name (coalton-symbol "COALTON" "COALTON")))
    (and find name (fboundp find) (funcall find name))))

(defun coalton-error-offset (condition)
  "Where in the text being compiled Coalton places its error CONDITION, when
Coalton read that text itself: the start of the expression its first note is
on. Coalton names text compiled from an editor buffer by the buffer."
  (flet ((call (name arg) (funcall (coalton-symbol name "COALTON-IMPL/SOURCE") arg)))
    (ignore-errors
     (let* ((location (call "LOCATION" (first (call "NOTES" condition))))
            (file (call "SOURCE-FILE-PATH" (call "LOCATION-SOURCE" location))))
       (when (if swank/sbcl::*buffer-name*
                 (equal file swank/sbcl::*buffer-name*)
                 (and *compile-file-truename* (equal (probe-file file) (probe-file *compile-file-truename*))))
         (call "SPAN-START" (call "LOCATION-SPAN" location)))))))

(defun coalton-error-location (condition)
  (let ((offset (coalton-error-offset condition)))
    (cond ((null offset)
           (swank/sbcl::compiler-note-location condition (sb-c::find-error-context nil)))
          (swank/sbcl::*buffer-name*
           (swank/backend:make-location (list :buffer swank/sbcl::*buffer-name*)
                                        (list :offset swank/sbcl::*buffer-offset* offset)))
          (t
           (swank/backend:make-location (list :file (namestring *compile-file-truename*))
                                        (list :position (1+ offset)))))))

(defun compile-with-coalton-errors (text function)
  "Calls FUNCTION, a Swank compile of TEXT. A form that Coalton rejects becomes an
error note in Coalton's words, placed on the expression Coalton blames, and
compiles to nothing, so loading the result does not stop on it. Other errors
are left to the compiler, as before."
  (let ((error-type (coalton-symbol "SOURCE-ERROR" "COALTON-IMPL/SOURCE")))
    (if (null error-type)
        (funcall function)
        (let* ((readtable (and (search "coalton" text :test #'char-equal) (coalton-readtable)))
               (swank::*buffer-readtable* (or readtable swank::*buffer-readtable*))
               (failed nil)
               (depth 0)
               (previous *macroexpand-hook*)
               (*macroexpand-hook*
                 (lambda (expander form env)
                   (if (plusp depth)
                       (funcall previous expander form env)
                       (block expand
                         (handler-bind ((error (lambda (c)
                                                 (when (typep c error-type)
                                                   (setf failed t)
                                                   (signal 'swank/backend:compiler-condition
                                                           :original-condition c
                                                           :severity :error
                                                           :message (princ-to-string c)
                                                           :source-context nil
                                                           :references nil
                                                           :location (coalton-error-location c))
                                                   (return-from expand '(values))))))
                           (incf depth)
                           (unwind-protect (funcall previous expander form env)
                             (decf depth)))))))
               (result (funcall function)))
          (when (and failed (consp result) (eq (first result) :compilation-result))
            (setf (swank::compilation-result-successp result) nil))
          result))))

(defun eval-as-coalton (function string &rest args)
  (call-as-coalton string (lambda () (apply function string args))))

(defun compile-string-as-coalton (function string &rest args)
  (call-as-coalton string (lambda () (compile-with-coalton-errors string (lambda () (apply function string args))))))

(defun compile-file-as-coalton (function file &rest args)
  (compile-with-coalton-errors (or (ignore-errors (uiop:read-file-string file)) "")
                               (lambda () (apply function file args))))

(defun accept-coalton-forms ()
  (loop for (name wrapper) in '((swank::eval-region eval-as-coalton)
                                (swank:eval-and-grab-output eval-as-coalton)
                                (swank:compile-string-for-emacs compile-string-as-coalton)
                                (swank:compile-file-for-emacs compile-file-as-coalton)
                                (swank:documentation-symbol document-with-coalton-type))
        unless (sb-int:encapsulated-p name 'coalton)
          do (sb-int:encapsulate name 'coalton (symbol-function wrapper))))

(defvar *checking* nil "True while a check compiles, which is not a compile the user asked for.")

(defvar *check-functions* '()
  "Functions of a file's path and text that a check calls after compiling, each
returning notes as plists of :START, :END, :MESSAGE and :SEVERITY.")

(defun check-function-note (note file)
  (list :message (getf note :message)
        :severity (getf note :severity)
        :location (swank/backend:make-location (list :file (namestring file)) (list :position (1+ (getf note :start))))
        :references nil))

;; A check must always answer: a compile-time error such as a DEFPACKAGE that
;; uses a missing package would otherwise stop the check thread in the
;; debugger, holding the lock every later check waits for.
(defun check-text (text &optional source)
  "Compiles TEXT as a file, without loading it, for the compiler's notes on code
as it is being written. The file is compiled whole, so it sees the functions
and macros it defines itself; positions in the notes are positions in TEXT.
Compiling evaluates what the file asks for at compile time, as any compile does.
An error at compile time becomes an error note, and the check goes on past it
when the error allows that, or stops there.
TEXT is SOURCE's text, when SOURCE names a file. When the packages TEXT uses
are not in Lisp yet, the files SOURCE depends on in its ASDF system compile
first, as a build compiles them, so their packages and functions are known."
  (sb-thread:with-recursive-lock (*image-lock*)
    (let* ((dir (uiop:ensure-directory-pathname
                 (merge-pathnames (format nil "zparen-check-~d/" (sb-posix:getpid)) (uiop:temporary-directory))))
           (file (merge-pathnames "buffer.lisp" dir))
           (stopped '()))
      (ensure-directories-exist dir)
      (with-open-file (s file :direction :output :if-exists :supersede :external-format :utf-8)
        (write-string text s))
      ;; A new session has not loaded the system's dependencies yet. Those already
      ;; on disk load, so their packages are known; a check never downloads one.
      (when (and source (missing-packages text))
        (dolist (name (unloaded-dependencies source))
          (when (ignore-errors (asdf:find-system name nil))
            (let ((*standard-output* (make-broadcast-stream))
                  (*error-output* (make-broadcast-stream)))
              (ignore-errors (asdf:load-system name))))))
      (let* ((first (and source (missing-packages text) (prerequisite-files source)))
             (all (format nil "~{~a~%~}~a" (mapcar #'uiop:read-file-string first) text))
             (trace (image-trace all))
             (stand-ins (mapcar (lambda (name) (make-package name :use '("COMMON-LISP"))) (missing-packages all))))
        (unwind-protect
             (let ((*standard-output* (make-broadcast-stream))
                   (*error-output* (make-broadcast-stream))
                   (*checking* t)
                   ;; The scratch copy's fasl stays beside it, and goes with its directory.
                   (swank::*fasl-pathname-function* nil))
               (loop for f in first for i from 0
                     do (compile-quietly f (merge-pathnames (format nil "first-~d.fasl" i) dir)))
               (let ((result (handler-bind ((error (lambda (c)
                                                     (push (check-error-note c file text) stopped)
                                                     (let ((r (or (find-restart 'continue c) (find-restart 'abort c))))
                                                       (when r (invoke-restart r))))))
                               (swank:compile-file-for-emacs (namestring file) nil))))
                 (when stopped
                   (setf (swank::compilation-result-notes result)
                         (append (swank::compilation-result-notes result) (reverse stopped))
                         (swank::compilation-result-successp result) nil))
                 (name-the-checked-file result file source)
                 (let ((more (loop for f in *check-functions* append (funcall f source text))))
                   (when more
                     (setf (swank::compilation-result-notes result)
                           (append (swank::compilation-result-notes result) (mapcar (lambda (n) (check-function-note n file)) more)))
                     (when (find :error more :key (lambda (n) (getf n :severity)))
                       (setf (swank::compilation-result-successp result) nil))))
                 result))
          (restore-image trace)
          (dolist (p stand-ins)
            (when (package-name p)
              (dolist (user (copy-list (package-used-by-list p))) (unuse-package p user))
              (delete-package p)))
          (uiop:delete-directory-tree dir :validate t :if-does-not-exist :ignore))))))

(defun name-the-checked-file (result file source)
  "Messages that name the scratch copy a check compiles, as Coalton's do, name
SOURCE, the file being checked, instead."
  (let ((copies (remove nil (list (ignore-errors (namestring (truename file))) (namestring file))))
        (name (if source (namestring source) "this file")))
    (dolist (note (swank::compilation-result-notes result))
      (let ((message (getf note :message)))
        (when (stringp message)
          (dolist (copy copies)
            (loop for at = (search copy message) then (search copy message :start2 (+ at (length name)))
                  while at
                  do (setf message (concatenate 'string (subseq message 0 at) name (subseq message (+ at (length copy)))))))
          (setf (getf note :message) message))))))

(defun compile-quietly (file output)
  "Compiles FILE to OUTPUT for what it defines, keeping none of its notes. An
error goes on where the compiler allows and otherwise ends that file."
  (handler-bind ((error (lambda (c)
                          (let ((r (or (find-restart 'continue c) (find-restart 'abort c))))
                            (when r (invoke-restart r)))))
                 (warning (lambda (w)
                            (let ((r (find-restart 'muffle-warning w)))
                              (when r (invoke-restart r))))))
    (ignore-errors (compile-file file :output-file output))))

(defun file-component (path)
  "The source file component, of a system ASDF knows, whose file is PATH."
  (let ((target (ignore-errors (truename path))))
    (when target
      (labels ((walk (c)
                 (typecase c
                   (asdf:cl-source-file
                    (when (equal (ignore-errors (truename (asdf:component-pathname c))) target)
                      (return-from file-component c)))
                   (asdf:parent-component (mapc #'walk (asdf:component-children c))))))
        (dolist (name (asdf:registered-systems))
          (let ((system (asdf:registered-system name)))
            (when system (walk system))))))))

(defun unloaded-dependencies (path)
  "The systems that PATH's system depends on, such as alexandria, and that are
not loaded yet, by name."
  (let* ((c (file-component path))
         (name (and c (asdf:component-name (asdf:component-system c))))
         ;; The .asd is read again when it changed, so a dependency just added counts.
         (system (and name (progn (asd-current (asdf:system-source-file (asdf:component-system c)))
                                  (asdf:registered-system name)))))
    (when system
      (loop for dep in (asdf:system-depends-on system)
            for dep-name = (if (consp dep) (car (last dep)) dep)
            when (and (typep dep-name '(or string symbol))
                      (not (let ((s (asdf:registered-system dep-name))) (and s (asdf:component-loaded-p s)))))
              collect (string-downcase (string dep-name))))))

(defun load-prerequisites (path)
  "Loads what PATH needs before it can load: the systems its system depends
on, such as alexandria, and, when the packages PATH uses are not in Lisp yet,
the files PATH depends on in its system. ASDF loads them in order, from fasls
where they are current, and skips what is loaded already."
  (mapc #'load-system (unloaded-dependencies path))
  (when (ignore-errors (missing-packages (uiop:read-file-string path)))
    (dolist (file (prerequisite-files path))
      (let ((c (file-component file)))
        (when c (asdf:operate 'asdf:load-op c))))))

(defun prerequisite-files (path)
  "The files that PATH's component depends on within its system, those before
it in the order a build compiles them, deepest first. PATH itself is left out."
  (let ((target (file-component path))
        (out '())
        (seen '()))
    (labels ((sideways (c)
               (loop for dep in (asdf:component-sideway-dependencies c)
                     for found = (and (typep dep '(or string symbol)) (asdf:component-parent c)
                                      (asdf:find-component (asdf:component-parent c) dep))
                     when found collect found))
             (visit (c)
               (unless (member c seen)
                 (push c seen)
                 (mapc #'visit (sideways c))
                 (let ((parent (asdf:component-parent c)))
                   (when (and parent (not (typep parent 'asdf:system))) (mapc #'visit (sideways parent))))
                 (typecase c
                   (asdf:cl-source-file (unless (eq c target) (push (asdf:component-pathname c) out)))
                   (asdf:parent-component (mapc #'visit (asdf:component-children c)))))))
      (when target (visit target)))
    (nreverse out)))

;; A check must leave the image as it found it. Its DEFPACKAGEs run at compile
;; time and reading interns every symbol it meets, so without this a package
;; made against an empty stand-in, or a name half typed, stays behind and
;; conflicts with the real definitions when the system loads.
(defun image-trace (text)
  "What a check of TEXT may add to the image: the packages TEXT defines that do
not exist yet, and the symbols present now in the existing packages it names."
  (multiple-value-bind (in-packages defined) (text-packages text)
    (list :new (remove-if #'find-package defined)
          :present (loop for name in (union in-packages defined :test #'string=)
                         for p = (find-package name)
                         when p
                           collect (let ((seen (make-hash-table :test #'eq)))
                                     (do-symbols (s p) (when (eq (symbol-package s) p) (setf (gethash s seen) t)))
                                     (cons p seen))))))

(defun package-has-functions-p (package)
  (do-symbols (s package nil)
    (when (and (eq (symbol-package s) package) (fboundp s) (not (macro-function s)))
      (return t))))

(defun restore-image (trace)
  "Undoes what a check added, by TRACE from IMAGE-TRACE: deletes the packages it
created and uninterns the symbols it only read. A symbol the check gave a
meaning, such as a macro or a class, is kept."
  (dolist (name (getf trace :new))
    (let ((p (find-package name)))
      ;; A check never runs a DEFUN, so a function in the package means something
      ;; else loaded into it, as a LOAD typed in the REPL could, and it stays.
      (when (and p (not (package-has-functions-p p)))
        (dolist (user (copy-list (package-used-by-list p))) (unuse-package p user))
        (delete-package p))))
  (loop for (p . seen) in (getf trace :present)
        when (package-name p)
          do (let ((added '()))
               (do-symbols (s p)
                 (when (and (eq (symbol-package s) p) (not (gethash s seen))
                            (not (or (fboundp s) (boundp s) (symbol-plist s) (find-class s nil))))
                   (push s added)))
               (dolist (s added) (unintern s p)))))

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

(defun text-packages (text)
  ;; Its scratch package is made and deleted, so it takes turns with the rest of what changes packages.
  (sb-thread:with-recursive-lock (*image-lock*) (read-text-packages text)))

(defun read-text-packages (text)
  "The packages TEXT's top-level forms name, read without its packages: those
its IN-PACKAGE forms name, those its DEFPACKAGE forms define, and those they use
or import from. Reading stops at the first form that needs a missing package."
  (let ((in-packages '())
        (defined '())
        (used '())
        (scratch (make-package (format nil "ZPAREN-CHECK-READ-~d" (random most-positive-fixnum)) :use '())))
    (flet ((name (designator) (and (typep designator '(or symbol string)) (string designator))))
      (unwind-protect
           (with-input-from-string (s text)
             (handler-case
                 (let ((*read-eval* nil)
                       (*package* scratch))
                   (loop for form = (read s nil s)
                         until (eq form s)
                         when (consp form)
                           do (let ((head (and (symbolp (first form)) (symbol-name (first form)))))
                                (cond ((equal head "IN-PACKAGE")
                                       (let ((n (name (second form)))) (when n (pushnew n in-packages :test #'string=))))
                                      ((equal head "DEFPACKAGE")
                                       (let ((n (name (second form)))) (when n (pushnew n defined :test #'string=)))
                                       (dolist (option (cddr form))
                                         (when (consp option)
                                           (let ((kind (and (symbolp (first option)) (symbol-name (first option)))))
                                             (cond ((equal kind "USE")
                                                    (dolist (u (rest option)) (let ((n (name u))) (when n (pushnew n used :test #'string=)))))
                                                   ((member kind '("IMPORT-FROM" "SHADOWING-IMPORT-FROM") :test #'equal)
                                                    (let ((n (name (second option)))) (when n (pushnew n used :test #'string=))))
                                                   ((equal kind "LOCAL-NICKNAMES")
                                                    (dolist (pair (rest option))
                                                      (let ((n (and (consp pair) (name (second pair)))))
                                                        (when n (pushnew n used :test #'string=))))))))))))))
               (error () nil)))
        (delete-package scratch)))
    (values in-packages defined used)))

(defun missing-packages (text)
  "Packages that TEXT's IN-PACKAGE forms name, or its DEFPACKAGE forms use or
import from, that Lisp lacks and TEXT does not define, as in a project not
loaded yet. A check stands an empty package in for each, so the rest of the
file can still be read and compiled."
  (multiple-value-bind (in-packages defined used) (text-packages text)
    (remove-if (lambda (name) (or (find-package name) (member name defined :test #'string=)))
               (union in-packages used :test #'string=))))

;;; What the name being typed names, for completion: a package or an ASDF
;;; system where code names one, as in (:use #:alexan, (in-package :my- or
;;; :depends-on ("cl-pp, which Swank's symbol completion does not offer.

(defun cursor-lists (text)
  "The lists still open at the end of TEXT, innermost first, and the atom being
typed there. Each list holds its elements so far: strings for atoms, lists for
the lists closed inside it. A string still open at the end is the atom, with
its opening quote."
  (let ((stack (list '()))
        (atom (make-array 16 :element-type 'character :adjustable t :fill-pointer 0))
        (i 0)
        (n (length text)))
    (flet ((flush ()
             (when (plusp (length atom))
               (push (copy-seq atom) (first stack))
               (setf (fill-pointer atom) 0)))
           (add (string) (loop for ch across string do (vector-push-extend ch atom))))
      (loop while (< i n)
            do (let ((ch (char text i)))
                 (cond ((char= ch #\;)
                        (flush)
                        (setf i (or (position #\Newline text :start i) n)))
                       ((and (char= ch #\#) (< (1+ i) n) (char= (char text (1+ i)) #\|))
                        (flush)
                        (setf i (let ((end (search "|#" text :start2 (+ i 2)))) (if end (1+ end) n))))
                       ((and (char= ch #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
                        (add (subseq text i (min n (+ i 3))))
                        (incf i 2))
                       ((char= ch #\")
                        (flush)
                        (let ((end (loop with j = (1+ i)
                                         while (< j n)
                                         do (case (char text j)
                                              (#\\ (incf j 2))
                                              (#\" (return j))
                                              (t (incf j))))))
                          (add (subseq text i (if end (1+ end) n)))
                          (unless end (return))
                          (flush)
                          (setf i end)))
                       ((char= ch #\()
                        (flush)
                        (push '() stack))
                       ((char= ch #\))
                        (flush)
                        (if (rest stack)
                            (let ((closed (reverse (pop stack)))) (push closed (first stack)))
                            (setf (first stack) '())))
                       ((member ch '(#\Space #\Tab #\Newline #\Return #\Page)) (flush))
                       ;; A quote before a list or an atom changes neither for this.
                       ((and (member ch '(#\' #\` #\,)) (zerop (length atom))))
                       (t (vector-push-extend ch atom))))
               (incf i)))
    (values (mapcar #'reverse (butlast stack)) (copy-seq atom))))

(defparameter *package-forms*
  '("in-package" "use-package" "unuse-package" "find-package" "delete-package" "do-symbols" "do-external-symbols"))
(defparameter *system-forms*
  '("ql:quickload" "quicklisp:quickload" "asdf:load-system" "asdf:require-system" "asdf:test-system" "asdf:make"
    "asdf:find-system" "require" "zparen:load-system"))
(defparameter *define-package-forms* '("defpackage" "cl:defpackage" "uiop:define-package"))
(defparameter *define-system-forms* '("defsystem" "asdf:defsystem"))
(defparameter *depends-on-options* '(":depends-on" ":defsystem-depends-on" ":weakly-depends-on"))

(defun designator-at (text)
  "\"package\" or \"system\" when the atom at the end of TEXT names one, as the
form it is in says, else NIL. TEXT runs from the start of a top-level form to
the cursor. The atom is a keyword, an uninterned symbol or a string; a name
with a package prefix is a symbol."
  (multiple-value-bind (lists atom) (cursor-lists text)
    (let* ((in-string (and (plusp (length atom)) (char= (char atom 0) #\")))
           (marker (cond (in-string "\"")
                         ((uiop:string-prefix-p "#:" atom) "#:")
                         ((uiop:string-prefix-p ":" atom) ":")))
           (list (first lists))
           (outer (second lists))
           (top (third lists))
           (at (length list)))
      (labels ((head (l) (let ((h (first l))) (and (stringp h) (string-downcase h))))
               (head-in (l names) (member (head l) names :test #'equal)))
        (cond ((or (null marker) (find #\: atom :start (length marker))) nil)
              ((and (head list) (plusp at) (head-in list *package-forms*)) "package")
              ((and (head list) (plusp at) (head-in list *system-forms*)) "system")
              ((and (plusp at) (equal (head list) ":use") (head-in outer *define-package-forms*)) "package")
              ((and (= at 1) (member (head list) '(":import-from" ":shadowing-import-from") :test #'equal)) "package")
              ((and (plusp at) (head-in list *depends-on-options*)) "system")
              ;; (:local-nicknames (#:a #:alexandria)): the second of each pair is a package.
              ((and (= at 1) (equal (head outer) ":local-nicknames")) "package")
              ;; (ql:quickload '(:a :b)) and (:depends-on ((:version "a" "1")))
              ((or (head-in outer *system-forms*) (equal (head outer) ":depends-on")) "system")
              ;; (defsystem "app" :depends-on ("a" (:version "b" "1"))): the list after the keyword.
              ((loop for system in (list outer top)
                     thereis (and (head-in system *define-system-forms*)
                                  (let ((before (car (last system))))
                                    (and (stringp before)
                                         (member (string-downcase before) *depends-on-options* :test #'equal)))))
               "system")
              ;; Inside a DEFPACKAGE only its options above name packages; elsewhere #:name almost always does.
              ((and (equal marker "#:") (notany (lambda (l) (head-in l *define-package-forms*)) lists)) "package"))))))
