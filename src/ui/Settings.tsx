import { useEffect, useMemo, useState } from "react";
import * as actions from "../actions";
import { CODE_FONTS, installed, UI_FONTS } from "../fonts";
import type { AssistantStatus } from "../protocol/AssistantStatus";
import type { ImageInfo } from "../protocol/ImageInfo";
import type { LispOptions } from "../protocol/LispOptions";
import { type Settings as EditorSettings, updateSettings, useSettings } from "../settings";
import { set, useStore } from "../store";
import { pickFile } from "../platform";
import { useReturnFocus } from "./focus";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        {children}
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** The select's value for a family typed in; no font has this name. */
const OTHER = "\0other";

/**
 * A font family: the default, one of the common families this Mac has, or
 * any other name typed in. The sample shows the choice in that font.
 */
function FontPicker({ value, onChange, candidates, defaultName, label, sample, code }: {
  value: string;
  onChange: (v: string) => void;
  candidates: string[];
  defaultName: string;
  label: string;
  sample: string;
  code: boolean;
}) {
  const available = useMemo(() => candidates.filter((f) => f !== defaultName && installed(f)), [candidates, defaultName]);
  const [other, setOther] = useState(value !== "" && !available.includes(value));
  const [typed, setTyped] = useState(value);
  const missing = value !== "" && !installed(value);
  return (
    <>
      <div className="path-input">
        <select
          className="select"
          aria-label={label}
          value={other ? OTHER : value}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v === OTHER);
            if (v !== OTHER) onChange(v);
          }}
        >
          <option value="">{defaultName} (default)</option>
          {available.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {other && (
          <input
            className="font-name"
            aria-label={`${label} name`}
            placeholder="Font family name"
            value={typed}
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => onChange(typed.trim())}
            onKeyDown={(e) => e.key === "Enter" && onChange(typed.trim())}
          />
        )}
      </div>
      <div className={`font-sample ${code ? "code" : ""}`} data-testid={`${label.toLowerCase().replace(/ /g, "-")}-sample`}>
        {sample}
      </div>
      {missing && <div className="setting-hint">This Mac has no font named {value}, so {defaultName} is used.</div>}
    </>
  );
}

function General() {
  const s = useSettings();
  const put = (patch: Partial<EditorSettings>) => updateSettings(patch);
  return (
    <>
      <Row label="Appearance">
        <div className="segmented">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} className={s.theme === t ? "active" : ""} onClick={() => put({ theme: t })}>
              {t === "system" ? "Match System" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Font size" hint="⌘+ and ⌘- change it too.">
        <div className="stepper-input">
          <button aria-label="Smaller" onClick={() => put({ fontSize: Math.max(9, s.fontSize - 1) })}>
            −
          </button>
          <span>{s.fontSize} pt</span>
          <button aria-label="Larger" onClick={() => put({ fontSize: Math.min(28, s.fontSize + 1) })}>
            +
          </button>
        </div>
      </Row>
      <Row label="Editor font" hint="Code in the editor, the REPL and the panels.">
        <FontPicker
          label="Editor font"
          value={s.editorFont}
          onChange={(editorFont) => put({ editorFont })}
          candidates={CODE_FONTS}
          defaultName="SF Mono"
          sample={'(defun greet (name) (format nil "Hello, ~a!" name)) ; 0O 1lI'}
          code
        />
      </Row>
      <Row label="Interface font" hint="Menus, panels, tabs and messages.">
        <FontPicker
          label="Interface font"
          value={s.uiFont}
          onChange={(uiFont) => put({ uiFont })}
          candidates={UI_FONTS}
          defaultName="System"
          sample="Compiled greet in 0.02s: 0 notes"
          code={false}
        />
      </Row>
      <Row label="Keys" hint="Vim works in the editor; Emacs sequences such as C-c C-c work in any mode.">
        <Toggle label="Vim keys" checked={s.vim} onChange={(vim) => put({ vim })} />
        <Toggle label="Emacs key sequences" checked={s.emacs} onChange={(emacs) => put({ emacs })} />
      </Row>
      <Row label="Parentheses" hint="Parinfer keeps them balanced from indentation as you type.">
        <Toggle label="Parinfer" checked={s.parinfer} onChange={(parinfer) => put({ parinfer })} />
      </Row>
      <Row label="Checking" hint="Compiles the file in the background as you type, without loading it, and marks warnings and errors.">
        <Toggle label="Check code as you type" checked={s.liveCheck} onChange={(liveCheck) => put({ liveCheck })} />
      </Row>
      <Row label="Saving" hint="Compiles each top-level form that changed into the running Lisp, so go to definition and references follow your edits. Files of systems not loaded yet are only saved.">
        <Toggle label="Compile changes when saving" checked={s.compileOnSave} onChange={(compileOnSave) => put({ compileOnSave })} />
      </Row>
    </>
  );
}

function Lisp() {
  const [saved, setSaved] = useState<LispOptions | null>(null);
  const [draft, setDraft] = useState<LispOptions | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const ready = useStore((s) => s.status.session.state !== "starting");

  const load = async () => {
    const r = await actions.request({ type: "lispOptions" });
    if (r.type !== "lispOptions") return;
    setSaved(r.options);
    setDraft((d) => d ?? r.options);
    setFound(r.sbcl);
  };
  useEffect(() => void load(), []);
  if (!draft || !saved) return <div className="setting-hint">Loading…</div>;

  const save = async (next: LispOptions) => {
    setDraft(next);
    await actions.request({ type: "setLispOptions", options: next });
    await load();
  };
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);
  const startedWith = useStore.getState().status.session;

  return (
    <>
      <Row label="SBCL" hint={found ? `Using ${found}.` : "No sbcl found. Install it with brew install sbcl, or choose the program."}>
        <div className="path-input">
          <input
            placeholder="Find it on PATH and in Homebrew"
            value={draft.sbcl}
            onChange={(e) => setDraft({ ...draft, sbcl: e.target.value })}
            onBlur={() => changed && save(draft)}
          />
          <button
            className="btn"
            onClick={async () => {
              const path = await pickFile("Choose the sbcl program");
              if (path) await save({ ...draft, sbcl: path });
            }}
          >
            Choose…
          </button>
        </div>
      </Row>
      <Row label="Heap" hint="SBCL's dynamic space. Leave it at 0 for SBCL's default.">
        <div className="path-input narrow">
          <input
            type="number"
            min={0}
            step={512}
            value={draft.heapMb}
            onChange={(e) => setDraft({ ...draft, heapMb: Math.max(0, Number(e.target.value) || 0) })}
            onBlur={() => changed && save(draft)}
          />
          <span className="setting-hint">MB</span>
        </div>
      </Row>
      <Row label="Startup" hint="An init file can break the connection ZenLisp needs, so it is off by default.">
        <Toggle label="Load ~/.sbclrc" checked={draft.loadUserinit} onChange={(loadUserinit) => save({ ...draft, loadUserinit })} />
      </Row>
      <Row label="Debugging" hint="Keeps locals and stepping for code you compile, at some cost in speed. Builds are not affected.">
        <Toggle label="Compile for debugging" checked={draft.debugCode} onChange={(debugCode) => save({ ...draft, debugCode })} />
      </Row>
      <StartupImage />
      <div className="settings-apply">
        <span className="setting-hint">
          {startedWith.state === "ready" ? "Changes apply the next time Lisp starts." : "Lisp is not running."}
        </span>
        <button className="btn" disabled={!ready} onClick={actions.restartSession}>
          Restart Lisp
        </button>
      </div>
    </>
  );
}

/** The project's main systems: a startup image leaves its test systems out. */
const imageSystems = () => useStore.getState().systems.map((s) => s.name).filter((n) => !/\/tests?$|-tests?$/.test(n));

function StartupImage() {
  const project = useStore((s) => s.status.project);
  const tasks = useStore((s) => s.tasks);
  const saving = tasks["save startup image"]?.running ?? false;
  const [image, setImage] = useState<ImageInfo | null | undefined>(undefined);
  const refresh = () => actions.request({ type: "image" }).then((r) => r.type === "image" && setImage(r.image)).catch(() => setImage(null));
  useEffect(() => {
    if (project && !saving) void refresh();
  }, [project, saving]);
  if (!project) return null;
  const systems = imageSystems();
  return (
    <Row
      label="Startup image"
      hint={
        image
          ? `Saved ${new Date(image.saved * 1000).toLocaleString()}, ${image.megabytes} MB. Lisp starts from it with the project's systems already loaded.`
          : `Saves ${systems.join(", ") || "the project"} loaded into an image, so Lisp starts with them. It is built in a separate SBCL; the running Lisp is not touched.`
      }
    >
      <div className="path-input">
        <button className="btn" disabled={saving || systems.length === 0} onClick={() => actions.saveImage(systems)}>
          {saving ? "Saving…" : image ? "Save again" : "Save an image"}
        </button>
        {image && (
          <button className="btn danger" disabled={saving} onClick={() => actions.request({ type: "deleteImage" }).then(refresh)}>
            Delete
          </button>
        )}
      </div>
    </Row>
  );
}

function Assistant() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [key, setKey] = useState("");
  const refresh = () => actions.request({ type: "assistantStatus" }).then((r) => r.type === "assistant" && setStatus(r));
  useEffect(() => void refresh(), []);
  const source = status?.source;
  return (
    <>
      <Row
        label="API key"
        hint={
          !status
            ? undefined
            : source === "environment"
              ? "Set by ANTHROPIC_API_KEY in the environment."
              : source === "ant"
                ? "Taken from the ant command line tool's login."
                : status.configured
                  ? "Saved in ZenLisp's data folder."
                  : "The assistant needs an Anthropic API key."
        }
      >
        <div className="path-input">
          <input type="password" placeholder={status?.configured ? "•••••••• saved" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} />
          <button
            className="btn"
            disabled={!key.trim()}
            onClick={async () => {
              await actions.request({ type: "assistantSetKey", key: key.trim() });
              setKey("");
              await refresh();
            }}
          >
            Save
          </button>
        </div>
      </Row>
      {status && <Row label="Model">{status.model}</Row>}
    </>
  );
}

const SECTIONS = { general: "General", lisp: "Lisp", assistant: "Assistant" } as const;

export function SettingsScreen() {
  const open = useStore((s) => s.settingsOpen);
  const [section, setSection] = useState<keyof typeof SECTIONS>("general");
  useReturnFocus(open);
  if (!open) return null;
  const close = () => set({ settingsOpen: false });
  return (
    <div className="overlay" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="settings" role="dialog" aria-label="Settings" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} data-testid="settings">
        <nav className="settings-nav">
          {(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((k) => (
            <button key={k} className={section === k ? "active" : ""} onClick={() => setSection(k)}>
              {SECTIONS[k]}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <h2>{SECTIONS[section]}</h2>
            <button className="btn primary" onClick={close}>
              Done
            </button>
          </div>
          {section === "general" ? <General /> : section === "lisp" ? <Lisp /> : <Assistant />}
        </div>
      </div>
    </div>
  );
}
