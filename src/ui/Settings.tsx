import { useEffect, useMemo, useState } from "react";
import * as actions from "../actions";
import { CODE_FONTS, installed, UI_FONTS } from "../fonts";
import type { AssistantConfig } from "../protocol/AssistantConfig";
import type { AssistantStatus } from "../protocol/AssistantStatus";
import type { Provider } from "../protocol/Provider";
import type { ProviderStatus } from "../protocol/ProviderStatus";
import type { ImageInfo } from "../protocol/ImageInfo";
import type { LispOptions } from "../protocol/LispOptions";
import { type Settings as EditorSettings, updateSettings, useSettings } from "../settings";
import { set, useStore } from "../store";
import { pickFile, revealInFinder } from "../platform";
import { allThemes, readThemeFiles, type ThemeKind, useThemes } from "../themes";
import { type PluginSetting, reloadPlugins, setPluginSetting, usePlugins } from "../plugins";
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

function ThemeRows() {
  const s = useSettings();
  const { dir, user, problems } = useThemes();
  const reload = () => actions.request({ type: "themes" }).then((r) => r.type === "themes" && readThemeFiles(r.dir, r.files));
  const picker = (kind: ThemeKind) => (
    <select
      className="select"
      aria-label={`${kind === "light" ? "Light" : "Dark"} theme`}
      value={kind === "light" ? s.lightTheme : s.darkTheme}
      onChange={(e) => updateSettings(kind === "light" ? { lightTheme: e.target.value } : { darkTheme: e.target.value })}
    >
      {allThemes(user)
        .filter((t) => t.kind === kind)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
    </select>
  );
  return (
    <>
      <Row label="Light theme">{picker("light")}</Row>
      <Row label="Dark theme">{picker("dark")}</Row>
      <Row label="Your themes" hint='A theme is a JSON file in the themes folder: { "name": "Paper", "kind": "light", "colors": { "bg": "#ffffff", "syn-string": "#a31515" } }. Colors left out keep ZenLisp’s.'>
        <div className="path-input">
          <button className="btn" disabled={!dir} onClick={() => revealInFinder(dir)}>
            Open Themes Folder
          </button>
          <button className="btn" onClick={() => void reload()}>
            Reload Themes
          </button>
        </div>
        {dir && (
          <div className="setting-hint" data-testid="themes-dir">
            {dir}
          </div>
        )}
        {problems.map((p) => (
          <div key={p} className="setting-hint theme-problem" data-testid="theme-problem">
            {p}
          </div>
        ))}
      </Row>
    </>
  );
}

function PluginSettingControl({ setting }: { setting: PluginSetting }) {
  const [typed, setTyped] = useState(String(setting.value ?? ""));
  const label = `${setting.plugin}: ${setting.title}`;
  if (setting.type === "boolean")
    return <Toggle label={setting.title} checked={setting.value === true} onChange={(v) => void setPluginSetting(setting.id, v)} />;
  if (setting.type === "choice")
    return (
      <select className="select" aria-label={label} value={String(setting.value ?? "")} onChange={(e) => void setPluginSetting(setting.id, e.target.value)}>
        {setting.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  const commit = () => {
    if (setting.type === "number" && !Number.isFinite(Number(typed))) return setTyped(String(setting.value ?? ""));
    void setPluginSetting(setting.id, setting.type === "number" ? Number(typed) : typed);
  };
  return (
    <div className="path-input">
      <input
        aria-label={label}
        inputMode={setting.type === "number" ? "decimal" : undefined}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </div>
  );
}

function Plugins() {
  const manifest = usePlugins((s) => s.manifest);
  if (!manifest)
    return (
      <Row label="Plugins">
        <div className="setting-hint">Plugins run in Lisp. They show here once a project's Lisp is running.</div>
      </Row>
    );
  return (
    <>
      <Row
        label="Plugins folder"
        hint="Each file.lisp in it, or folder with init.lisp or an ASDF system of its name, is a plugin. Every project's Lisp loads them. docs/plugins.md describes the API."
      >
        <div className="path-input">
          <button className="btn" disabled={!manifest.directory} onClick={() => manifest.directory && revealInFinder(manifest.directory)}>
            Open Plugins Folder
          </button>
          <button className="btn" onClick={() => void reloadPlugins()}>
            Reload Plugins
          </button>
        </div>
        {manifest.directory && (
          <div className="setting-hint" data-testid="plugins-dir">
            {manifest.directory}
          </div>
        )}
      </Row>
      <Row label="Loaded">
        {manifest.plugins.length === 0 && <div className="setting-hint">No plugins yet.</div>}
        {manifest.plugins.map((p) => (
          <div key={p.name} data-testid="plugin">
            <span>{p.name}</span>
            {p.error && <div className="setting-hint theme-problem">{p.error}</div>}
          </div>
        ))}
      </Row>
      {manifest.settings.map((setting) => (
        <Row key={setting.id} label={setting.title} hint={[setting.plugin, setting.doc].filter(Boolean).join(" · ")}>
          <PluginSettingControl setting={setting} />
        </Row>
      ))}
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
      <ThemeRows />
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
      <Row label="Lines" hint="⌥Z switches it too.">
        <Toggle label="Wrap long lines" checked={s.wordWrap} onChange={(wordWrap) => put({ wordWrap })} />
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
      <Row label="Projects" hint="Each session starts a fresh Lisp. This loads the systems you loaded last time, so the project is ready as you left it.">
        <Toggle label="Load the systems loaded last time" checked={s.reloadSystems} onChange={(reloadSystems) => put({ reloadSystems })} />
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
      <Row label="Saving" hint="Compiles each top-level form that changed into the running Lisp, so go to definition and references follow your edits. Files of systems not loaded yet are only saved. Changes from git or another editor to a loaded file compile the same way.">
        <Toggle label="Compile changes when saving" checked={s.compileOnSave} onChange={(compileOnSave) => put({ compileOnSave })} />
        <Toggle label="Compile changes made outside ZenLisp" checked={s.compileOnChange} onChange={(compileOnChange) => put({ compileOnChange })} />
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

const PROVIDERS: Record<Provider, { name: string; env: string; placeholder: string }> = {
  claude: { name: "Claude", env: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…" },
  openai: { name: "OpenAI", env: "OPENAI_API_KEY", placeholder: "sk-…" },
};

/** One of a provider's models, or any other model name typed in. */
function ModelPicker({ label, value, models, onChange }: { label: string; value: string; models: string[]; onChange: (v: string) => void }) {
  const [other, setOther] = useState(!models.includes(value));
  const [typed, setTyped] = useState(value);
  const commit = () => typed.trim() && onChange(typed.trim());
  return (
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
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other && (
        <input
          aria-label={`${label} name`}
          placeholder="Model name"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      )}
    </div>
  );
}

function KeyRow({ provider, status, onSaved }: { provider: Provider; status: ProviderStatus; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const { name, env, placeholder } = PROVIDERS[provider];
  const source = status.source;
  return (
    <Row
      label={`${name} API key`}
      hint={
        source === "environment"
          ? `Set by ${env} in the environment.`
          : source === "ant"
            ? "Taken from the ant command line tool's login."
            : status.configured
              ? "Saved in ZenLisp's data folder."
              : `${name} models need an API key.`
      }
    >
      <div className="path-input">
        <input type="password" aria-label={`${name} API key`} placeholder={status.configured ? "•••••••• saved" : placeholder} value={key} onChange={(e) => setKey(e.target.value)} />
        <button
          className="btn"
          disabled={!key.trim()}
          onClick={async () => {
            await actions.request({ type: "assistantSetKey", provider, key: key.trim() });
            setKey("");
            onSaved();
          }}
        >
          Save
        </button>
      </div>
    </Row>
  );
}

function Assistant() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const refresh = () => actions.request({ type: "assistantStatus" }).then((r) => r.type === "assistant" && setStatus(r));
  useEffect(() => void refresh(), []);
  if (!status) return null;
  const configure = (change: Partial<AssistantConfig>) =>
    actions.request({ type: "assistantConfigure", config: { ...status.config, ...change } }).then((r) => r.type === "assistant" && setStatus(r));
  return (
    <>
      <Row label="Answered by" hint="The chat's model menu switches too.">
        <select className="select" aria-label="Provider" value={status.config.provider} onChange={(e) => void configure({ provider: e.target.value as Provider })}>
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
        </select>
      </Row>
      <Row label="Claude model">
        <ModelPicker label="Claude model" value={status.config.claudeModel} models={status.claude.models} onChange={(claudeModel) => void configure({ claudeModel })} />
      </Row>
      <KeyRow provider="claude" status={status.claude} onSaved={refresh} />
      <Row label="OpenAI model">
        <ModelPicker label="OpenAI model" value={status.config.openaiModel} models={status.openai.models} onChange={(openaiModel) => void configure({ openaiModel })} />
      </Row>
      <KeyRow provider="openai" status={status.openai} onSaved={refresh} />
    </>
  );
}

const SECTIONS = { general: "General", lisp: "Lisp", plugins: "Plugins", assistant: "Assistant" } as const;

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
          {section === "general" ? <General /> : section === "lisp" ? <Lisp /> : section === "plugins" ? <Plugins /> : <Assistant />}
        </div>
      </div>
    </div>
  );
}
