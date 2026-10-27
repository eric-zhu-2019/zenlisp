;;;; Tracing, profiling and disassembly, reported as data for the IDE's panels.

(in-package #:zparen)

(defun spec-name (spec)
  "SPEC printed so that reading it back in any package finds it again."
  (let ((*package* (find-package :keyword)))
    (prin1-to-string spec)))

(defun trace-report (&optional (limit 1000))
  "Traced specs and the latest LIMIT recorded calls as
(SPECS TOTAL ((ID PARENT SPEC ARGS VALUES DONE) ...))."
  (let* ((traces swank-trace-dialog::*traces*)
         (total (length traces))
         (start (max 0 (- total limit))))
    (list (mapcar #'spec-name (swank-trace-dialog:report-specs))
          total
          (loop for i from start below total
                for e = (aref traces i)
                for parent = (swank-trace-dialog::parent-of e)
                for done = (swank-trace-dialog::completed-p e)
                collect (list i
                              (and parent (swank-trace-dialog::id-of parent))
                              (spec-name (swank-trace-dialog::spec-of e))
                              (mapcar #'swank::to-line (swank-trace-dialog::args-of e))
                              (if done
                                  (mapcar #'swank::to-line
                                          (swank::ensure-list (swank-trace-dialog::retlist-of e)))
                                  '())
                              (and done t))))))

(defun toggle-trace (name)
  (swank-trace-dialog:dialog-toggle-trace (swank::from-string name)))

;;; A profile counts every frame on the sampled stacks, so the frames that
;;; were already running when profiling began (Swank's request loop, EVAL)
;;; would each show at 100%. They are left out, as is the IDE's own code.

(defparameter *hidden-packages* '("SWANK" "SWANK/BACKEND" "SWANK/SBCL" "SWANK-REPL" "SWANK/RPC" "ZPAREN"))

(defvar *outside-frames* '()
  "Names of the frames on the profiling thread's stack when profiling began.")

(defun frame-name (name)
  "NAME without the compiler's entry-point wrappers, as swank-sprof shows it.
Wrapper symbols are compared by name, since they vary between SBCL releases."
  (if (and (consp name) (symbolp (first name))
           (member (symbol-name (first name)) '("XEP" "TL-XEP" "&MORE-PROCESSOR" "TOP-LEVEL-FORM" "&OPTIONAL-PROCESSOR")
                   :test #'string=))
      (second name)
      name))

(defun hidden-node-p (node)
  (let* ((name (frame-name (sb-sprof::node-name node)))
         (sym (if (consp name) (find-if #'symbolp (rest name)) name)))
    (or (member name *outside-frames* :test #'equal)
        (and sym (symbolp sym) (symbol-package sym)
             (member (package-name (symbol-package sym)) *hidden-packages* :test #'string=)))))

(defun node-label (node)
  (let ((*package* (find-package :cl-user))
        (*print-right-margin* most-positive-fixnum))
    (prin1-to-string (frame-name (sb-sprof::node-name node)))))

(defun call-counts (node)
  "NODE's callees with the samples in which each was called from it."
  (loop for e in (sb-sprof::vertex-edges node)
        for v = (sb-sprof::edge-vertex e)
        when (and (typep v 'sb-sprof::node) (not (hidden-node-p v)))
          collect (list (node-label v) (sb-sprof::call-count e))))

(defun profile-report (&optional (limit 200))
  "The last profile as (:SAMPLES N :ROWS ((:NAME :SELF :TOTAL :CALLERS :CALLEES) ...)),
counting samples."
  (let ((graph (sb-sprof:report :type nil)))
    (if (null graph)
        (list :samples 0 :rows '())
        (let ((samples (sb-sprof::call-graph-nsamples graph))
              (nodes (sort (remove-if #'hidden-node-p (copy-list (sb-sprof::call-graph-flat-nodes graph)))
                           #'> :key #'sb-sprof::node-accrued-count)))
          (flet ((by-count (list) (sort list #'> :key #'second)))
            (list :samples samples
                  :rows (loop for n in nodes
                              for label = (node-label n)
                              repeat limit
                              collect (list :name label
                                            :self (sb-sprof::node-count n)
                                            ;; A recursive function is on a stack more than once.
                                            :total (min samples (sb-sprof::node-accrued-count n))
                                            :callers (by-count
                                                      (loop for c in (sb-sprof::node-callers n)
                                                            when (and (typep c 'sb-sprof::node) (not (hidden-node-p c)))
                                                              collect (list (node-label c)
                                                                            (or (second (assoc label (call-counts c) :test #'string=)) 0))))
                                            :callees (by-count (call-counts n))))))))))

(defun outside-frames ()
  (let ((names '()))
    (sb-debug:map-backtrace
     (lambda (frame) (push (frame-name (sb-di:debug-fun-name (sb-di:frame-debug-fun frame))) names)))
    names))

(defun start-profiling (&key (mode :cpu) (threads :all))
  (sb-sprof:reset)
  (setf *outside-frames* (outside-frames))
  (sb-sprof:start-profiling :mode mode :sample-interval 0.001 :max-samples 200000 :threads threads)
  t)

(defun stop-profiling ()
  (sb-sprof:stop-profiling)
  (profile-report))

(defun profile-form (string &optional (mode :cpu))
  "Runs the form in STRING under the statistical profiler, sampling this thread.
The form is compiled first, so the profile shows running it, not compiling it;
its function is named in this package, which profiles leave out."
  (let* ((form (swank::from-string string))
         (fun (compile nil `(sb-int:named-lambda profiled-form () ,form)))
         (start (get-internal-real-time))
         values)
    (start-profiling :mode mode :threads (list sb-thread:*current-thread*))
    (unwind-protect (setf values (multiple-value-list (funcall fun)))
      (sb-sprof:stop-profiling))
    (append (list :value (format nil "~{~s~^, ~}" values)
                  :seconds (/ (- (get-internal-real-time) start) (float internal-time-units-per-second)))
            (profile-report))))

(defun disassemble-name (string)
  "Disassembly of the function named in STRING, under any trace wrapping it."
  (let* ((name (swank::from-string string))
         (fun (cond ((and (symbolp name) (macro-function name)) (macro-function name))
                    ((fboundp name) (fdefinition name))
                    (t (error "~s is not a function." name)))))
    (loop for info = (sb-impl::encapsulation-info fun) while info
          do (setf fun (sb-impl::encapsulation-info-definition info)))
    (with-output-to-string (*standard-output*)
      (disassemble fun))))

(defun abort-requests (ids)
  "Unwinds the threads still answering the Swank requests IDS."
  (dolist (thread (sb-thread:list-all-threads))
    (when (and (not (eq thread sb-thread:*current-thread*))
               (intersection ids (sb-thread:symbol-value-in-thread 'swank::*pending-continuations* thread nil)))
      (ignore-errors (sb-thread:interrupt-thread thread (lambda () (abort)))))))
