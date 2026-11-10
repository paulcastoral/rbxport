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

TOOLS = ["drift", "tighten", "cues", "extend-intro", "extend-outro", "instrumental", "acapella",
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
    tool = {"stems": "instrumental", "extend": "extend-intro"}.get(a.command, a.command)

    def need_grid():
        if not a.anlz:
            raise ValueError("This tool works from the beat grid: analyze the track first.")
        return grid.load_anlz_grid(a.anlz)

    if tool == "drift":
        beats, _ = need_grid()
        r = grid.drift_report(beats)
        summary = (f"Steady at {r['median_bpm']} BPM." if r["kind"] == "steady" else
                   f"Drifting: tempo wanders {r['tempo_span_bpm']} BPM, grid jitter {r['jitter_ms']} ms. "
                   "Tighten it for a fixed grid.")
        return {"tool": tool, "summary": summary, "files": [], "details": r}

    if tool == "tighten":
        import librosa
        beats, _ = need_grid()
        y, sr = librosa.load(str(track), sr=None, mono=True)
        smooth = grid.smooth_grid(beats, y, sr)
        dst = out / f"{track.stem} (tight).wav"
        r = edits.autowarp(str(track), str(dst), smooth, a.bpm)
        r.pop("beats")
        return {"tool": tool, "files": [str(dst)], "details": r,
                "summary": f"Warped to a steady {r['bpm']} BPM (at most {r['max_stretch_pct']}% stretch)."}

    if tool in ("instrumental", "acapella"):
        s = _stems(track, out)
        src = s["instrumental"] if tool == "instrumental" else s["vocals"]
        name = "Instrumental" if tool == "instrumental" else "Acapella"
        dst = out / f"{track.stem} ({name}).wav"
        if not dst.exists():
            dst.write_bytes(Path(src).read_bytes())
        return {"tool": tool, "files": [str(dst)], "details": s, "summary": f"{name} ready."}

    beats, nums = need_grid()
    s = _stems(track, out)
    voc = edits.vocal_map(s["vocals"], s["instrumental"], beats)

    if tool == "cues":
        r = edits.auto_cues(beats, nums, voc, a.loop_bars)
        loop = r["memory_loop"]
        return {"tool": tool, "files": [], "details": r,
                "summary": (f"Red hot cue on the first vocal at {_fmt(r['hot_cue']['s'])}; "
                            f"{a.loop_bars}-bar loop {_fmt(loop['start_s'])}–{_fmt(loop['end_s'])}.")}

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
