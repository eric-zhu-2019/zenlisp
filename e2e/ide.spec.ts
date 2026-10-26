import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shots = (page: Page, name: string) => page.screenshot({ path: `e2e/.results/${name}.png` });

// Playwright's toHaveText collapses whitespace, so indentation checks read the exact text.
const activeLineText = (page: Page) => page.locator(".editor-host .cm-activeLine").evaluate((el) => el.textContent ?? "");

async function fresh(page: Page) {
  await page.goto("/");
  const welcome = page.getByText("A live Common Lisp workbench on SBCL.");
  await expect(welcome.or(page.locator(".workspace"))).toBeVisible();
  if (await page.locator(".workspace").isVisible()) {
    await page.keyboard.press("Meta+Shift+P");
    await page.getByPlaceholder("Type a command…").fill("Close Project");
    await expect(page.locator(".palette .item.selected")).toContainText("Close Project");
    await page.keyboard.press("Enter");
  }
  await expect(welcome).toBeVisible();
  // The getting-started list would cover controls the tests click; one test opens it on purpose.
  await page.evaluate(() => localStorage.setItem("zenlisp.tour", JSON.stringify({ done: [], dismissed: true })));
}

async function replEval(page: Page, form: string) {
  await page.getByTestId("repl-input").locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(form);
  await page.keyboard.press("Enter");
}

/** The text after the REPL's last prompt. */
const replInputText = (page: Page) =>
  page.evaluate(() => {
    const text = (window as unknown as { zenRepl: { state: { doc: { toString(): string } } } }).zenRepl.state.doc.toString();
    return text.slice(text.lastIndexOf("> ") + 2);
  });

test("new project, evaluate, debug and inspect", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await shots(page, "01-welcome");

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-demo");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  await expect(page.locator(".system .name").first()).toHaveText("zen-demo");
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await shots(page, "02-project");

  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-demo: done")).toBeVisible({ timeout: 60_000 });

  await page.locator(".cm-line", { hasText: "(format nil" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".cm-inline-result")).toHaveText(/ZEN-DEMO::GREET|GREET/);

  await replEval(page, '(zen-demo:greet "Lisp")');
  const result = page.locator(".presentation", { hasText: '"Hello, Lisp!"' });
  await expect(result).toBeVisible();
  await result.click({ modifiers: ["Meta"] });
  await expect(page.getByTestId("inspector-title")).toContainText("STRING");
  await expect(page.getByTestId("inspector-body")).toContainText("#\\H");
  await shots(page, "03-repl-inspector");

  await page.getByTestId("repl-input").locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("(length ");
  await result.click();
  await expect(page.locator(".repl-buffer .repl-ref")).toHaveText('"Hello, Lisp!"');
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".presentation", { hasText: /^12$/ }), "the clicked result is the object itself").toBeVisible();

  const repl = page.getByTestId("repl-input").locator(".cm-content");
  await repl.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("(defun twice (x)");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(* 2 x");
  await expect.poll(() => replInputText(page), {
    message: "Enter inside the form opens a line indented past the prompt, and parinfer keeps the closers at the end",
  }).toBe(`(defun twice (x)\n${" ".repeat("CL-USER> ".length + 2)}(* 2 x))`);
  await shots(page, "10-repl-multiline");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".presentation", { hasText: "TWICE" })).toBeVisible();
  await replEval(page, "(twice 21)");
  await expect(page.locator(".presentation", { hasText: /^42$/ })).toBeVisible();

  await expect(page.locator(".repl-buffer .cm-line", { hasText: "CL-USER> (twice 21)" }), "the prompt and input stay in the transcript").toBeVisible();
  await page.locator(".repl-buffer .cm-line", { hasText: "load zen-demo: done" }).click();
  await page.keyboard.type("(+ 2 3)");
  await expect.poll(() => replInputText(page), { message: "typing in the transcript goes to the prompt" }).toBe("(+ 2 3)");
  await page.keyboard.press("Enter");
  await expect(page.locator(".presentation", { hasText: /^5$/ })).toBeVisible();

  await replEval(page, "(read-line)");
  await expect.poll(() => replInputText(page), { message: "no prompt while Lisp reads a line" }).not.toContain("CL-USER");
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await expect(page.locator(".presentation", { hasText: '"hello there"' }), "the typed line is what read-line returns").toBeVisible();
  await expect(page.locator(".repl-buffer .cm-line", { hasText: /^hello there$/ }), "the answer stays in the transcript without a prompt").toBeVisible();
  await page.locator(".repl-buffer .cm-line", { hasText: "CL-USER> (twice 21)" }).click();
  await page.keyboard.press("Enter");
  await expect.poll(() => replInputText(page), { message: "Enter on an earlier input copies it to the prompt" }).toBe("(twice 21)");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await expect.poll(() => replInputText(page), { message: "select all and delete only clears the input" }).toBe("");

  await replEval(page, "(error \"broken ~a\" 42)");
  await expect(page.getByTestId("debugger")).toBeVisible();
  await expect(page.locator(".repl-condition", { hasText: "broken 42" })).toBeVisible();
  await shots(page, "04-debugger");
  await page.locator(".restart", { hasText: "ABORT" }).first().click();
  await expect(page.getByTestId("debugger")).toHaveCount(0);

  await replEval(page, "(step (zen-demo::main))");
  const stepper = page.getByTestId("stepper");
  await expect(stepper, "step opens the stepper, not an error").toContainText("(ZEN-DEMO:MAIN)");
  await page.keyboard.press("F7");
  await expect(stepper).toContainText('(GREET "world")');
  await expect(page.locator(".editor-host .cm-debug-form"), "the stepped call is marked in its file").toHaveText('(greet "world")');
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  await shots(page, "11-stepping");
  await page.keyboard.press("F7");
  // GREET's constant FORMAT compiles to no call, so the next stop is back in MAIN.
  await expect(stepper).toContainText("(WRITE-LINE (GREET");
  await expect(page.locator(".editor-host .cm-debug-form"), "the mark follows each step").toHaveText('(write-line (greet "world"))');
  await page.keyboard.press("F9");
  await expect(stepper).toHaveCount(0);
  await expect(page.locator(".repl-buffer .cm-line", { hasText: /^Hello, world!$/ }), "continue runs MAIN to the end").toBeVisible();
  await expect(page.locator(".editor-host .cm-debug-form"), "the mark goes when the stepper does").toHaveCount(0);
  await expect(page.locator(".repl-condition", { hasText: "STEP-FORM-CONDITION" }), "steps stay out of the transcript").toHaveCount(0);

  await replEval(page, '(defun fails () (error "nope"))');
  await expect(page.locator(".presentation", { hasText: /^FAILS$/ })).toBeVisible();
  await replEval(page, "(list (fails))");
  await page.locator(".frame-row .desc", { hasText: /^\(FAILS\)$/ }).click();
  await page.getByPlaceholder("Evaluate in this frame, or a value to return…").fill("42");
  await page.getByRole("button", { name: "Return value" }).click();
  await expect(page.locator(".repl-buffer .cm-line", { hasText: /^\(42\)$/ }), "the frame returned 42 in place of the error").toBeVisible();
  await expect(page.getByTestId("debugger")).toHaveCount(0);

  await replEval(page, '(error "in the repl")');
  await expect(page.getByTestId("debugger")).toContainText("in the repl");
  await replEval(page, '(sb-thread:make-thread (lambda () (error "in a worker")))');
  const threads = page.getByTestId("debugger-threads").locator(".dbg-thread");
  await expect(threads, "both stopped threads are listed").toHaveCount(2);
  await expect(page.locator(".dbg-head .cond")).toContainText("in a worker");
  await shots(page, "12-debugger-threads");
  await threads.filter({ hasText: "in the repl" }).click();
  await expect(page.locator(".dbg-head .cond"), "switching shows the other thread's error").toContainText("in the repl");
  await threads.filter({ hasText: "in a worker" }).click();
  await page.locator(".restart", { hasText: "ABORT" }).first().click();
  await expect(page.getByTestId("debugger-threads"), "the list goes once one thread is left").toHaveCount(0);
  await page.locator(".restart", { hasText: "ABORT" }).first().click();
  await expect(page.getByTestId("debugger")).toHaveCount(0);

  const clickGutter = async (text: string) => {
    const line = await page.locator(".editor-host .cm-line", { hasText: text }).boundingBox();
    const gutter = await page.locator(".editor-host .cm-breakpoint-gutter").boundingBox();
    await page.mouse.click(gutter!.x + gutter!.width / 2, line!.y + line!.height / 2);
  };
  const hello = page.locator(".repl-buffer .cm-line", { hasText: /^Hello, world!$/ });
  const hellos = await hello.count();
  await clickGutter("(write-line");
  await expect(page.locator(".editor-host .cm-breakpoint.bound"), "the breakpoint binds to MAIN's compiled code").toHaveCount(1);
  await replEval(page, "(zen-demo:main)");
  const stop = page.getByTestId("stepper");
  await expect(stop).toContainText("Breakpoint");
  await expect(stop).toContainText('(write-line (greet "world"))');
  await expect(page.locator(".editor-host .cm-debug-form"), "the stop is marked at the breakpoint's form").toHaveText('(write-line (greet "world"))');
  await shots(page, "13-breakpoint");
  await page.keyboard.press("F9");
  await expect(stop).toHaveCount(0);
  await expect(hello, "continuing runs MAIN to the end").toHaveCount(hellos + 1);
  await clickGutter("(write-line");
  await expect(page.locator(".editor-host .cm-breakpoint")).toHaveCount(0);
  await replEval(page, "(zen-demo:main)");
  await expect(hello, "a cleared breakpoint no longer stops").toHaveCount(hellos + 2);
  await expect(page.getByTestId("debugger")).toHaveCount(0);
});

test("assistant runs tools in the live image and its code can be inserted", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-chat");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });

  await page.getByTitle("AI assistant (⌘L)").click();
  await page.getByPlaceholder("Ask Claude…  ⏎ to send").fill("What is six times seven?");
  await page.keyboard.press("Enter");

  const tool = page.locator(".chat-tool");
  await expect(tool).toContainText("eval");
  await expect(tool.locator(".dot.ready")).toBeVisible();
  await tool.locator(".chat-tool-head").click();
  await expect(tool.locator(".chat-tool-body")).toContainText("42");
  await expect(page.locator(".chat-assistant strong")).toHaveText("42");
  await shots(page, "05-assistant");

  await page.locator(".chat-code").getByRole("button", { name: "Insert" }).click();
  await expect(page.locator(".cm-content").first()).toContainText("(defun answer () (* 6 7))");
  await page.locator(".chat-code").getByRole("button", { name: "Eval" }).click();
  await expect(page.locator(".repl-buffer .presentation", { hasText: "ANSWER" })).toBeVisible();

  await page.getByTitle("Assistant settings").click();
  await expect(page.locator(".chat-mcp pre")).toContainText("claude mcp add --transport http zenlisp");
});

test("vim editing with parinfer, completion, arglists, notes and definitions", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-edit");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-edit: done")).toBeVisible({ timeout: 60_000 });

  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".statusbar .mode")).toHaveText("normal");
  await page.keyboard.type("Go");
  await expect(page.locator(".statusbar .mode")).toHaveText("insert");

  await page.keyboard.type("(defun twice (x");
  await expect(page.locator(".editor-host .cm-line").last()).toHaveText("(defun twice (x))");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(mapcar ");
  await expect(page.locator(".statusbar .hint")).toContainText("function list &rest more-lists");
  await expect(page.locator(".statusbar .hint .active")).toHaveText("function");

  await page.keyboard.type("#'1+ (list x x)) (multiple-value-b");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("multiple-value-bind");
  await page.keyboard.press("Escape");
  await shots(page, "06-editing");

  await page.keyboard.press("Escape");
  await page.keyboard.type("o");
  await page.keyboard.type("(defun oops () undefined-thing");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.locator(".editor-host .cm-lintRange-warning")).toBeVisible();

  await page.locator(".editor-host .cm-line", { hasText: "(mapcar" }).getByText("mapcar").hover();
  await expect(page.locator(".cm-lisp-doc")).toContainText("Apply FUNCTION to successive");
  await page.mouse.move(5, 5);
  await page.locator(".editor-host .cm-line", { hasText: '(write-line (greet "world"))' }).getByText("greet").hover();
  await expect(page.locator(".cm-lisp-doc")).toContainText("(greet name)");
  await page.mouse.move(5, 5);

  await page.locator(".editor-host .cm-content").click();
  const docBefore = await page.locator(".editor-host .cm-content").innerText();
  await page.keyboard.press("Meta+Shift+/");
  await shots(page, "14-shortcuts");
  await page.emulateMedia({ colorScheme: "dark" });
  await shots(page, "14-shortcuts-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByPlaceholder("Filter").fill("slurp");
  await expect(page.locator(".help-body tbody tr")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".help")).toHaveCount(0);
  expect(await page.locator(".editor-host .cm-content").innerText(), "opening help leaves the buffer alone").toBe(docBefore);

  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(a b) c");
  await expect(page.locator(".editor-host .cm-activeLine"), "keys reach the editor after help closes").toHaveText("(a b) c");
  await page.keyboard.press("Escape");
  await expect(page.locator(".statusbar .mode"), "Escape leaves insert mode").toHaveText("normal");
  await page.keyboard.type("0l");
  await page.keyboard.press("Control+)");
  await expect(page.locator(".editor-host .cm-activeLine")).toHaveText("(a b c)");
  await page.keyboard.type("u");
  await expect(page.locator(".editor-host .cm-activeLine")).toHaveText("(a b) c");

  await page.keyboard.type("Go");
  await page.keyboard.type("(x (y z))");
  await page.keyboard.press("Escape");
  await page.keyboard.type("0fy");
  // A real Mac sends ⌥R as the composed ® with the R key code.
  await page.evaluate(() =>
    document
      .querySelector(".editor-host .cm-content")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "®", code: "KeyR", keyCode: 82, altKey: true, bubbles: true, cancelable: true })),
  );
  await expect(page.locator(".editor-host .cm-activeLine"), "⌥R raises in normal mode").toHaveText("(x y)");

  await page.keyboard.type("Go");
  await page.keyboard.type("(let ((a 1))");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a");
  await expect.poll(() => activeLineText(page), { message: "let body indents two spaces" }).toBe("  a)");
  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(when t");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(print 1)");
  await page.keyboard.press("Escape");
  await page.keyboard.type(">>>>");
  await expect.poll(() => activeLineText(page)).toBe("      (print 1))");
  await page.keyboard.press("Meta+Alt+l");
  await expect.poll(() => activeLineText(page), { message: "reindent pulls the body back under when" }).toBe("  (print 1))");

  await page.locator(".editor-host .cm-line", { hasText: "(defun greet (name)" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type(",e");
  await expect(page.locator(".editor-host .cm-inline-result")).toContainText("GREET");

  await page.keyboard.type("gg");
  await page.keyboard.type("/");
  await expect(page.locator(".cm-vim-panel")).toBeVisible();
  await expect(page.locator(".cm-vim-panel").getByText(/regexp/), "no regex-flavour label, as in Vim").toBeHidden();
  await page.keyboard.type("\\v<(greet|main)>");
  await page.keyboard.press("Enter");
  await expect(page.locator(".editor-host .cm-activeLine"), "very magic alternation and word boundaries").toContainText("(defun greet (name)");
  await page.keyboard.type("n");
  await expect(page.locator(".editor-host .cm-activeLine")).toContainText("(defun main ()");
  await expect(page.locator(".editor-host .cm-searchMatch"), "matches stay highlighted, as with hlsearch").toHaveCount(3);
  await shots(page, "09-vim-search");
  await page.keyboard.type("gg/gr\\(ee\\)t\\ze \"");
  await page.keyboard.press("Enter");
  await expect(page.locator(".editor-host .cm-activeLine"), "magic groups and \\ze").toContainText('(greet "world")');
  await page.keyboard.type(":noh");
  await page.keyboard.press("Enter");

  await page.keyboard.type("Go");
  await page.keyboard.type("(list (+ 1 2) (* 2 3))");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("chord"), "the pending prefix shows, as in Emacs").toHaveText("C-x-");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".editor-host .cm-inline-result").last(), "C-x C-e on the closing paren").toContainText("(3 6)");
  await page.keyboard.type("F3");
  await page.keyboard.press("Control+x");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".editor-host .cm-inline-result", { hasText: /^⇒ 3$/ }), "C-x C-e evaluates the expression before point").toBeVisible();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+g");
  await expect(page.getByTestId("chord")).toHaveCount(0);
  await page.keyboard.press("Control+Alt+x");
  await expect(page.locator(".editor-host .cm-inline-result").last(), "C-M-x evaluates the top-level form").toContainText("(3 6)");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("repl-input").locator(".cm-content"), "C-c C-z switches to the REPL").toBeFocused();
  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.press("Escape");

  await page.locator(".cm-line", { hasText: '(write-line (greet "world"))' }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("0fg");
  await page.keyboard.type("gd");
  await expect(page.locator(".editor-host .cm-activeLine")).toContainText("(defun greet (name)");
});

test("file tree creates and renames files, guards unsaved work and follows the disk", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-files");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  const root = join(parent, "zen-files");
  const tree = page.getByTestId("file-tree");

  await page.getByTitle("New file").click();
  await page.locator(".tree-input").fill("util.lisp");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toHaveText(/util\.lisp/);
  await expect(tree.getByText("util.lisp")).toBeVisible();

  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.type("i(defun helper () 1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+w");
  await expect(page.getByRole("alertdialog")).toContainText("Save changes to util.lisp?");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".tab", { hasText: "util.lisp" })).toHaveCount(0);
  expect(readFileSync(join(root, "util.lisp"), "utf8")).toContain("(defun helper () 1)");

  // A clean buffer follows the disk; a dirty one asks.
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  writeFileSync(join(root, "src/main.lisp"), "(in-package #:zen-files)\n\n(defun changed-elsewhere () t)\n");
  await expect(page.locator(".editor-host .cm-content")).toContainText("changed-elsewhere");
  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.type("Goo(local-edit)");
  await page.keyboard.press("Escape");
  writeFileSync(join(root, "src/main.lisp"), "(in-package #:zen-files)\n\n(defun changed-again () t)\n");
  await expect(page.locator(".conflict-banner")).toContainText("changed on disk");
  await page.getByRole("button", { name: "Reload from disk" }).click();
  await expect(page.locator(".editor-host .cm-content")).toContainText("changed-again");
  await expect(page.locator(".conflict-banner")).toHaveCount(0);

  await tree.getByText("util.lisp").click({ button: "right" });
  await page.getByRole("button", { name: "Rename…" }).click();
  await page.locator(".tree-input").fill("helpers.lisp");
  await page.keyboard.press("Enter");
  await expect(tree.getByText("helpers.lisp")).toBeVisible();
  await expect(tree.getByText("util.lisp")).toHaveCount(0);
  expect(existsSync(join(root, "helpers.lisp"))).toBe(true);
  await shots(page, "07-files");
});

test("search, replace, outline, back and forward, and the problems panel", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-nav");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const root = join(parent, "zen-nav");
  const activeLine = page.locator(".editor-host .cm-activeLine");

  await page.keyboard.press("Meta+Shift+F");
  await page.getByPlaceholder("Search project").fill("greet");
  const results = page.getByTestId("search-results");
  await expect(page.locator(".search-summary")).toContainText("results in");
  await results.locator(".search-line", { hasText: '(write-line (greet "world"))' }).click();
  await expect(activeLine).toContainText('(write-line (greet "world"))');

  await page.keyboard.press("Control+o");
  await expect(activeLine).toContainText("(in-package #:zen-nav)");
  await page.keyboard.press("Control+Shift+O");
  await expect(activeLine).toContainText('(write-line (greet "world"))');

  await page.keyboard.press("Meta+Shift+O");
  await expect(page.locator(".palette .item")).toHaveCount(2);
  await page.getByPlaceholder("Go to definition in file…").fill("greet");
  await page.keyboard.press("Enter");
  await expect(activeLine).toContainText("(defun greet (name)");

  await page.getByTitle("Toggle replace").click();
  await page.getByPlaceholder("Search project").fill('"world"');
  await page.getByPlaceholder("Replace").fill('"Lisp"');
  await page.getByRole("button", { name: "All" }).click();
  await expect(page.locator(".editor-host .cm-content")).toContainText('(greet "Lisp")');
  expect(readFileSync(join(root, "src/main.lisp"), "utf8")).toContain('(greet "Lisp")');

  writeFileSync(join(root, "src/oops.lisp"), "(in-package #:zen-nav)\n\n(defun oops () undefined-thing)\n");
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByTestId("file-tree").getByText("src").click();
  await page.getByTestId("file-tree").getByText("oops.lisp").click();
  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-nav: done")).toBeVisible({ timeout: 60_000 });
  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.press("Meta+b");
  const problems = page.getByTestId("problems");
  await expect(problems).toContainText("undefined variable");
  await page.keyboard.press("Control+o");
  await problems.locator(".problem").first().click();
  await expect(activeLine).toContainText("undefined-thing");
  await shots(page, "08-navigation");
});

test("trace calls, step through macros, disassemble and profile", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-tools");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-tools: done")).toBeVisible({ timeout: 60_000 });
  const editor = page.locator(".editor-host");

  await editor.locator(".cm-line", { hasText: '(write-line (greet "world"))' }).getByText("greet").click();
  await page.keyboard.press("Meta+Alt+t");
  await expect(editor.locator(".cm-inline-result")).toHaveText("⇒ tracing GREET");
  const trace = page.getByTestId("trace");
  await expect(trace.locator(".chip")).toHaveText("GREET");
  await page.locator(".panel-tab", { hasText: "REPL" }).click();
  await replEval(page, "(zen-tools:main)");
  await page.locator(".panel-tab", { hasText: "Trace" }).click();
  await expect(trace.locator(".trace-call")).toHaveText('GREET("world")⇒"Hello, world!"');
  await shots(page, "15-trace");
  await trace.locator(".trace-call .value", { hasText: '"world"' }).click();
  await expect(page.getByTestId("inspector-title")).toContainText("SIMPLE-ARRAY CHARACTER (5)");
  await trace.getByTitle("Stop tracing GREET").click();
  await expect(trace).toContainText("Nothing traced");

  await page.keyboard.press("Escape");
  await editor.locator(".cm-line", { hasText: "(defun main ()" }).getByText("defun").click();
  await page.keyboard.press("Meta+Shift+M");
  const step = editor.locator(".cm-macrostep");
  await expect(step.locator(".cm-macrostep-body")).toContainText("SB-IMPL::%DEFUN");
  const before = await step.locator(".cm-macrostep-body").innerText();
  await step.locator(".cm-macro", { hasText: "NAMED-LAMBDA" }).click();
  await expect(step.getByRole("button", { name: "Step back" })).toBeEnabled();
  expect(await step.locator(".cm-macrostep-body").innerText(), "the inner macro expanded in place").not.toBe(before);
  await shots(page, "16-macrostep");
  await step.getByRole("button", { name: "Step back" }).click();
  expect(await step.locator(".cm-macrostep-body").innerText()).toBe(before);

  await page.keyboard.press("Escape");
  await editor.locator(".cm-line", { hasText: "(defun greet (name)" }).getByText("greet").click();
  await page.keyboard.type(",d");
  await expect(editor.locator(".cm-inline-code")).toContainText("disassembly for ZEN-TOOLS:GREET");

  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type('(loop repeat 300000 sum (length (greet "x")))');
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Alt+p");
  const profile = page.getByTestId("profile");
  await expect(profile.locator(".summary")).toContainText("samples", { timeout: 30_000 });
  await expect(profile.locator(".summary")).toContainText("⇒ 2700000");
  const greetRow = profile.locator(".profile-table tbody tr", { hasText: /%ZEN-TOOLS:GREET$/ });
  await expect(greetRow).toHaveCount(1);
  await greetRow.click();
  await expect(profile.locator(".profile-detail")).toContainText("Calls");
  await shots(page, "17-profile");
});

test("test results as a tree, jump to a test, rerun what failed", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-test");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const root = join(parent, "zen-test");
  const asd = readFileSync(join(root, "zen-test.asd"), "utf8")
    .replace(':depends-on ("zen-test")', ':depends-on ("zen-test" "fiveam")')
    .replace("(symbol-call :zen-test/tests :run)", '(symbol-call :fiveam :run! (find-symbol "ALL" "ZEN-TEST/TESTS"))');
  writeFileSync(join(root, "zen-test.asd"), asd);
  writeFileSync(
    join(root, "tests/main.lisp"),
    `(defpackage #:zen-test/tests
  (:use #:cl #:fiveam))

(in-package #:zen-test/tests)

(def-suite all)
(in-suite all)

(test greets
  (is (string= "Hello, Lisp!" (zen-test:greet "Lisp"))))

(test greets-plainly
  (is (string= "Hello, Lisp" (zen-test:greet "Lisp"))))
`,
  );

  await page.keyboard.press("Meta+u");
  const tests = page.getByTestId("tests");
  await expect(tests.locator(".summary")).toContainText("1 passed1 failed", { timeout: 60_000 });
  await expect(page.locator(".panel-tab", { hasText: "Tests" }).locator(".count-badge")).toHaveText("1");
  await expect(tests.locator(".test-row.suite .name")).toHaveText("ALL");
  await expect(tests.locator(".test-check.failed code")).toHaveText('(STRING= "Hello, Lisp" (ZEN-TEST:GREET "Lisp"))');
  await shots(page, "18-tests");

  await tests.getByRole("button", { name: "GREETS-PLAINLY" }).click();
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  await expect(page.locator(".editor-host .cm-activeLine")).toContainText("(test greets-plainly");

  await page.locator(".panel-tab", { hasText: "REPL" }).click();
  await replEval(page, '(defun zen-test::greet (name) (format nil "Hello, ~a" name))');
  await page.locator(".panel-tab", { hasText: "Tests" }).click();
  await tests.getByRole("button", { name: "Rerun failed" }).click();
  await expect(tests.locator(".summary")).toContainText("1 passed");
  await expect(tests.locator(".summary")).not.toContainText("failed");
  await expect(tests.locator(".test-row .name")).toHaveText(["ALL", "GREETS-PLAINLY"]);
});

test("history search, a second REPL while the first is busy, and a long transcript", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-repl");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const repl = page.locator(".repl-buffer");

  await replEval(page, "(defun zz-sq (x) (* x x))");
  await replEval(page, "(zz-sq 7)");
  await expect(repl.locator(".presentation", { hasText: /^49$/ })).toHaveCount(1);
  await page.keyboard.press("Control+r");
  const search = page.getByTestId("history-search");
  await page.keyboard.type("sq 7");
  await expect(search.locator("li")).toHaveText(["(zz-sq 7)"]);
  await shots(page, "19-history-search");
  await page.keyboard.press("Meta+Enter");
  await expect(search).toHaveCount(0);
  await expect(repl.locator(".presentation", { hasText: /^49$/ }), "the found input ran").toHaveCount(2);

  await replEval(page, "(progn (sleep 4) :slept)");
  await page.getByTitle("New REPL, in a thread of its own").click();
  await expect(page.locator(".repl-tab.active")).toHaveText("REPL 2");
  await replEval(page, "(list (zz-sq 6) (sb-thread:thread-name sb-thread:*current-thread*))");
  await expect(repl, "the second REPL answers while the first sleeps").toContainText('(36 "mrepl thread")', { timeout: 3000 });
  await replEval(page, "(read-line)");
  await page.keyboard.type("typed here");
  await page.keyboard.press("Enter");
  await expect(repl).toContainText('"typed here"');
  await shots(page, "20-second-repl");
  await page.locator(".repl-tab", { hasText: "Main" }).click();
  await expect(repl).toContainText(":SLEPT", { timeout: 10_000 });
  await page.getByTitle("Close REPL 2 and end its thread").click();
  await expect(page.locator(".repl-tabs")).toHaveCount(0);

  const started = Date.now();
  await replEval(page, '(dotimes (i 420000) (write-line "0123456789"))');
  await expect(repl.locator(".presentation", { hasText: /^NIL$/ })).toBeVisible({ timeout: 90_000 });
  const doc = await page.evaluate(() => {
    const d = (window as unknown as { zenRepl: { state: { doc: { length: number; sliceString(a: number, b: number): string } } } }).zenRepl.state.doc;
    return { length: d.length, head: d.sliceString(0, 51) };
  });
  console.log(`4.6 MB of output shown in ${Date.now() - started} ms; the buffer keeps ${doc.length} characters`);
  expect(doc.length, "old output is dropped").toBeLessThan(4_200_000);
  expect(doc.head).toBe("; Earlier output was dropped to keep the REPL fast.");
  await replEval(page, "(zz-sq 3)");
  await expect(repl.locator(".presentation", { hasText: /^9$/ }), "the REPL still answers").toBeVisible();
});

test("documentation that follows the cursor, HyperSpec pages, and apropos", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-docs");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-docs: done")).toBeVisible({ timeout: 60_000 });
  const editor = page.locator(".editor-host");
  const docs = page.getByTestId("docs");

  await editor.locator(".cm-line", { hasText: "(format nil" }).getByText("format").click();
  await page.keyboard.press("Meta+Shift+D");
  await expect(docs.getByTestId("docs-symbol")).toHaveText("format");
  await expect(docs.locator(".docs-arglist")).toContainText("control-string");
  const spec = page.frameLocator("[data-testid=hyperspec]");
  await expect(spec.locator("h1")).toHaveText("FORMAT");
  await shots(page, "21-docs-hyperspec");
  await spec.getByRole("link", { name: "WRITE-LINE" }).click();
  await expect(spec.locator("h1"), "HyperSpec links work inside the panel").toHaveText("WRITE-LINE");

  await editor.locator(".cm-line", { hasText: "(write-line" }).getByText("write-line").click();
  await expect(docs.getByTestId("docs-symbol"), "the panel follows the cursor").toHaveText("write-line");

  await docs.getByPlaceholder("Search symbols in every package").fill("greet");
  await docs.getByTestId("apropos").locator("li", { hasText: "zen-docs:greet" }).click();
  await expect(docs.getByTestId("docs-symbol")).toHaveText("zen-docs:greet");
  await expect(docs.locator(".docs-arglist")).toContainText("(greet name)");
  await expect(docs.locator("[data-testid=hyperspec]"), "only Common Lisp symbols have HyperSpec pages").toHaveCount(0);
  await docs.getByTitle("Back").click();
  await expect(docs.getByTestId("docs-symbol")).toHaveText("write-line");

  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Type a command…").fill("Getting Started");
  await page.keyboard.press("Enter");
  const tour = page.getByTestId("tour");
  await expect(tour.locator("li.done .tour-title")).toHaveText(["Open or create a project", "Look something up"]);
  await expect(tour.locator("li.next .tour-title")).toHaveText("Evaluate a form");
  await editor.locator(".cm-line", { hasText: "(write-line" }).click();
  await page.keyboard.press("Meta+Enter");
  await expect(tour.locator("li.next .tour-title"), "steps check off as they are done").toHaveText("Use the REPL");
  await shots(page, "22-getting-started");
  await tour.getByTitle("Close the list").click();
  await expect(tour).toHaveCount(0);
});

test("add and remove a dependency from the systems list", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-deps");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const asd = join(parent, "zen-deps", "zen-deps.asd");
  const system = page.locator(".system", { has: page.locator(".name", { hasText: /^zen-deps$/ }) });

  await system.getByTitle("Add a dependency to zen-deps").click();
  await page.getByPlaceholder("Add a dependency to zen-deps…").fill("split-seq");
  const results = page.getByTestId("dependency-results");
  await expect(results.locator(".item").first()).toContainText("split-sequence");
  await shots(page, "23-add-dependency");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("output")).toContainText("fetch split-sequence · finished", { timeout: 60_000 });
  expect(readFileSync(asd, "utf8")).toContain(':depends-on ("split-sequence")');
  await expect(system.locator(".dep", { hasText: "split-sequence" })).toBeVisible();

  await system.locator(".dep", { hasText: "split-sequence" }).hover();
  await system.getByTitle("Remove split-sequence from zen-deps's dependencies").click();
  await expect(system.locator(".dep", { hasText: "split-sequence" })).toHaveCount(0);
  expect(readFileSync(asd, "utf8")).toContain(":depends-on ()");
});

test("settings change the editor at once and Lisp when it restarts", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-set");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const settings = page.getByTestId("settings");

  await page.keyboard.press("Meta+,");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Larger" }).click();
  await expect(settings).toContainText("14 pt");
  await settings.getByRole("button", { name: "Match System" }).click();

  const fontOf = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
  await settings.getByRole("combobox", { name: "Editor font" }).selectOption("Courier New");
  expect(await fontOf(".editor-host .cm-content"), "the editor takes the font at once").toMatch(/^"?Courier New/);
  expect(await fontOf("[data-testid=editor-font-sample]")).toMatch(/^"?Courier New/);
  await settings.getByRole("combobox", { name: "Interface font" }).selectOption("Other…");
  await settings.getByRole("textbox", { name: "Interface font name" }).fill("Avenir Next");
  await page.keyboard.press("Enter");
  expect(await fontOf("body"), "a typed family applies to the interface").toMatch(/^"?Avenir Next/);
  await settings.getByRole("textbox", { name: "Interface font name" }).fill("No Such Font");
  await page.keyboard.press("Enter");
  await expect(settings).toContainText("This Mac has no font named No Such Font");
  await shots(page, "23-settings-fonts");
  await settings.getByRole("button", { name: "Done" }).click();
  await page.locator(".editor-host .cm-line", { hasText: "(defun greet" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("$");
  const gap = () =>
    page.evaluate(() => {
      const line = document.querySelector(".editor-host .cm-activeLine")!;
      const range = document.createRange();
      range.selectNodeContents(line);
      const cursor = document.querySelector(".editor-host .cm-fat-cursor")!.getBoundingClientRect();
      return Math.abs(cursor.right - range.getBoundingClientRect().right);
    });
  await expect.poll(gap, { message: "the cursor sits on the last character in the new font's widths" }).toBeLessThan(2);
  await page.keyboard.press("Meta+,");
  await settings.getByRole("combobox", { name: "Editor font" }).selectOption("");
  await settings.getByRole("combobox", { name: "Interface font" }).selectOption("");
  expect(await fontOf("body")).toMatch(/-apple-system/);

  await settings.getByRole("button", { name: "Lisp", exact: true }).click();
  await expect(settings).toContainText("Using /");
  await shots(page, "24-settings-lisp");
  await settings.getByRole("switch", { name: "Compile for debugging" }).uncheck();
  await settings.getByRole("button", { name: "Restart Lisp" }).click();
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await replEval(page, "(list :debug (cdr (assoc 'debug (sb-ext:restrict-compiler-policy))))");
  // Highlighting splits a result of several tokens across elements, so read the buffer's text.
  await expect(page.locator(".repl-buffer"), "development code is no longer forced to debug 3").toContainText("(:DEBUG NIL)");

  await page.keyboard.press("Meta+,");
  await settings.getByRole("button", { name: "Lisp", exact: true }).click();
  await settings.getByRole("switch", { name: "Compile for debugging" }).check();
  await settings.getByRole("button", { name: "Restart Lisp" }).click();
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await replEval(page, "(list :debug (cdr (assoc 'debug (sb-ext:restrict-compiler-policy))))");
  await expect(page.locator(".repl-buffer")).toContainText("(:DEBUG 3)");

  await replEval(page, '(progn (format sb-sys:*stderr* "going down~%") (finish-output sb-sys:*stderr*) (sb-ext:exit :code 7 :abort t))');
  const banner = page.getByTestId("session-banner");
  await expect(banner.locator(".session-banner-why")).toHaveText("Lisp exited with code 7.");
  await banner.getByRole("button", { name: "Show output" }).click();
  await expect(banner.locator(".session-banner-output")).toContainText("going down");
  await shots(page, "25-lisp-stopped");
  await banner.getByRole("button", { name: "Restart Lisp" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
});

test("split the editor, edit one file in two panes, and drag tabs between them", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-split");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  const left = page.getByTestId("pane-0");
  const right = page.getByTestId("pane-1");

  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.press("Meta+\\");
  await expect(right.locator(".tab.active")).toHaveText(/main\.lisp/);
  await right.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(defun shared ()");
  await page.keyboard.press("Escape");
  await expect(left.locator(".cm-content"), "an edit in one pane shows in the other").toContainText("(defun shared ())");

  await page.getByTestId("file-tree").getByText("src").click();
  await page.getByTestId("file-tree").getByText("package.lisp").click();
  await expect(right.locator(".tab")).toHaveText([/main\.lisp/, /package\.lisp/]);
  await expect(left.locator(".tab")).toHaveText([/main\.lisp/]);
  await shots(page, "26-split-panes");

  await right.locator(".tab", { hasText: "package.lisp" }).dragTo(left.locator(".tab", { hasText: "main.lisp" }));
  await expect(left.locator(".tab"), "the tab moved before the one it was dropped on").toHaveText([/package\.lisp/, /main\.lisp/]);
  await expect(right.locator(".tab")).toHaveText([/main\.lisp/]);

  await right.locator(".tab", { hasText: "main.lisp" }).locator(".close").click();
  await expect(right, "closing a pane's last file closes the pane").toHaveCount(0);
  await expect(left.locator(".tab")).toHaveText([/package\.lisp/, /main\.lisp/]);
});

test("git change markers, the inline diff with revert, and status in the file tree", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-git");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".tab.active")).toHaveText(/main\.lisp/);
  const root = join(parent, "zen-git");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "first");
  // Commits happen outside ZenLisp; coming back to the window looks again.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const editor = page.locator(".editor-host");

  await editor.locator(".cm-line", { hasText: '(format nil "Hello, ~a!" name)' }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(' "again"))');
  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(defun extra ()");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".cm-git-changed")).toHaveCount(1);
  await expect(editor.locator(".cm-git-added")).toHaveCount(1);

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("file-tree").locator(".tree-row", { hasText: "src" }).locator(".git-mark")).toHaveText("•");
  await page.getByTestId("file-tree").getByText("src").click();
  await expect(page.getByTestId("file-tree").locator(".tree-row", { hasText: "main.lisp" }).locator(".git-mark")).toHaveText("M");

  await editor.locator(".cm-git-changed").click();
  await expect(editor.locator(".cm-deletedChunk").first(), "the committed line shows above its change").toContainText('(format nil "Hello, ~a!" name))');
  await shots(page, "27-git-diff");
  await editor.locator(".cm-git-revert").first().click();
  await expect(editor.locator(".cm-content")).toContainText('(format nil "Hello, ~a!" name))');
  await expect(editor.locator(".cm-content")).not.toContainText('"again"');
});

// Last, since it points Lisp at a missing sbcl for a while.
test("without SBCL the first screen says how to get it", async ({ page }) => {
  await fresh(page);
  const sbcl = execFileSync("/bin/sh", ["-c", "command -v sbcl"]).toString().trim();
  await page.keyboard.press("Meta+,");
  const settings = page.getByTestId("settings");
  await settings.getByRole("button", { name: "Lisp", exact: true }).click();
  const path = settings.getByPlaceholder("Find it on PATH and in Homebrew");
  await path.fill("/nonexistent/sbcl");
  await path.blur();
  await expect(settings).toContainText("No sbcl found.");
  await settings.getByRole("button", { name: "Done" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const card = page.getByTestId("need-sbcl");
  await expect(card).toContainText("ZenLisp needs SBCL");
  await expect(card.getByRole("button", { name: "Install with Homebrew" })).toBeVisible();
  await shots(page, "28-need-sbcl");
  page.once("dialog", (d) => d.accept(sbcl));
  await card.getByRole("button", { name: "Choose sbcl…" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("A live Common Lisp workbench on SBCL.")).toBeVisible();

  await page.keyboard.press("Meta+,");
  await settings.getByRole("button", { name: "Lisp", exact: true }).click();
  await expect(settings).toContainText(`Using ${sbcl}.`);
  await path.fill("");
  await path.blur();
  await expect(settings).toContainText("Using ");
});

test("go to definitions Lisp has not loaded, and see warnings as you type", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-live");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  const editor = page.locator(".editor-host");
  const activeLine = editor.locator(".cm-activeLine");

  await editor.locator(".cm-line", { hasText: '(write-line (greet "world"))' }).getByText("greet").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("gd");
  await expect(activeLine, "gd finds a definition in code that is not loaded").toContainText("(defun greet (name)");
  await page.getByTestId("file-tree").getByText("src").click();
  await page.getByTestId("file-tree").getByText("package.lisp").click();
  await editor.locator(".cm-line", { hasText: ":export" }).getByText("greet").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("gd");
  await expect(page.locator(".tab.active"), "and in another file").toHaveText(/main\.lisp/);
  await expect(activeLine).toContainText("(defun greet (name)");
  await editor.locator(".cm-line", { hasText: "(defun greet" }).getByText("name").first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("gd");
  await expect(editor.locator(".cm-inline-error"), "a symbol nothing defines says so where it is").toHaveText("no definition of name found");

  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(defun shout (s) (concatenate 'string s missing-arg)");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".cm-lintRange-warning"), "the undefined variable is marked without compiling").toHaveCount(1, { timeout: 10_000 });
  await expect(editor.locator(".cm-lintRange-warning"), "the mark is on the variable, not its whole form").toHaveText("missing-arg");
  await expect(page.locator(".panel-tab", { hasText: "Problems" }).locator(".count-badge")).toHaveText("1");
  await shots(page, "29-live-check");
  await editor.locator(".cm-line", { hasText: "missing-arg" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("0fmdt)is");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".cm-line", { hasText: "(defun shout" })).toHaveText("(defun shout (s) (concatenate 'string s s))");
  await expect(editor.locator(".cm-lintRange-warning"), "fixing it clears the mark").toHaveCount(0, { timeout: 10_000 });
  expect(readFileSync(join(parent, "zen-live/src/main.lisp"), "utf8"), "checking leaves the file unsaved").not.toContain("shout");
});

test("saving compiles only what changed, and gd goes to local bindings and back", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-inc");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  await page.locator(".system").first().getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("load zen-inc: done")).toBeVisible({ timeout: 60_000 });
  const editor = page.locator(".editor-host");
  const activeLine = editor.locator(".cm-activeLine");
  const flash = page.getByTestId("flash");

  await editor.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("Go");
  await page.keyboard.type("(defun added (n)");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(let ((twice (* 2 n)))");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(+ twice n");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".cm-content")).toContainText("(defun added (n)  (let ((twice (* 2 n)))    (+ twice n)))");
  await page.keyboard.press("Meta+s");
  await expect(flash, "saving compiles the new function, and only it").toHaveText("Compiled added");
  await page.locator(".panel-tab", { hasText: "REPL" }).click();
  await replEval(page, "(zen-inc::added 5)");
  await expect(page.locator(".presentation", { hasText: /^15$/ })).toBeVisible();

  await editor.locator(".cm-line", { hasText: "(+ twice n)" }).getByText("twice").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("gd");
  await expect(activeLine, "gd on a LET variable goes to its binding").toContainText("(let ((twice (* 2 n)))");
  await page.keyboard.press("Control+o");
  await expect(activeLine, "and C-o comes back").toContainText("(+ twice n)");

  await editor.locator(".cm-line", { hasText: "(* 2 n)" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("0f2r3");
  await page.keyboard.press("Meta+s");
  await expect(flash, "an edit recompiles only the form it is in").toHaveText("Compiled added");
  await page.locator(".panel-tab", { hasText: "REPL" }).click();
  await replEval(page, "(zen-inc::added 5)");
  await expect(page.locator(".presentation", { hasText: /^20$/ })).toBeVisible();
});

test("a file that uses a package from an unloaded file is still checked, and a compile-time error is reported", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "zenlisp-e2e-"));
  await fresh(page);
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("my-app").fill("zen-uses");
  await page.getByPlaceholder("/Users/you/projects").fill(parent);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".dot.ready")).toBeVisible({ timeout: 60_000 });
  writeFileSync(join(parent, "zen-uses/src/helpers.lisp"), "(defpackage #:zen-helpers\n  (:use #:cl)\n  (:export #:hello1))\n");
  writeFileSync(
    join(parent, "zen-uses/src/uses.lisp"),
    '(defpackage #:zen-uses-main\n  (:use #:cl #:zen-helpers))\n\n(in-package #:zen-uses-main)\n\n(defun run ()\n  (hello2 "good"))\n',
  );
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByTestId("file-tree").getByText("src").click();
  await page.getByTestId("file-tree").getByText("uses.lisp").click();
  const editor = page.locator(".editor-host");
  await editor.locator(".cm-line", { hasText: "(hello2" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("A ");
  await page.keyboard.press("Escape");
  const marks = editor.locator(".cm-lintRange-warning");
  await expect(marks, "the undefined function is marked though its package's file is not loaded").toHaveText(["hello2"], { timeout: 10_000 });
  const atCursor = editor.locator(".cm-cursor-diagnostic");
  await expect(atCursor).toHaveCount(0);
  await page.keyboard.type("^l");
  await expect(atCursor, "moving the cursor onto a mark shows its message").toContainText("undefined function: ZEN-USES-MAIN::HELLO2");
  await page.keyboard.type("w");
  await expect(atCursor, "and moving off it hides it").toHaveCount(0);
  await page.keyboard.type("b");
  await expect(atCursor).toHaveCount(1);
  await shots(page, "30-cursor-diagnostic");
  await page.keyboard.type("a");
  await page.keyboard.type("x");
  await expect(atCursor, "typing hides it").toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await expect(marks).toHaveText(["hello2"], { timeout: 10_000 });

  await editor.locator(".cm-line", { hasText: "(hello2" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("^l");
  await atCursor.getByRole("button", { name: "Ask AI to fix" }).click();
  await expect(page.locator(".chat-user").last(), "the note goes to the assistant with where it is").toContainText("undefined function: ZEN-USES-MAIN::HELLO2");
  await expect(page.locator(".chat-assistant").last()).toContainText("I replaced the call", { timeout: 15_000 });
  await expect(editor.locator(".cm-line", { hasText: "(list" }), "its edit shows in the editor").toHaveText('  (list "good"))');
  expect(readFileSync(join(parent, "zen-uses/src/uses.lisp"), "utf8")).toContain('(list "good")');
  await expect(marks, "and the check that follows clears the mark").toHaveCount(0, { timeout: 10_000 });
  await shots(page, "31-ask-ai-fix");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("u");
  await expect(editor.locator(".cm-line", { hasText: "(hello2" }), "one undo takes the assistant's edit back").toHaveCount(1);

  await page.keyboard.press("G");
  await page.keyboard.type("o(eval-when (:compile-toplevel) (error \"boom\"))");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".cm-lintRange-error"), "an error while compiling is an error mark, not a stuck check").toHaveCount(1, { timeout: 10_000 });
  await page.locator(".panel-tab", { hasText: "Problems" }).click();
  await expect(page.getByTestId("problems")).toContainText("boom");
  await editor.locator(".cm-line", { hasText: "boom" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("dd");
  await expect(editor.locator(".cm-lintRange-error"), "and the next check still runs").toHaveCount(0, { timeout: 10_000 });
  await expect(marks).toHaveText(["hello2"]);
});
