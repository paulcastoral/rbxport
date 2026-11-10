"""rbx-prep: set-prep helper for rbxport.

    rbx-prep drift    TRACK.aiff --anlz ANLZ0000.DAT
    rbx-prep tighten  TRACK.aiff --anlz ANLZ0000.DAT   # smooth + auto-warp to a fixed grid
    rbx-prep stems    TRACK.aiff
    rbx-prep cues     TRACK.aiff --anlz ANLZ0000.DAT
    rbx-prep extend   TRACK.aiff --anlz ANLZ0000.DAT --bars 8 --repeats 2

Every command prints JSON and writes new files next to the input; originals are never changed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np

from . import edits, grid


def _grid(args):
    beats, nums = grid.load_anlz_grid(args.anlz)
    return beats, nums


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="rbx-prep", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["drift", "tighten", "stems", "cues", "extend"])
    p.add_argument("track")
    p.add_argument("--anlz", help="ANLZ0000.DAT holding the track's current grid")
    p.add_argument("--bpm", type=float, help="tighten: target BPM (default: nearest whole BPM)")
    p.add_argument("--bars", type=int, default=8)
    p.add_argument("--repeats", type=int, default=2)
    p.add_argument("--loop-bars", type=int, default=8)
    p.add_argument("--stems-dir", default=None)
    a = p.parse_args(argv)
    track = Path(a.track)
    stems_dir = a.stems_dir or str(track.parent / "stems")
    result: dict

    if a.command == "drift":
        beats, _ = _grid(a)
        result = grid.drift_report(beats)
    elif a.command == "tighten":
        beats, _ = _grid(a)
        y, sr = librosa.load(str(track), sr=None, mono=True)
        smooth = grid.smooth_grid(beats, y, sr)
        dst = track.with_name(f"{track.stem} (tight).wav")
        result = edits.autowarp(str(track), str(dst), smooth, a.bpm)
        result["file"] = str(dst)
        result.pop("beats")
    elif a.command == "stems":
        result = edits.stems(str(track), stems_dir)
    else:
        beats, nums = _grid(a)
        s = edits.stems(str(track), stems_dir)
        voc = edits.vocal_map(s["vocals"], s["instrumental"], beats)
        if a.command == "cues":
            result = edits.auto_cues(beats, nums, voc, a.loop_bars)
        else:
            edges = np.append(beats, beats[-1] + np.median(np.diff(beats)))
            inst = edits._beat_rms(s["instrumental"], edges)
            dst = track.with_name(f"{track.stem} (Extended Intro).wav")
            result = edits.extend_intro(str(track), str(dst), beats, nums, voc, inst, a.bars, a.repeats)
            result["file"] = str(dst)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
