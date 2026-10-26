use crate::sexp::Sexp;
use crate::swank::{Connection, Event, Thread};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub sbcl: PathBuf,
    /// SBCL_HOME for an SBCL that is not installed, such as the one bundled with the app.
    pub sbcl_home: Option<PathBuf>,
    /// An SBCL to fall back on, laid out as bin/sbcl and lib/sbcl.
    pub bundled_sbcl: Option<PathBuf>,
    pub resources: PathBuf,
    pub cwd: PathBuf,
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
    /// Off by default: a user ~/.sbclrc can rebind *debugger-hook* or load
    /// systems that break Swank, and the IDE must still start.
    pub load_userinit: bool,
    /// SBCL's heap, `--dynamic-space-size`, in megabytes; None keeps SBCL's default.
    pub dynamic_space_mb: Option<u32>,
    /// Compile development code at debug 3, so stepping and locals work.
    pub debug_code: bool,
    /// A saved image to start from instead of ZenLisp's cached core.
    pub core: Option<PathBuf>,
}

impl SessionConfig {
    /// Uses the SBCL in `dir` (laid out as bin/sbcl and lib/sbcl) when none is installed.
    pub fn with_bundled_sbcl(mut self, dir: &std::path::Path) -> SessionConfig {
        self.bundled_sbcl = Some(dir.to_path_buf());
        self.resolve_sbcl();
        self
    }

    /// Looks for SBCL again, so one installed while ZenLisp runs is found:
    /// an installed SBCL first, then the bundled one.
    pub fn resolve_sbcl(&mut self) {
        if self.sbcl.is_file() && self.sbcl_home.is_none() {
            return;
        }
        let installed = find_sbcl();
        let bundled = self.bundled_sbcl.as_ref().map(|d| (d.join("bin/sbcl"), d.join("lib/sbcl")));
        match bundled {
            Some((program, home)) if !installed.is_file() && program.is_file() => {
                self.sbcl = program;
                self.sbcl_home = Some(home);
            }
            _ => {
                self.sbcl = installed;
                self.sbcl_home = None;
            }
        }
    }

    /// A command that runs this config's SBCL.
    pub fn sbcl_command(&self) -> Command {
        let mut cmd = Command::new(&self.sbcl);
        if let Some(home) = &self.sbcl_home {
            cmd.env("SBCL_HOME", home);
        }
        cmd
    }

    pub fn new(resources: impl Into<PathBuf>) -> SessionConfig {
        SessionConfig {
            sbcl: find_sbcl(),
            sbcl_home: None,
            bundled_sbcl: None,
            resources: resources.into(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            cache_dir: default_cache_dir(),
            data_dir: default_data_dir(),
            load_userinit: false,
            dynamic_space_mb: None,
            debug_code: true,
            core: None,
        }
    }
}

fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ZENLISP_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library/Application Support/ZenLisp")
}

fn default_cache_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library/Caches/ZenLisp")
}

/// GUI apps on macOS start with a minimal PATH, so look in the usual places.
pub fn find_sbcl() -> PathBuf {
    if let Some(p) = std::env::var_os("ZENLISP_SBCL") {
        return PathBuf::from(p);
    }
    let candidates = ["/opt/homebrew/bin/sbcl", "/usr/local/bin/sbcl", "/opt/local/bin/sbcl"];
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("sbcl"))
        .chain(candidates.iter().map(PathBuf::from))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("sbcl"))
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("could not start {sbcl}: {source}")]
    Spawn { sbcl: String, source: std::io::Error },
    #[error("building the ZenLisp SBCL core failed. Output:\n{0}")]
    CoreBuild(String),
    #[error("SBCL exited before Swank started. Output:\n{0}")]
    EarlyExit(String),
    #[error("SBCL did not start Swank within {0:?}. Output:\n{1}")]
    Timeout(Duration, String),
    #[error("could not connect to Swank: {0}")]
    Connect(std::io::Error),
}

pub struct Session {
    pub conn: Connection,
    pub pid: Option<u32>,
    child: Arc<Mutex<Child>>,
    stdin: std::sync::Mutex<Option<ChildStdin>>,
    /// The last lines SBCL wrote to its own stdout and stderr, for saying why it died.
    tail: Tail,
}

type Tail = Arc<std::sync::Mutex<std::collections::VecDeque<String>>>;

const TAIL_LINES: usize = 40;

const START_TIMEOUT: Duration = Duration::from_secs(120);

impl Session {
    pub async fn start(cfg: &SessionConfig) -> Result<Session, StartError> {
        let core = match &cfg.core {
            Some(image) => image.clone(),
            None => ensure_core(cfg).await?,
        };
        let mut cmd = cfg.sbcl_command();
        cmd.arg("--core").arg(&core);
        // A runtime option, so it goes before the toplevel ones.
        if let Some(mb) = cfg.dynamic_space_mb {
            cmd.arg("--dynamic-space-size").arg(format!("{mb}MB"));
        }
        cmd.arg("--noinform").arg("--disable-debugger");
        if !cfg.load_userinit {
            cmd.arg("--no-userinit");
        }
        cmd.arg("--eval")
            .arg(format!("(zenlisp:start-server :debug-code {})", if cfg.debug_code { "t" } else { "nil" }))
            .current_dir(&cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|source| StartError::Spawn {
            sbcl: cfg.sbcl.display().to_string(),
            source,
        })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let stderr = BufReader::new(child.stderr.take().expect("piped stderr")).lines();

        let mut transcript = String::new();
        let port = tokio::time::timeout(START_TIMEOUT, async {
            while let Ok(Some(line)) = stdout.next_line().await {
                if let Some(p) = line.strip_prefix("ZENLISP-PORT ") {
                    return p.trim().parse::<u16>().ok();
                }
                transcript.push_str(&line);
                transcript.push('\n');
            }
            None
        })
        .await;
        let port = match port {
            Ok(Some(p)) => p,
            Ok(None) => {
                let mut err = stderr;
                while let Ok(Some(l)) = err.next_line().await {
                    transcript.push_str(&l);
                    transcript.push('\n');
                }
                return Err(StartError::EarlyExit(transcript));
            }
            Err(_) => return Err(StartError::Timeout(START_TIMEOUT, transcript)),
        };

        let conn = Connection::connect(port).await.map_err(StartError::Connect)?;
        let tail = Tail::default();
        forward_lines(stdout, conn.clone(), tail.clone());
        forward_lines(stderr, conn.clone(), tail.clone());
        let repl = Sexp::parse(r#"(swank-repl:create-repl nil :coding-system "utf-8-unix")"#).expect("static form");
        conn.rex(repl, "COMMON-LISP-USER", Thread::T).await.map_err(|e| StartError::Connect(std::io::Error::other(e)))?;
        Ok(Session { conn, pid: child.id(), child: Arc::new(Mutex::new(child)), stdin: std::sync::Mutex::new(Some(stdin)), tail })
    }

    pub fn close_stdin_for_test(&self) {
        self.stdin.lock().unwrap().take();
    }

    pub async fn stop(&self) {
        let _ = self.child.lock().await.kill().await;
    }

    pub async fn exited(&self) -> bool {
        matches!(self.child.lock().await.try_wait(), Ok(Some(_)))
    }

    /// Why SBCL ended, as a sentence, then its last output on the lines after it.
    /// It waits briefly for the process to be reaped.
    pub async fn exit_report(&self) -> String {
        let mut status = None;
        for _ in 0..20 {
            if let Ok(Some(s)) = self.child.lock().await.try_wait() {
                status = Some(s);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let how = match status {
            Some(s) if s.code().is_some() => format!("Lisp exited with code {}.", s.code().unwrap_or_default()),
            Some(s) => {
                use std::os::unix::process::ExitStatusExt;
                match s.signal() {
                    Some(9) => "Lisp was killed (signal 9), often because the system ran out of memory.".to_string(),
                    Some(11) => "Lisp crashed (signal 11).".to_string(),
                    Some(n) => format!("Lisp ended on signal {n}."),
                    None => "Lisp ended.".to_string(),
                }
            }
            None => "Lisp closed its connection.".to_string(),
        };
        let tail: Vec<String> = self.tail.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() { how } else { format!("{how}\n{}", tail.join("\n")) }
    }
}

/// Text SBCL writes to its own stdout or stderr, such as output from threads
/// that Swank does not redirect, shows up as "inferior" output.
fn forward_lines<R>(mut lines: tokio::io::Lines<BufReader<R>>, conn: Connection, tail: Tail)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        while let Ok(Some(mut line)) = lines.next_line().await {
            {
                let mut t = tail.lock().unwrap();
                if t.len() == TAIL_LINES {
                    t.pop_front();
                }
                t.push_back(line.clone());
            }
            line.push('\n');
            conn.emit(Event::Output { text: line, target: Some("inferior".into()) });
        }
    });
}

/// Returns a cached core with Swank preloaded, building it on first use.
/// The cache key covers the SBCL version and every bundled Lisp file, so an
/// upgrade of either rebuilds. Builds write to a temp file and rename it, so
/// concurrent starts never load a half-written core.
pub async fn ensure_core(cfg: &SessionConfig) -> Result<PathBuf, StartError> {
    let spawn_err = |source| StartError::Spawn { sbcl: cfg.sbcl.display().to_string(), source };
    let version = cfg.sbcl_command().arg("--version").output().await.map_err(spawn_err)?;
    let mut key = Fnv::default();
    key.write(&version.stdout);
    for dir in ["lisp", "swank", "swank/swank", "swank/contrib"] {
        let mut files: Vec<_> = std::fs::read_dir(cfg.resources.join(dir))
            .map_err(spawn_err)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_file())
            .collect();
        files.sort();
        for f in files {
            key.write(f.file_name().unwrap().as_encoded_bytes());
            key.write(&std::fs::read(&f).map_err(spawn_err)?);
        }
    }
    let core = cfg.cache_dir.join(format!("zenlisp-{:016x}.core", key.0));
    if core.is_file() {
        return Ok(core);
    }
    std::fs::create_dir_all(&cfg.cache_dir).map_err(spawn_err)?;
    let tmp = tempdir(&cfg.cache_dir).map_err(spawn_err)?;
    let out = cfg.sbcl_command()
        .args(["--noinform", "--non-interactive", "--no-userinit", "--load"])
        .arg(cfg.resources.join("lisp/build-core.lisp"))
        .env("ZENLISP_SWANK_DIR", dir_string(&cfg.resources.join("swank")))
        .env("ZENLISP_LISP_DIR", dir_string(&cfg.resources.join("lisp")))
        .env("ZENLISP_FASL_DIR", dir_string(&tmp.join("fasl")))
        .env("ZENLISP_CORE_OUT", tmp.join("zenlisp.core"))
        .output()
        .await
        .map_err(spawn_err)?;
    let built = tmp.join("zenlisp.core");
    let result = if built.is_file() {
        let done = std::fs::rename(&built, &core).map_err(spawn_err).map(|_| core);
        prune_cores(&cfg.cache_dir, 2);
        done
    } else {
        let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
        log.push_str(&String::from_utf8_lossy(&out.stderr));
        Err(StartError::CoreBuild(log))
    };
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Deletes all but the `keep` newest cores. Each is about 40 MB, and every
/// change to SBCL or the bundled Lisp makes a new one. A running SBCL has
/// already read its core, so deleting it is safe.
fn prune_cores(dir: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut cores: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("zenlisp-") && n.ends_with(".core")))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    cores.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, old) in cores.into_iter().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
}

fn tempdir(parent: &std::path::Path) -> std::io::Result<PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = parent.join(format!("build-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// FNV-1a, so cache keys stay stable across Rust releases.
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Fnv(0xcbf29ce484222325)
    }
}

impl Fnv {
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}

fn dir_string(p: &std::path::Path) -> String {
    let mut s = p.display().to_string();
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}
