# rbx-prep

A Python helper for set prep, run alongside rbxport. It covers what rbxport
doesn't do yet, so the features can be tuned on a real library before they are
ported to a Rust crate.

| Command | What it does |
| --- | --- |
| `drift` | Labels a track's grid as steady or drifting, with its tempo span and jitter |
| `warp` (also `tighten`) | Smooths a drifting grid onto the kicks, then auto-warps the audio to a fixed BPM (Rubber Band R3) |
| `cues` | Finds a red hot cue on the first held vocal and an 8-bar memory loop ending on the bar before it |
| `extend-intro` | Loops a clean, vocal-free block in the intro (default 8 bars ×2 = 16 bars added) |
| `extend-outro` | The same at the end, after the last vocal |
| `instrumental` / `acapella` | Demucs vocal split; stems are cached per track |

In the app, the same tools are in the **EDIT** tab next to CUE/LOOP and GRID,
and at full size in the **EDITOR** layout (layout menu, top left). The app
calls `uv run --project tools/prep rbx-prep …` through the `prep_run` command;
set `RBX_PREP_DIR` if the folder lives elsewhere.

Every command writes **new files** into an `rbx-prep` folder next to the track and prints one JSON object
(`tool`, `summary`, `files`, `details`, or `error`).
Original audio is never modified.

## Setup (macOS)

```sh
brew install rubberband ffmpeg
cd tools/prep
uv run rbx-prep drift "Track.aiff" --anlz /Volumes/STICK/PIONEER/USBANLZ/.../ANLZ0000.DAT
```

## Tested on

Candido – *Jingo* (a live, drifting disco recording):

- Solco's dynamic grid: beat-to-beat swings of up to 40 ms (115–125 BPM flicker).
- `tighten`: steady 121 BPM, at most 1.05% stretch anywhere in the track, kicks a
  median 8 ms from the straight grid (23 ms without the warp).
- `cues`: first vocal at 1:35.8, memory loop 1:18.4–1:34.3.
- `extend`: +16 bars, sample-accurate joins, grid stays aligned to the end.

## Next

- Read and write rbxport's own grid instead of ANLZ files.
- Apply `cues` results to the track's real hot cue and memory loop (today they are reported, not written).
- Import the new files into the library next to the original, with grid and cues set.
- A batch "prep this playlist" job.
- Port `grid.py` into `crates/rbl-analysis` once the settings have been tuned.

## Licenses

GPL-2.0-or-later, like rbxport. Rubber Band is GPL; Demucs is MIT.
