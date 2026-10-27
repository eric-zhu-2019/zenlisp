;;;; insert-datetime.lisp: C-c t inserts the current date and time at the cursor.
;;;; Copy this file into ZParen's plugins folder (Settings ▸ Plugins ▸ Open
;;;; Plugins Folder), then click Reload Plugins.

(defpackage #:insert-datetime
  (:use #:cl)
  (:local-nicknames (#:zp #:zparen-plugin)))
(in-package #:insert-datetime)

(zp:define-setting style :type :choice :choices ("date and time" "date") :default "date and time"
                         :title "Insert" :doc "What C-c t inserts.")

(defun now ()
  (multiple-value-bind (s min h d m y) (get-decoded-time)
    (if (string= (zp:setting 'style) "date")
        (format nil "~d-~2,'0d-~2,'0d" y m d)
        (format nil "~d-~2,'0d-~2,'0d ~2,'0d:~2,'0d:~2,'0d" y m d h min s))))

(zp:define-command insert-datetime (context) (:title "Insert Date and Time" :emacs "C-c t")
  (zp:insert (now)))
