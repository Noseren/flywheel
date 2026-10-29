#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, Url};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct RuntimeProcess(Mutex<Option<Child>>);

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            if let Some(child) = child.as_mut() {
                // Closing stdin asks the CLI to stop its active Session and servers first.
                child.stdin.take();
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn has_runtime(root: &Path) -> bool {
    root.join("dist").join("cli.js").is_file()
        && root.join("system-assets").join("gui").is_dir()
}

fn runtime_root() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("FLYWHEEL_RUNTIME_ROOT") {
        let root = PathBuf::from(configured);
        if has_runtime(&root) {
            return Ok(root);
        }
        return Err("FLYWHEEL_RUNTIME_ROOT does not contain dist/cli.js".into());
    }

    let current = env::current_dir().map_err(|error| error.to_string())?;
    if has_runtime(&current) {
        return Ok(current);
    }

    let executable = env::current_exe().map_err(|error| error.to_string())?;
    for parent in executable.ancestors() {
        if has_runtime(parent) {
            return Ok(parent.to_path_buf());
        }
    }
    Err("Cannot find the Flywheel Runtime. Set FLYWHEEL_RUNTIME_ROOT to the repository directory.".into())
}

fn node_binary() -> PathBuf {
    env::var_os("FLYWHEEL_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn launch_runtime(app: &tauri::AppHandle) -> Result<RuntimeProcess, String> {
    let root = runtime_root()?;
    let args: Vec<String> = env::args().skip(1).collect();
    let args = if args.is_empty() { vec!["gui".into(), "--gui-port".into(), "0".into()] } else { args };
    let mut command = Command::new(node_binary());
    command
        .arg(root.join("dist").join("cli.js"))
        .args(args)
        .env("FLYWHEEL_DESKTOP_BACKEND", "1")
        .env("FLYWHEEL_DESKTOP_PARENT_PID", std::process::id().to_string())
        .current_dir(env::current_dir().map_err(|error| error.to_string())?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Flywheel Runtime: {error}"))?;
    let stdout = child.stdout.take().ok_or("Cannot read Flywheel Runtime output")?;
    let stderr = child.stderr.take().ok_or("Cannot read Flywheel Runtime errors")?;
    let window = app
        .get_webview_window("main")
        .ok_or("Desktop window is unavailable")?;

    std::thread::spawn(move || {
        let mut navigated = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !navigated {
                let Some(value) = line.strip_prefix("Flywheel GUI: ") else {
                    continue;
                };
                match Url::parse(value) {
                    Ok(url) => match window.navigate(url) {
                        Ok(()) => navigated = true,
                        Err(error) => eprintln!("Cannot open Flywheel GUI: {error}"),
                    },
                    Err(error) => eprintln!("Invalid Flywheel GUI URL: {error}"),
                }
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
        }
    });

    Ok(RuntimeProcess(Mutex::new(Some(child))))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let runtime = launch_runtime(app.handle())?;
            app.manage(runtime);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flywheel Desktop");
}
