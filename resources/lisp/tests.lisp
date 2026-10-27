;;;; Test runs as data: FiveAM, Parachute and Rove results recorded while a
;;;; system's tests run, reported as one tree for the IDE's test panel.
;;;;
;;;; Each framework's own entry point is wrapped to keep the result objects it
;;;; returns, so tests run exactly as ASDF's test-op runs them. The frameworks
;;;; usually load during that test-op, so the wrappers go on after each system
;;;; loads as well as before the run.

(in-package #:zparen)

(defvar *recording* nil
  "While tests run, the (FRAMEWORK . RESULT) captures made so far, newest first,
ending in :RECORDING so that it is true before the first capture.")

(defun framework-symbol (package name)
  (let ((p (find-package package)))
    (and p (find-symbol name p))))

(defvar *inside* nil "True inside a wrapped entry point marked :OUTERMOST.")

(defun wrap (symbol capture &key outermost)
  "Wraps the function named SYMBOL so a run calls CAPTURE with its values.
With OUTERMOST, calls made inside another such call are not captured."
  (when (and symbol (fboundp symbol) (not (sb-int:encapsulated-p symbol 'zparen-tests)))
    (sb-int:encapsulate symbol 'zparen-tests
                        (lambda (f &rest args)
                          (let* ((nested (and outermost *inside*))
                                 (values (let ((*inside* (or *inside* outermost)))
                                           (multiple-value-list (apply f args)))))
                            (when (and *recording* (not nested))
                              (funcall capture values))
                            (values-list values))))))

(defun install-capture ()
  (wrap (framework-symbol "FIVEAM" "RUN")
        (lambda (values) (push (cons :fiveam (first values)) *recording*)))
  (wrap (framework-symbol "PARACHUTE" "TEST")
        (lambda (values) (push (cons :parachute (first values)) *recording*)))
  ;; Rove's entry points call each other; the outermost call's results cover the run.
  (dolist (name '("RUN" "RUN-TESTS"))
    (wrap (framework-symbol "ROVE" name)
          (lambda (values) (when (listp (second values)) (push (cons :rove (second values)) *recording*)))
          :outermost t)))

(defmethod asdf:perform :after ((o asdf:load-op) (s asdf:system))
  (when *recording* (install-capture)))

(defun call (package name &rest args)
  (apply (framework-symbol package name) args))

(defun printed (object)
  (let ((*package* (find-package :keyword))
        (*print-length* 20)
        (*print-level* 6)
        (*print-right-margin* 100))
    (prin1-to-string object)))

(defvar *test-package* (find-package :cl-user)
  "The package of the test being reported, for printing its checks as written.")

(defun form (object)
  (let ((*package* *test-package*)
        (*print-length* 20)
        (*print-level* 6)
        (*print-right-margin* 100))
    (prin1-to-string object)))

(defmacro in-test-package ((name) &body body)
  `(let ((*test-package* (or (and (symbolp ,name) (symbol-package ,name)) *test-package*)))
     ,@body))

(defun test-id (name)
  "A readable name for running the test again, when it has one."
  (and name (symbolp name) (printed name)))

(defun line (object)
  (let ((*print-length* 20) (*print-level* 6))
    (princ-to-string object)))

(defun node (&key id framework name (kind :test) status message children)
  (list :id id :framework (string-downcase framework) :name name :kind kind
        :status status :message message :children children))

(defun rollup (children)
  (cond ((find :failed children :key (lambda (n) (getf n :status))) :failed)
        ((and children (every (lambda (n) (eq (getf n :status) :skipped)) children)) :skipped)
        (t :passed)))

(defun one-line (string)
  "STRING with each run of whitespace that holds a line break made one space."
  (with-output-to-string (out)
    (loop with i = 0
          while (< i (length string))
          do (let ((end (or (position-if-not (lambda (c) (member c '(#\Space #\Tab #\Newline))) string :start i)
                            (length string))))
               (cond ((and (> end i) (find #\Newline string :start i :end end))
                      (when (and (> i 0) (< end (length string))) (write-char #\Space out))
                      (setf i end))
                     (t (write-char (char string i) out) (incf i)))))))

;;; FiveAM: a run returns a flat list of check results, each naming its test.

(defun fiveam-check (r)
  (let ((failed (call "FIVEAM" "TEST-FAILURE-P" r))
        (skipped (call "FIVEAM" "TEST-SKIPPED-P" r))
        (expr (slot-value r (framework-symbol "FIVEAM" "TEST-EXPR"))))
    (node :framework :fiveam :kind :check
          ;; A test that signals has no check expression.
          :name (if expr (form expr) "error")
          :status (cond (failed :failed) (skipped :skipped) (t :passed))
          :message (and (or failed skipped)
                        (one-line (line (slot-value r (framework-symbol "FIVEAM" "REASON"))))))))

(defun fiveam-tree (results)
  (let ((tests '()) (order '()))
    (dolist (r results)
      (let ((test (slot-value r (framework-symbol "FIVEAM" "TEST-CASE"))))
        (unless (assoc test tests) (push test order) (push (list test) tests))
        (push r (cdr (assoc test tests)))))
    (let ((suites '()) (suite-order '()))
      (dolist (test (reverse order))
        (let* ((name (call "FIVEAM" "NAME" test))
               (checks (in-test-package (name) (mapcar #'fiveam-check (reverse (cdr (assoc test tests))))))
               (suite (slot-value test (framework-symbol "FIVEAM" "TEST-SUITE")))
               (suite (if (symbolp suite) suite (call "FIVEAM" "NAME" suite)))
               (n (node :id (test-id name) :framework :fiveam :name (symbol-name name)
                        :status (rollup checks)
                        ;; Passing checks only add noise to the tree.
                        :children (remove :passed checks :key (lambda (c) (getf c :status))))))
          (unless (assoc suite suites) (push suite suite-order) (push (list suite) suites))
          (push n (cdr (assoc suite suites)))))
      (loop for suite in (reverse suite-order)
            for kids = (reverse (cdr (assoc suite suites)))
            collect (node :id (test-id suite) :framework :fiveam :kind :suite
                          :name (if suite (symbol-name suite) "Tests")
                          :status (rollup kids) :children kids)))))

;;; Parachute: a report holds a result per test, with nested tests inside.

(defun parachute-node (r)
  (let* ((expression (call "PARACHUTE" "EXPRESSION" r))
         (status (call "PARACHUTE" "STATUS" r))
         (status (case status (:failed :failed) (:skipped :skipped) (t :passed))))
    (if (typep r (framework-symbol "PARACHUTE" "TEST-RESULT"))
        (let* ((name (call "PARACHUTE" "NAME" expression))
               (kids (in-test-package (name) (map 'list #'parachute-node (call "PARACHUTE" "RESULTS" r)))))
          (node :id (test-id name) :framework :parachute
                :name (line (call "PARACHUTE" "NAME" expression))
                :status status
                :children (remove-if (lambda (k) (and (eq (getf k :kind) :check) (eq (getf k :status) :passed))) kids)))
        (node :framework :parachute :kind :check :status status
              :name (form expression)
              :message (and (eq status :failed)
                            (let ((d (call "PARACHUTE" "DESCRIPTION" r)))
                              (if d (line d) (call "PARACHUTE" "FORMAT-RESULT" r :extensive))))))))

(defun parachute-tree (report)
  "The report lists every result, nested ones too; the tree starts from the
tests whose parent test is not in the report."
  (let* ((test-results (remove-if-not (lambda (r) (typep r (framework-symbol "PARACHUTE" "TEST-RESULT")))
                                      (coerce (call "PARACHUTE" "RESULTS" report) 'list)))
         (tests (mapcar (lambda (r) (call "PARACHUTE" "EXPRESSION" r)) test-results)))
    (loop for r in test-results
          for parent = (call "PARACHUTE" "PARENT" (call "PARACHUTE" "EXPRESSION" r))
          unless (member parent tests)
            collect (parachute-node r))))

;;; Rove: tests hold their passed and failed assertions and nested tests.

(defun rove-node (x)
  (let ((test-class (framework-symbol "ROVE/CORE/RESULT" "TEST"))
        (failed-class (framework-symbol "ROVE/CORE/RESULT" "FAILED"))
        (pending-class (framework-symbol "ROVE/CORE/RESULT" "PENDING")))
    (if (typep x test-class)
        (let* ((name (call "ROVE/CORE/RESULT" "TEST-NAME" x))
               (kids (in-test-package (name) (mapcar #'rove-node (append (call "ROVE/CORE/RESULT" "FAILED-TESTS" x)
                                                 (call "ROVE/CORE/RESULT" "PENDING-TESTS" x)
                                                 (remove-if-not (lambda (y) (typep y test-class))
                                                                (call "ROVE/CORE/RESULT" "PASSED-TESTS" x)))))))
          ;; Systems and TESTING blocks have string names: groups, not tests.
          (node :id (test-id name) :framework :rove :kind (if (symbolp name) :test :suite)
                :name (line name)
                :status (if (typep x failed-class) :failed (rollup kids))
                :children kids))
        (node :framework :rove :kind :check
              :name (form (call "ROVE/CORE/RESULT" "ASSERTION-FORM" x))
              :status (cond ((typep x failed-class) :failed) ((typep x pending-class) :skipped) (t :passed))
              :message (let ((reason (call "ROVE/CORE/RESULT" "ASSERTION-REASON" x)))
                         (line (or reason (call "ROVE/CORE/RESULT" "ASSERTION-DESCRIPTION" x))))))))

(defun rove-tree (results)
  (mapcar #'rove-node results))

(defun capture-tree (capture)
  (destructuring-bind (framework . result) capture
    (ecase framework
      (:fiveam (fiveam-tree result))
      (:parachute (parachute-tree result))
      (:rove (rove-tree result)))))

(defun count-tests (nodes)
  "Counts by status, as (PASSED FAILED SKIPPED), of the tests that hold no other tests."
  (let ((counts (list 0 0 0)))
    (labels ((kind (n) (getf n :kind))
             (walk (n)
               (when (and (eq (kind n) :test)
                          (notany (lambda (k) (eq (kind k) :test)) (getf n :children)))
                 (incf (nth (position (getf n :status) '(:passed :failed :skipped)) counts)))
               (mapc #'walk (getf n :children))))
      (mapc #'walk nodes))
    counts))

(defun record-tests (thunk)
  "Calls THUNK, returning the test tree of every framework run inside it."
  (install-capture)
  (let* ((start (get-internal-real-time))
         (captures (let ((*recording* (list :recording)))
                     (funcall thunk)
                     (butlast *recording*)))
         (seconds (/ (- (get-internal-real-time) start) (float internal-time-units-per-second))))
    (let ((tree (loop for c in (reverse captures) append (capture-tree c))))
      (destructuring-bind (passed failed skipped) (count-tests tree)
        (list :passed passed :failed failed :skipped skipped :seconds seconds
              :frameworks (remove-duplicates (mapcar (lambda (c) (string-downcase (car c))) (reverse captures)) :test #'string= :from-end t)
              :tests tree)))))

(defun failure-lines (nodes &optional path)
  "One line per failing check: the tests it is in, the check and why."
  (loop for n in nodes
        for here = (if (eq (getf n :kind) :check) path (append path (list (getf n :name))))
        when (eq (getf n :status) :failed)
          append (if (eq (getf n :kind) :check)
                     (list (format nil "~{~a~^ > ~}: ~a~@[ ~a~]" path (getf n :name) (getf n :message)))
                     (failure-lines (getf n :children) here))))

(defun run-system-tests (name)
  ;; ASDF rereads an .asd only when its write date changes, which it counts in
  ;; whole seconds, so an edit made just after loading it would go unseen.
  (let ((system (asdf:find-system name nil)))
    (when (and system (asdf:system-source-file system))
      (asdf:load-asd (asdf:system-source-file system))))
  (record-tests (lambda () (asdf:test-system name))))

(defun rerun-tests (tests)
  "Runs TESTS, a list of (FRAMEWORK NAME) with NAME as the tree printed it."
  (record-tests
   (lambda ()
     (loop for (framework name) in tests
           for test = (let ((*package* (find-package :keyword))) (read-from-string name))
           do (cond ((string-equal framework "fiveam") (call "FIVEAM" "RUN!" test))
                    ((string-equal framework "parachute") (call "PARACHUTE" "TEST" test))
                    ;; Rove's report of a failing test run alone breaks its default reporter.
                    ((string-equal framework "rove") (call "ROVE" "RUN-TESTS" (list test) :style :none)))))))
