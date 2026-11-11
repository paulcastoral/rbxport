"""rbx-prep: set-prep helper for rbxport.

    rbx-prep drift         TRACK --anlz ANLZ0000.DAT
    rbx-prep tighten       TRACK --anlz ANLZ0000.DAT   # smooth + auto-warp to a fixed grid
    rbx-prep cues          TRACK --anlz ANLZ0000.DAT
    rbx-prep extend-intro  TRACK --anlz ANLZ0000.DAT --bars 8 --repeats 2
    rbx-prep extend-outro  TRACK --anlz ANLZ0000.DAT --bars 8 --repeats 2
    rbx-prep instrumental  TRACK
    rbx-prep acapella      TRACK

Every command prints one JSON object: {"tool", "summary", "files", "details"}.
New files go in an `rbx-prep` folder next to the track; originals are never changed.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from . import edits, grid

# How far the kicks may wander against a grid (sub-bass measure, ms) before
# Warp bends the grid to follow them: steady tracks measure 7-27 ms (noise),
# The Rendition (Good Clock Remix) under a straight 128 grid 390 ms.
FOLLOW_DRIFT_MS = 50.0
# After bending, what is left must be this small, or Warp refuses: 1-10 ms
# on the tracks it was checked on.
FOLLOWED_MAX_MS = 25.0

TOOLS = ["drift", "tighten", "warp", "cues", "extend-intro", "extend-outro", "instrumental", "acapella",
         # older names, kept so earlier notes still work
         "stems", "extend"]


def _fmt(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:04.1f}"


def _stems(track: Path, out: Path) -> dict:
    """Split once per track; later calls reuse the stems."""
    d = out / "stems" / "htdemucs" / track.stem
    if (d / "vocals.wav").exists() and (d / "no_vocals.wav").exists():
        return {"vocals": str(d / "vocals.wav"), "instrumental": str(d / "no_vocals.wav")}
    return edits.stems(str(track), str(out / "stems"))


def run(a) -> dict:
    track = Path(a.track)
    out = Path(a.out) if a.out else track.parent / "rbx-prep"
    out.mkdir(parents=True, exist_ok=True)
    tool = {"stems": "instrumental", "extend": "extend-intro", "warp": "tighten"}.get(a.command, a.command)

    def need_grid():
        if not a.anlz:
            raise ValueError("This tool works from the beat grid: analyze the track first.")
        return grid.load_anlz_grid(a.anlz)

    if tool == "drift":
        beats, _ = need_grid()
        r = grid.drift_report(beats)
        summary = (f"Steady at {r['median_bpm']} BPM." if r["kind"] == "steady" else
                   f"Drifting: tempo wanders {r['tempo_span_bpm']} BPM, grid jitter {r['jitter_ms']} ms. "
                   "Warp it for a fixed grid.")
        return {"tool": tool, "summary": summary, "files": [], "details": r}

    if tool == "tighten":
        import librosa
        beats, nums = need_grid()
        # Beats are found at 22.05 kHz: plenty for kicks, and a 96 kHz file
        # at full rate needs gigabytes for the analysis. The warp itself
        # reads the original file at its own rate.
        y, sr = librosa.load(str(track), sr=22050, mono=True)
        # Warp maps the track's grid onto a straight one, so the grid has to
        # follow the music. Where it drifts against the kicks (a track whose
        # tempo wanders under a straight grid), the grid is first bent to
        # follow them, keeping its start, where a DJ lines up bar 1. A drift
        # that can't be followed is refused rather than locked in.
        original_first = float(beats[0])
        before = grid.drift_span(grid.drift_curve(beats, y, sr))
        followed = False
        if before > FOLLOW_DRIFT_MS:
            bent = grid.follow_kicks(beats, y, sr)
            after = grid.drift_span(grid.drift_curve(bent, y, sr)) if bent is not None else before
            if bent is None or after > FOLLOWED_MAX_MS:
                raise ValueError(
                    f"The grid drifts off the kicks (by up to {before:.0f} ms) and the kicks are too unclear "
                    "to follow. Fix the grid by hand first (BPM and bar 1 in GRID), then warp.")
            beats, followed = bent, True
        first_set = original_first
        smooth = grid.smooth_grid(beats, y, sr)
        if followed:
            # Bending only follows how the tempo changes; bar 1 stays where
            # the DJ put it.
            smooth = smooth - (smooth[0] - first_set)
        dst = out / f"{track.stem} (w).wav"
        r = edits.autowarp(str(track), str(dst), smooth, a.bpm)
        # The new file's grid is known exactly: every beat is where the warp
        # put it. The app writes it onto the new track instead of trusting a
        # re-analysis, which can land half a beat out on stretched audio.
        target = r.pop("beats")
        downbeats = [i for i, n in enumerate(nums) if n == 1]
        r["drift_before_ms"] = round(before, 1)
        r["followed_kicks"] = followed
        r["first_beat_s"] = float(target[0])
        r["downbeat_s"] = float(target[downbeats[0]]) if downbeats else float(target[0])
        note = f" The grid drifted {before:.0f} ms off the kicks, so it was bent to follow them first." if followed else ""
        return {"tool": tool, "files": [str(dst)], "details": r,
                "summary": f"Warped to a steady {r['bpm']} BPM (at most {r['max_stretch_pct']}% stretch).{note}"}

    if tool in ("instrumental", "acapella"):
        s = _stems(track, out)
        src = s["instrumental"] if tool == "instrumental" else s["vocals"]
        name = "Instrumental" if tool == "instrumental" else "Acapella"
        dst = out / f"{track.stem} ({name}).wav"
        if not dst.exists():
            part = dst.with_name(f".{dst.name}.part")
            part.write_bytes(Path(src).read_bytes())
            part.replace(dst)
        return {"tool": tool, "files": [str(dst)], "details": s, "summary": f"{name} ready."}

    beats, nums = need_grid()
    s = _stems(track, out)
    voc = edits.vocal_map(s["vocals"], s["instrumental"], beats)

    if tool == "cues":
        r = edits.auto_cues(beats, nums, voc, a.loop_bars)
        loop = r.get("memory_loop")
        if loop:
            extra = (f"{loop['bars']}-bar loop {_fmt(loop['start_s'])}–{_fmt(loop['end_s'])}"
                     + (" (only room for 4 bars before the vocal)" if loop["bars"] < a.loop_bars else "") + ".")
        else:
            extra = "No loop: the vocal starts too early for one."
        return {"tool": tool, "files": [], "details": r,
                "summary": f"First vocal at {_fmt(r['hot_cue']['s'])}; {extra}"}

    edges = np.append(beats, beats[-1] + np.median(np.diff(beats)))
    inst = edits._beat_rms(s["instrumental"], edges)
    if tool == "extend-intro":
        dst = out / f"{track.stem} (Extended Intro).wav"
        r = edits.extend_intro(str(track), str(dst), beats, nums, voc, inst, a.bars, a.repeats)
        where = "intro"
    else:
        dst = out / f"{track.stem} (Extended Outro).wav"
        r = edits.extend_outro(str(track), str(dst), beats, nums, voc, inst, a.bars, a.repeats)
        where = "outro"
    added = a.bars * a.repeats
    return {"tool": tool, "files": [str(dst)], "details": r,
            "summary": f"Added {added} bars to the {where}, looping the {a.bars} bars from {_fmt(r['looped_from_s'])}."}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="rbx-prep", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=TOOLS)
    p.add_argument("track")
    p.add_argument("--anlz", help="ANLZ0000.DAT holding the track's current grid")
    p.add_argument("--bpm", type=float, help="tighten: target BPM (default: nearest whole BPM)")
    p.add_argument("--bars", type=int, default=8)
    p.add_argument("--repeats", type=int, default=2)
    p.add_argument("--loop-bars", type=int, default=8)
    p.add_argument("--out", help="where new files go (default: an rbx-prep folder next to the track)")
    a = p.parse_args(argv)
    try:
        result = run(a)
    except (ValueError, FileNotFoundError) as e:
        print(json.dumps({"tool": a.command, "error": str(e)}))
        sys.exit(2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
