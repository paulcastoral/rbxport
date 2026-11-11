//! Set-prep tools: runs `tools/prep` (rbx-prep, Python) on a library track.
//!
//! Not rekordbox's. Each tool writes new files in an `rbx-prep` folder next to
//! the track and prints one JSON object; nothing here touches the library,
//! the track's file, its grid or its cues. The tools read the track's current
//! grid from its analysis `.DAT`, so a track has to be analysed first.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use serde::Deserialize;
use tauri::State;

use crate::commands::blocking;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::state::AppState;

const TOOLS: &[&str] = &["drift", "tighten", "cues", "extend-intro", "extend-outro", "instrumental", "acapella"];
/// Tools that only need the audio, not the grid.
const AUDIO_ONLY: &[&str] = &["instrumental", "acapella"];

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepOptions {
    bars: Option<u32>,
    repeats: Option<u32>,
    loop_bars: Option<u32>,
    bpm: Option<f64>,
}

/// Where `tools/prep` lives: `RBX_PREP_DIR`, else next to the source tree in
/// a dev build, else beside the app's resources.
fn prep_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("RBX_PREP_DIR") {
        return Some(PathBuf::from(dir));
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/prep");
    if dev.join("pyproject.toml").exists() {
        return Some(dev);
    }
    std::env::current_exe().ok()?.parent().map(|d| d.join("../Resources/tools/prep")).filter(|d| d.exists())
}

/// `uv`, which a Finder-launched app will not find on PATH.
fn uv() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    for candidate in [format!("{home}/.local/bin/uv"), "/opt/homebrew/bin/uv".into(), "/usr/local/bin/uv".into()] {
        if Path::new(&candidate).exists() {
            return candidate.into();
        }
    }
    "uv".into()
}

/// Running tools by the run id the UI gave them, to the process group to
/// signal on Stop: uv, Python and the Demucs child all share one group.
fn running() -> &'static Mutex<HashMap<String, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs were stopped from the UI, so a non-zero exit is "Stopped", not a failure.
fn stopped() -> &'static Mutex<HashSet<String>> {
    static STOPPED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    STOPPED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value, reason = "Tauri's State extractor is injected by value")]
pub async fn prep_run(
    state: State<'_, Arc<AppState>>,
    track_id: String,
    tool: String,
    options: Option<PrepOptions>,
    run_id: Option<String>,
) -> AppResult<serde_json::Value> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(AppError::new(ErrorKind::Malformed, "Unknown prep tool."));
    }
    let library = state.library()?;
    let share = state.share_root();
    let state = Arc::clone(&state);
    let options = options.unwrap_or_default();
    let run_id = run_id.unwrap_or_else(|| format!("{track_id}:{tool}"));
    blocking("prep_run", move || {
        let row = library
            .row_of(&track_id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "That track is not in the library."))? as usize;
        let audio = library.folder_path.get(row).to_owned();
        if audio.is_empty() || !Path::new(&audio).exists() {
            return Err(AppError::new(ErrorKind::NotFound, "The track's audio file is missing.").with_detail(audio));
        }
        let dir = prep_dir().ok_or_else(|| {
            AppError::new(ErrorKind::NotFound, "The prep tools (tools/prep) were not found. Set RBX_PREP_DIR to their folder.")
        })?;

        let mut cmd = Command::new(uv());
        cmd.arg("run").arg("--project").arg(&dir).arg("rbx-prep").arg(&tool).arg(&audio);
        if !AUDIO_ONLY.contains(&tool.as_str()) {
            let relative = state.analysis_path_of(&library, row, &track_id);
            if relative.is_empty() {
                return Err(AppError::new(ErrorKind::NotFound, "Analyze the track first: this tool works from its beat grid."));
            }
            cmd.arg("--anlz").arg(rbl_anlz::resolve(&share, &relative));
        }
        if let Some(v) = options.bars { cmd.arg("--bars").arg(v.to_string()); }
        if let Some(v) = options.repeats { cmd.arg("--repeats").arg(v.to_string()); }
        if let Some(v) = options.loop_bars { cmd.arg("--loop-bars").arg(v.to_string()); }
        if let Some(v) = options.bpm { cmd.arg("--bpm").arg(v.to_string()); }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own group, so Stop reaches Demucs as well as uv.
            cmd.process_group(0);
        }

        tracing::info!(tool = %tool, track = %track_id, run = %run_id, "prep: running rbx-prep");
        let child = cmd.spawn().map_err(|e| {
            AppError::new(ErrorKind::NotFound, "Could not start the prep tools. Is uv installed (brew install uv)?").with_detail(e.to_string())
        })?;
        running().lock().insert(run_id.clone(), child.id());
        let output = child.wait_with_output();
        running().lock().remove(&run_id);
        let was_stopped = stopped().lock().remove(&run_id);
        let output = output.map_err(|e| AppError::new(ErrorKind::Internal, "The prep tool stopped unexpectedly.").with_detail(e.to_string()))?;
        if was_stopped {
            return Err(AppError::new(ErrorKind::Cancelled, "Stopped. Nothing was kept from this run."));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // The JSON is the last line; uv and Demucs print progress before it.
        let last = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
        let value: serde_json::Value = serde_json::from_str(last).map_err(|e| {
            // No JSON: the tool never ran (setup failed) or crashed. The last
            // `error:` line from uv or Python is the part worth reading.
            let reason = stderr
                .lines()
                .rev()
                .find(|l| l.trim_start().starts_with("error:") || l.contains("Error"))
                .unwrap_or("see the log for details")
                .trim();
            AppError::new(ErrorKind::Internal, format!("The {tool} tool could not run: {reason}"))
                .with_detail(format!("{e}\nstdout: {stdout}\nstderr: {stderr}"))
        })?;
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(AppError::new(ErrorKind::Malformed, error.to_owned()));
        }
        Ok(value)
    })
    .await
}

/// Stop: signals the run's whole process group. The run's own `prep_run`
/// call then returns `Cancelled`. Unknown or finished runs are ignored.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps, reason = "a Tauri command takes owned arguments and returns AppResult like the others")]
pub fn prep_cancel(run_id: String) -> AppResult<()> {
    let Some(pid) = running().lock().get(&run_id).copied() else { return Ok(()) };
    stopped().lock().insert(run_id.clone());
    tracing::info!(run = %run_id, pid, "prep: stopping");
    #[cfg(unix)]
    {
        // `kill -TERM -<pgid>`: the whole group, without an unsafe libc call.
        let _ = Command::new("kill").arg("-TERM").arg("--").arg(format!("-{pid}")).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
    Ok(())
}

/// Undo: moves files a prep run wrote to the Trash. Only files inside an
/// `rbx-prep` folder are accepted, so this can never reach a library track.
#[tauri::command]
pub async fn prep_undo(files: Vec<String>) -> AppResult<()> {
    blocking("prep_undo", move || {
        for file in &files {
            let path = Path::new(file);
            let ours = path.parent().is_some_and(|p| p.components().any(|c| c.as_os_str() == "rbx-prep"));
            if !ours {
                return Err(AppError::new(ErrorKind::Malformed, "Undo only removes files the prep tools made.").with_detail(file.clone()));
            }
        }
        for file in &files {
            let path = Path::new(file);
            if path.exists() {
                trash(path).map_err(|e| AppError::new(ErrorKind::Internal, "Could not move the file to the Trash.").with_detail(format!("{file}: {e}")))?;
            }
        }
        Ok(())
    })
    .await
}

/// The Finder's own Trash (so Put Back works) on macOS; elsewhere the
/// freedesktop Trash, or a plain delete when there is none.
fn trash(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Finder\" to delete (POSIX file \"{}\" as alias)",
            path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
        );
        let status = Command::new("osascript").arg("-e").arg(script).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
        if status.success() {
            return Ok(());
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let name = path.file_name().unwrap_or_default();
        return std::fs::rename(path, Path::new(&home).join(".Trash").join(name));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let bin = Path::new(&home).join(".local/share/Trash/files");
        if bin.is_dir() {
            if let Some(name) = path.file_name() {
                if std::fs::rename(path, bin.join(name)).is_ok() {
                    return Ok(());
                }
            }
        }
        std::fs::remove_file(path)
    }
}

/// One ordinary playlist that holds a track, with every track in it in order.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepPlacement {
    playlist: String,
    tracks: Vec<String>,
}

/// Where a prep result goes: the ordinary playlists holding the original, so
/// the new version can be added right below it. Intelligent playlists are
/// left out, since their rule decides what they hold.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, reason = "Tauri's State extractor is injected by value")]
pub async fn prep_placements(state: State<'_, Arc<AppState>>, track_id: String) -> AppResult<Vec<PrepPlacement>> {
    let library = state.library()?;
    blocking("prep_placements", move || {
        let row = library
            .row_of(&track_id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "That track is not in the library."))?;
        let playlists = library.playlists();
        let out = library
            .playlists_containing(row)
            .into_iter()
            .filter(|&index| !playlists.is_smart(index))
            .filter_map(|index| {
                let id = playlists.ids.get(index)?;
                let members = playlists.members.get(index)?;
                let tracks = members
                    .iter()
                    .filter_map(|&member| library.ids.get(member as usize).map(u64::to_string))
                    .collect();
                Some(PrepPlacement { playlist: id.to_string(), tracks })
            })
            .collect();
        Ok(out)
    })
    .await
}
