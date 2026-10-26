;;;; Plugins: Lisp files in ZenLisp's plugins folder, loaded into every
;;;; session, that add commands, checks, settings and hooks. The editor reads
;;;; what they add from MANIFEST and runs a command or an editor hook through
;;;; RUN-COMMAND and RUN-EDITOR-HOOK, which answer with effects as JSON for the
;;;; editor to apply. See docs/plugins.md.

(defpackage #:zenlisp-plugin
  (:use #:cl)
  (:export #:define-command #:define-check #:define-setting #:setting #:add-hook #:remove-hook
           #:context-file #:context-text #:context-cursor #:context-selection #:context-package #:context-form
           #:form-start #:form-end #:form-text
           #:replace-range #:insert #:open-file #:message #:repl-print #:note
           #:plugins-directory))

(in-package #:zenlisp-plugin)

(defvar *directory* nil "The plugins folder, ending in a slash.")

(defstruct plugin name path (error nil))

(defvar *plugins* '() "The plugins found at the last load, in load order.")

(defvar *loading* nil "The name of the plugin being loaded, which owns what it defines.")

(defun owner () (or *loading* "user"))

(defun plugins-directory () *directory*)

;;; What plugins define. Each entry names its owner, so a reload replaces a
;;; plugin's definitions without touching the others.

(defstruct command id title key owner function)
(defstruct check name owner function)
(defstruct hook event owner function)
(defstruct setting-spec symbol title type default choices doc owner)

(defvar *commands* '())
(defvar *checks* '())
(defvar *hooks* '())
(defvar *setting-specs* '())
(defvar *setting-values* (make-hash-table :test #'equal) "Values set in Settings, by setting key.")

(defun register-command (name title key function)
  (let ((id (format nil "~(~a/~a~)" (owner) name)))
    (setf *commands* (append (remove id *commands* :key #'command-id :test #'string=)
                             (list (make-command :id id :title (or title (string-capitalize (substitute #\Space #\- (string name))))
                                                 :key key :owner (owner) :function function))))
    id))

(defmacro define-command (name (context) (&key title key) &body body)
  "Adds a command to the palette, and to KEY when given, in CodeMirror's
notation such as \"Mod-Alt-t\". BODY runs with CONTEXT bound to the editor's
state, and asks for changes by calling REPLACE-RANGE, INSERT, OPEN-FILE,
MESSAGE and REPL-PRINT."
  `(register-command ',name ,title ,key (lambda (,context) (declare (ignorable ,context)) ,@body)))

(defun register-check (name function)
  (setf *checks* (append (remove-if (lambda (c) (and (eq (check-name c) name) (equal (check-owner c) (owner)))) *checks*)
                         (list (make-check :name name :owner (owner) :function function))))
  name)

(defmacro define-check (name (file text) &body body)
  "Adds a check that runs with each live check of a file. FILE is its path,
or NIL for an unsaved buffer, and TEXT its text. BODY returns a list of notes
made with NOTE."
  `(register-check ',name (lambda (,file ,text) (declare (ignorable ,file ,text)) ,@body)))

(defun note (start end message &key (severity :warning))
  "A check's note on TEXT from START to END. SEVERITY is :ERROR, :WARNING,
:STYLE-WARNING or :NOTE."
  (list :start start :end end :message message :severity severity))

(defparameter *events*
  '(:session-ready :before-save :after-save :after-load-system :after-compile-file
    :tests-finished :debugger-entered :repl-input :repl-result))

(defun add-hook (event function)
  "Runs FUNCTION when EVENT happens. The events and their arguments:
:SESSION-READY (root), :BEFORE-SAVE (path text), :AFTER-SAVE (path),
:AFTER-LOAD-SYSTEM (name), :AFTER-COMPILE-FILE (path success),
:TESTS-FINISHED (run), :DEBUGGER-ENTERED (condition), :REPL-INPUT (input)
and :REPL-RESULT (input values). A :REPL-INPUT hook returns a string to
evaluate in place of the input, :HANDLED to evaluate nothing, or NIL. A
:BEFORE-SAVE hook may change the file with REPLACE-RANGE before it is written."
  (unless (member event *events*) (error "~s is not a plugin event; the events are ~s" event *events*))
  (remove-hook event function)
  (setf *hooks* (append *hooks* (list (make-hook :event event :owner (owner) :function function))))
  function)

(defun remove-hook (event function)
  (setf *hooks* (remove-if (lambda (h) (and (eq (hook-event h) event) (eq (hook-function h) function))) *hooks*))
  nil)

;;; Settings. A setting's key is its symbol's full name, so two plugins can
;;; use the same name. Values set in Settings persist in settings.sexp.

(defun setting-key (symbol) (format nil "~a::~a" (package-name (symbol-package symbol)) (symbol-name symbol)))

(defun register-setting (symbol title type default choices doc)
  (unless (member type '(:boolean :string :number :choice)) (error "~s is not a setting type; use :boolean, :string, :number or :choice" type))
  (setf *setting-specs* (append (remove symbol *setting-specs* :key #'setting-spec-symbol)
                                (list (make-setting-spec :symbol symbol :title (or title (string-capitalize (substitute #\Space #\- (string symbol))))
                                                         :type type :default default :choices choices :doc doc :owner (owner)))))
  symbol)

(defmacro define-setting (name &key title (type :boolean) default choices doc)
  "Adds a setting to the Settings screen. TYPE is :BOOLEAN, :STRING, :NUMBER
or :CHOICE, which picks one of CHOICES, a list of strings. SETTING reads it."
  `(register-setting ',name ,title ,type ,default ',choices ,doc))

(defun setting (name)
  "The value of the setting NAME: what was set in Settings, or its default."
  (multiple-value-bind (value found) (gethash (setting-key name) *setting-values*)
    (if found
        value
        (let ((spec (find name *setting-specs* :key #'setting-spec-symbol)))
          (and spec (setting-spec-default spec))))))

(defun settings-file () (and *directory* (merge-pathnames "settings.sexp" *directory*)))

(defun read-setting-values ()
  (clrhash *setting-values*)
  (let ((file (settings-file)))
    (when (and file (probe-file file))
      (ignore-errors
       (with-open-file (s file)
         (let ((*read-eval* nil))
           (loop for (key . value) in (read s nil '()) do (setf (gethash key *setting-values*) value))))))))

(defun set-setting (key value)
  (let ((spec (find key *setting-specs* :key (lambda (s) (setting-key (setting-spec-symbol s))) :test #'string=)))
    (unless spec (error "No setting is named ~a" key))
    (setf (gethash key *setting-values*)
          (ecase (setting-spec-type spec)
            (:boolean (and value t))
            ((:string :choice) (princ-to-string value))
            (:number (if (realp value) value (error "~a takes a number" key)))))
    (with-open-file (s (settings-file) :direction :output :if-exists :supersede)
      (with-standard-io-syntax
        (prin1 (loop for k being the hash-keys of *setting-values* using (hash-value v) collect (cons k v)) s)))
    (manifest)))

;;; Effects: what a command or a hook asks the editor to do.

(defvar *effects* :none "The effects asked for so far, newest first, while the editor waits for them.")

(defun effect (&rest plist)
  (if (eq *effects* :none)
      (error "~a only works in a command or an editor hook" (getf plist :type))
      (push (cons :obj plist) *effects*))
  nil)

(defun replace-range (start end text)
  "Replaces the text from START to END, offsets in the context's text."
  (effect :type "replace" :from start :to end :text text))

(defun insert (text) (effect :type "insert" :text text))

(defun open-file (path &key line) (effect :type "open" :path (namestring path) :line (or line :null)))

(defun message (text) (effect :type "message" :text text))

(defun repl-print (text) (effect :type "print" :text text))

;;; The editor's state when a command runs.

(defstruct context file text cursor selection-start selection-end package)

(defun context-selection (context)
  "The selection's start and end, as two values."
  (values (context-selection-start context) (context-selection-end context)))

(defstruct form start end text)

(defun top-level-forms (text)
  "The top-level forms of TEXT as (START . END), skipping comments."
  (let ((forms '()) (start nil) (depth 0) (i 0) (n (length text)))
    (flet ((close-atom (at) (when (and start (zerop depth)) (push (cons start at) forms) (setf start nil))))
      (loop while (< i n)
            do (let ((ch (char text i)))
                 (cond ((char= ch #\;)
                        (when (zerop depth) (close-atom i))
                        (setf i (or (position #\Newline text :start i) n)))
                       ((and (char= ch #\#) (< (1+ i) n) (char= (char text (1+ i)) #\|))
                        (when (zerop depth) (close-atom i))
                        (setf i (let ((end (search "|#" text :start2 (+ i 2)))) (if end (1+ end) n))))
                       ((and (char= ch #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
                        (unless start (setf start i))
                        (incf i 2))
                       ((char= ch #\")
                        (unless start (setf start i))
                        (setf i (or (loop with j = (1+ i)
                                          while (< j n)
                                          do (case (char text j)
                                               (#\\ (incf j 2))
                                               (#\" (return j))
                                               (t (incf j))))
                                    n)))
                       ((char= ch #\()
                        (unless start (setf start i))
                        (incf depth))
                       ((char= ch #\))
                        (when (plusp depth)
                          (decf depth)
                          (when (zerop depth) (push (cons start (1+ i)) forms) (setf start nil))))
                       ((member ch '(#\Space #\Tab #\Newline #\Return #\Page))
                        (when (zerop depth) (close-atom i)))
                       (t (unless start (setf start i)))))
               (incf i))
      (when start (push (cons start n) forms)))
    (nreverse forms)))

(defun context-form (context)
  "The top-level form around the cursor, or the last one before it, or NIL."
  (let* ((text (context-text context))
         (cursor (context-cursor context))
         (forms (top-level-forms text))
         (at (or (find-if (lambda (f) (<= (car f) cursor (cdr f))) forms)
                 (find-if (lambda (f) (<= (cdr f) cursor)) forms :from-end t))))
    (and at (make-form :start (car at) :end (cdr at) :text (subseq text (car at) (cdr at))))))

;;; JSON for the editor. :TRUE, :FALSE and :NULL are themselves, a list that
;;; starts with :OBJ is an object of the plist after it, and other lists are
;;; arrays.

(defun write-json (x s)
  (cond ((eq x :true) (write-string "true" s))
        ((member x '(:false nil)) (write-string (if (null x) "[]" "false") s))
        ((eq x :null) (write-string "null" s))
        ((stringp x)
         (write-char #\" s)
         (loop for ch across x
               do (case ch
                    (#\" (write-string "\\\"" s))
                    (#\\ (write-string "\\\\" s))
                    (#\Newline (write-string "\\n" s))
                    (#\Return (write-string "\\r" s))
                    (#\Tab (write-string "\\t" s))
                    (t (if (< (char-code ch) 32) (format s "\\u~4,'0x" (char-code ch)) (write-char ch s)))))
         (write-char #\" s))
        ((integerp x) (format s "~d" x))
        ((realp x) (format s "~f" x))
        ((symbolp x) (write-json (string-downcase (symbol-name x)) s))
        ((eq (first x) :obj)
         (write-char #\{ s)
         (loop for (k v) on (rest x) by #'cddr for first = t then nil
               do (unless first (write-char #\, s))
                  (write-json (if (stringp k) k (string-downcase (symbol-name k))) s)
                  (write-char #\: s)
                  (write-json v s))
         (write-char #\} s))
        (t (write-char #\[ s)
           (loop for (e . more) on x do (write-json e s) (when more (write-char #\, s)))
           (write-char #\] s))))

(defun json (x) (with-output-to-string (s) (write-json x s)))

(defun bool (x) (if x :true :false))

(defun json-value (value type)
  (case type
    (:boolean (bool value))
    (t (or value :null))))

(defun manifest ()
  "What the plugins add, for the editor, as JSON."
  (json (list :obj
              :directory (if *directory* (namestring *directory*) :null)
              :plugins (loop for p in *plugins*
                             collect (list :obj :name (plugin-name p) :path (namestring (plugin-path p))
                                           :error (or (plugin-error p) :null)))
              :commands (loop for c in *commands*
                              collect (list :obj :id (command-id c) :title (command-title c)
                                            :key (or (command-key c) :null) :plugin (command-owner c)))
              :settings (loop for s in *setting-specs*
                              collect (list :obj :id (setting-key (setting-spec-symbol s)) :plugin (setting-spec-owner s)
                                            :title (setting-spec-title s) :type (setting-spec-type s)
                                            :value (json-value (setting (setting-spec-symbol s)) (setting-spec-type s))
                                            :choices (or (setting-spec-choices s) '())
                                            :doc (or (setting-spec-doc s) :null)))
              :hooks (remove-duplicates (mapcar (lambda (h) (string-downcase (symbol-name (hook-event h)))) *hooks*)
                                        :test #'string=))))

;;; Running what plugins define. An error in a plugin's code becomes a message
;;; naming the plugin: a thread stopped in the debugger could hold the lock
;;; that compiles and checks wait for.

(defun describe-error (owner what condition)
  (format nil "Plugin ~a: ~a failed: ~a" owner what condition))

(defmacro reporting ((owner what errors) &body body)
  `(handler-case (progn ,@body)
     ;; Serious conditions too: a check that runs out of time signals SB-EXT:TIMEOUT.
     (serious-condition (c) (push (describe-error ,owner ,what c) ,errors) nil)))

(defun answer (effects errors)
  (json (list :obj :effects (reverse effects) :errors (reverse errors))))

(defun run-command (id file text cursor selection-start selection-end package)
  (let ((command (find id *commands* :key #'command-id :test #'string=))
        (*effects* '())
        (errors '()))
    (if (not command)
        (push (format nil "No plugin command is named ~a" id) errors)
        (let ((*package* (or (find-package package) (find-package "CL-USER"))))
          (reporting ((command-owner command) (format nil "command ~a" id) errors)
            (funcall (command-function command)
                     (make-context :file file :text text :cursor cursor :selection-start selection-start
                                   :selection-end selection-end :package package)))))
    (answer *effects* errors)))

(defun run-hooks (event &rest args)
  "Runs EVENT's hooks with ARGS, returning the messages of those that failed.
A :REPL-INPUT hook's answer becomes the next hook's input."
  (let ((errors '()))
    (dolist (h (remove event *hooks* :key #'hook-event :test-not #'eq))
      (reporting ((hook-owner h) (format nil "~(~s~) hook" event) errors)
        (let ((result (apply (hook-function h) args)))
          (when (eq event :repl-input)
            (cond ((eq result :handled) (return-from run-hooks (values (reverse errors) :handled)))
                  ((stringp result) (setf args (list result))))))))
    (values (reverse errors) (and (eq event :repl-input) (first args)))))

(defun report (errors)
  "Shows ERRORS from hooks that run inside Lisp in the REPL."
  (dolist (e errors) (format t "~&; ~a~%" e)))

(defun run-editor-hook (event &rest args)
  "Runs an event that happens in the editor, such as :BEFORE-SAVE, and answers
with the effects its hooks asked for."
  (let ((*effects* '()))
    (let ((errors (apply #'run-hooks (intern (string-upcase event) :keyword) args)))
      (answer *effects* errors))))

(defun run-checks (file text)
  "The notes of every plugin check on TEXT, each named after its check."
  (let ((notes '()) (errors '()))
    (dolist (c *checks*)
      (reporting ((check-owner c) (format nil "check ~(~a~)" (check-name c)) errors)
        (sb-ext:with-timeout 0.5
          (dolist (n (funcall (check-function c) file text))
            (push (list* :message (format nil "~a [~(~a~)]" (getf n :message) (check-name c)) n) notes)))))
    (dolist (e errors) (push (list :start 0 :end 0 :message e :severity :warning) notes))
    (nreverse notes)))

;;; Hooks on what happens inside Lisp.

(defun wrap (name function)
  (unless (sb-int:encapsulated-p name 'plugin-hooks)
    (sb-int:encapsulate name 'plugin-hooks function)))

(defmacro safely (&body body)
  "BODY, the hook-running part of a wrapper, whose own mistakes must not stop
the compile, load, REPL or debugger it wraps."
  `(handler-case (progn ,@body)
     (serious-condition (c) (format t "~&; ZenLisp plugin hooks failed: ~a~%" c) nil)))

(defvar *in-debugger-hook* nil)

(defun repl-input (string)
  "STRING as the :REPL-INPUT hooks leave it, or :HANDLED."
  (or (safely (multiple-value-bind (errors input) (run-hooks :repl-input string)
                (report errors)
                input))
      string))

(defun install-hooks ()
  (wrap 'swank-repl::repl-eval
        (lambda (f string)
          (let ((input (repl-input string)))
            (unless (eq input :handled)
              (prog1 (funcall f input)
                (safely (report (run-hooks :repl-result input /))))))))
  (wrap 'swank-mrepl::read-eval-print
        (lambda (f string)
          (let ((input (repl-input string)))
            (if (eq input :handled)
                ""
                (prog1 (funcall f input)
                  (safely (report (run-hooks :repl-result input /))))))))
  (wrap 'swank::debug-in-emacs
        (lambda (f condition)
          (unless *in-debugger-hook*
            (let ((*in-debugger-hook* t)) (safely (report (run-hooks :debugger-entered condition)))))
          (funcall f condition)))
  (wrap 'zenlisp:load-system
        (lambda (f name)
          (prog1 (funcall f name) (safely (report (run-hooks :after-load-system name))))))
  (wrap 'zenlisp::record-tests
        (lambda (f thunk)
          (let ((run (funcall f thunk))) (safely (report (run-hooks :tests-finished run))) run)))
  ;; Swank's compilation result is a list that starts with :COMPILATION-RESULT.
  (wrap 'swank:compile-file-for-emacs
        (lambda (f filename &rest args)
          (let ((result (apply f filename args)))
            (unless zenlisp::*checking*
              (safely (report (run-hooks :after-compile-file filename
                                         (and (consp result) (eq (first result) :compilation-result)
                                              (swank::compilation-result-successp result))))))
            result)))
  (pushnew 'run-checks zenlisp::*check-functions*))

;;; Loading.

(defun plugin-sources (dir)
  "The plugins in DIR as (NAME . PATH): each file.lisp, and each folder holding
init.lisp or an ASDF system named after the folder."
  (sort (append (loop for f in (directory (merge-pathnames "*.lisp" dir))
                      collect (cons (pathname-name f) f))
                (loop for d in (directory (merge-pathnames "*/" dir))
                      for name = (car (last (pathname-directory d)))
                      for asd = (merge-pathnames (make-pathname :name name :type "asd") d)
                      for init = (merge-pathnames "init.lisp" d)
                      when (probe-file asd) collect (cons name asd)
                      else when (probe-file init) collect (cons name init)))
        #'string< :key #'car))

(defun load-plugin (name path)
  (let ((plugin (make-plugin :name name :path path))
        (*loading* name)
        (*package* (find-package "CL-USER"))
        (*standard-output* (make-broadcast-stream)))
    (handler-case
        (handler-bind ((warning #'muffle-warning))
          (if (string-equal (pathname-type path) "asd")
              (progn (asdf:load-asd path)
                     (let ((ql (find-package "QL")))
                       (if ql (funcall (find-symbol "QUICKLOAD" ql) name :silent t) (asdf:load-system name))))
              (load path)))
      (error (c) (setf (plugin-error plugin) (princ-to-string c))))
    plugin))

(defun forget (owner)
  (setf *commands* (remove owner *commands* :key #'command-owner :test #'equal)
        *checks* (remove owner *checks* :key #'check-owner :test #'equal)
        *hooks* (remove owner *hooks* :key #'hook-owner :test #'equal)
        *setting-specs* (remove owner *setting-specs* :key #'setting-spec-owner :test #'equal)))

(defun load-plugins (dir)
  "Loads every plugin in DIR, replacing what earlier loads defined."
  (setf *directory* (uiop:ensure-directory-pathname dir))
  (ensure-directories-exist *directory*)
  (install-hooks)
  (dolist (p *plugins*) (forget (plugin-name p)))
  (read-setting-values)
  (setf *plugins* (loop for (name . path) in (plugin-sources *directory*) collect (load-plugin name path)))
  *plugins*)

(defun reload-plugins ()
  (when *directory* (load-plugins *directory*))
  (manifest))

(defun session-ready ()
  (sb-thread:make-thread (lambda () (report (run-hooks :session-ready (namestring *default-pathname-defaults*))))
                         :name "zenlisp plugin hooks"))
