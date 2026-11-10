//! Set-prep tools: runs `tools/prep` (rbx-prep, Python) on a library track.
//!
//! Not rekordbox's. Each tool writes new files in an `rbx-prep` folder next to
//! the track and prints one JSON object; nothing here touches the library,
//! the track's file, its grid or its cues. The tools read the track's current
//! grid from its analysis `.DAT`, so a track has to be analysed first.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

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

#[tauri::command]
#[allow(clippy::needless_pass_by_value, reason = "Tauri's State extractor is injected by value")]
pub async fn prep_run(
    state: State<'_, Arc<AppState>>,
    track_id: String,
    tool: String,
    options: Option<PrepOptions>,
) -> AppResult<serde_json::Value> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(AppError::new(ErrorKind::Malformed, "Unknown prep tool."));
    }
    let library = state.library()?;
    let share = state.share_root();
    let state = Arc::clone(&state);
    let options = options.unwrap_or_default();
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

        tracing::info!(tool = %tool, track = %track_id, "prep: running rbx-prep");
        let output = cmd.output().map_err(|e| {
            AppError::new(ErrorKind::NotFound, "Could not start the prep tools. Is uv installed (brew install uv)?").with_detail(e.to_string())
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // The JSON is the last line; uv and Demucs print progress before it.
        let last = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
        let value: serde_json::Value = serde_json::from_str(last).map_err(|e| {
            AppError::new(ErrorKind::Internal, format!("The {tool} tool failed."))
                .with_detail(format!("{e}\nstdout: {stdout}\nstderr: {stderr}"))
        })?;
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(AppError::new(ErrorKind::Malformed, error.to_owned()));
        }
        Ok(value)
    })
    .await
}
