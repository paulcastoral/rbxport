"""Audio edits: auto-warp, stems, vocal-aware cues, extended intros."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf


def autowarp(src: str, dst: str, beats: np.ndarray, bpm: float | None = None) -> dict:
    """Stretch audio so `beats` land on a constant grid (Rubber Band R3 engine).

    Returns the new straight grid. The original file is never touched.
    """
    info = sf.info(src)
    sr, frames = info.samplerate, info.frames
    period = float(np.median(np.diff(beats)))
    bpm = bpm or round(60 / period)
    P = 60 / bpm
    target = beats[0] + np.arange(len(beats)) * P
    end_src = frames / sr
    end_tgt = target[-1] + (end_src - beats[-1]) * (P / np.median(np.diff(beats[-16:])))
    with tempfile.TemporaryDirectory() as tmp:
        tmap = Path(tmp, "timemap.txt")
        tmap.write_text("".join(f"{round(s * sr)} {round(d * sr)}\n" for s, d in zip(beats, target)))
        wav = Path(tmp, "src.wav")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, str(wav)], check=True)
        subprocess.run(["rubberband", "-3", "--timemap", str(tmap), "--duration", f"{end_tgt:.4f}",
                        str(wav), dst], check=True, capture_output=True)
    stretch = float(np.abs(np.diff(beats) / P - 1).max() * 100)
    return {"bpm": bpm, "first_beat_s": float(beats[0]), "max_stretch_pct": round(stretch, 2),
            "beats": target.tolist()}


def stems(src: str, out_dir: str, model: str = "htdemucs") -> dict:
    """Vocal / instrumental split with Demucs. Returns the two stem paths."""
    subprocess.run(["python", "-m", "demucs", "--two-stems", "vocals", "-n", model, "-o", out_dir, src],
                   check=True)
    d = Path(out_dir, model, Path(src).stem)
    return {"vocals": str(d / "vocals.wav"), "instrumental": str(d / "no_vocals.wav")}


def _beat_rms(path: str, edges: np.ndarray) -> np.ndarray:
    x, sr = sf.read(path)
    x = x.mean(1) if x.ndim > 1 else x
    return np.array([np.sqrt(np.mean(x[int(edges[i] * sr):int(edges[i + 1] * sr)] ** 2) + 1e-12)
                     for i in range(len(edges) - 1)])


def vocal_map(vocals: str, instrumental: str, beats: np.ndarray, margin_db: float = 12) -> np.ndarray:
    """True for each beat where the vocal stem is near its loudest relative to the band."""
    edges = np.append(beats, beats[-1] + np.median(np.diff(beats)))
    ratio = 20 * np.log10(_beat_rms(vocals, edges) / _beat_rms(instrumental, edges))
    return ratio > np.percentile(ratio, 95) - margin_db


def first_sustained(voc: np.ndarray, need: int = 3, span: int = 4) -> int:
    """First beat where the vocal holds for `need` of `span` beats; stray blips don't count."""
    for i in range(len(voc) - span):
        if voc[i:i + span].sum() >= need:
            return i
    return len(voc)


def last_sustained(voc: np.ndarray, need: int = 3, span: int = 4) -> int:
    """Last beat of the final held vocal; -1 when there is none."""
    for i in range(len(voc) - span, -1, -1):
        if voc[i:i + span].sum() >= need:
            return i + span - 1
    return -1


def auto_cues(beats: np.ndarray, beat_num: np.ndarray, voc: np.ndarray, loop_bars: int = 8) -> dict:
    """Red hot cue on the first sustained vocal; memory loop of `loop_bars` ending at its bar."""
    first = first_sustained(voc)
    if first >= len(beats):
        raise ValueError("No vocal found, so there is nothing to cue on.")
    down = np.where(beat_num == 1)[0]
    vbar = down[down <= first].max() if (down <= first).any() else down[0]
    cue = first if first - vbar > 1 else vbar  # a pickup vocal gets cued on its own beat
    before = down[down <= vbar - 4 * loop_bars]
    loop_start = before.max() if len(before) else down[0]
    P = float(np.median(np.diff(beats)))
    return {"hot_cue": {"slot": "A", "color": "red", "s": float(beats[cue])},
            "memory_loop": {"start_s": float(beats[loop_start]),
                            "end_s": float(beats[loop_start] + 4 * loop_bars * P)},
            "first_vocal_beat": int(first)}


def extend_intro(src: str, dst: str, beats: np.ndarray, beat_num: np.ndarray, voc: np.ndarray,
                 inst_rms: np.ndarray | None = None, bars: int = 8, repeats: int = 2) -> dict:
    """Repeat a clean, vocal-free block of `bars` bars in the intro. Sample-accurate; no time lost."""
    y, sr = sf.read(src)
    P = float(np.median(np.diff(beats)))
    first_voc = first_sustained(voc)
    down = np.where(beat_num == 1)[0]
    energy = inst_rms if inst_rms is not None else np.ones(len(beats))
    cands = []
    for d in down:
        if d + 4 * bars > first_voc:
            break
        if d < 8:
            continue
        e = energy[d:d + 4 * bars].reshape(bars, 4).mean(1)
        cands.append((int(d), float(e.mean()), float(e.std() / e.mean())))
    if not cands:
        raise ValueError("The vocals start too early for a clean loop: make an Instrumental first, or try fewer bars.")
    med = np.median([c[1] for c in cands])
    good = [c for c in cands if c[1] >= med and c[2] < 0.12]
    d = (good[0] if good else max(cands, key=lambda c: c[1]))[0]
    s0 = round(beats[d] * sr)
    # The block ends on the grid's own beat, so a drifting track loops cleanly too.
    end = beats[d + 4 * bars] if d + 4 * bars < len(beats) else beats[d] + 4 * bars * P
    s1 = round(end * sr)
    L = s1 - s0
    out = np.concatenate([y[:s1]] + [y[s0:s1]] * repeats + [y[s1:]])
    xf = int(0.004 * sr)
    f = np.linspace(0, 1, xf)[:, None] if y.ndim > 1 else np.linspace(0, 1, xf)
    for k in range(repeats):  # each join jumps from "would continue at s1" back to s0
        p = s1 + k * L
        out[p:p + xf] = y[s1:s1 + xf] * (1 - f) + y[s0:s0 + xf] * f
    sf.write(dst, out, sr, subtype="PCM_16")
    return {"looped_from_s": float(beats[d]), "bars": bars, "repeats": repeats,
            "added_s": repeats * L / sr, "shift_cues_by_s": repeats * L / sr}


def extend_outro(src: str, dst: str, beats: np.ndarray, beat_num: np.ndarray, voc: np.ndarray,
                 inst_rms: np.ndarray | None = None, bars: int = 8, repeats: int = 2) -> dict:
    """Repeat the last clean, vocal-free block of `bars` bars before the end.

    Cues before the block keep their positions.
    """
    y, sr = sf.read(src)
    P = float(np.median(np.diff(beats)))
    last_voc = last_sustained(voc)
    down = np.where(beat_num == 1)[0]
    energy = inst_rms if inst_rms is not None else np.ones(len(beats))
    cands = []
    for d in down[::-1]:
        if d <= last_voc:
            break
        if d + 4 * bars > len(beats) - 4:  # leave the final beats alone
            continue
        e = energy[d:d + 4 * bars].reshape(bars, 4).mean(1)
        cands.append((int(d), float(e.mean()), float(e.std() / e.mean())))
    if not cands:
        raise ValueError("The vocals run to the end, so there is no clean block to loop: make an Instrumental first, or try fewer bars.")
    med = np.median([c[1] for c in cands])
    good = [c for c in cands if c[1] >= med and c[2] < 0.12]
    d = (good[0] if good else max(cands, key=lambda c: c[1]))[0]
    s0 = round(beats[d] * sr)
    # The block ends on the grid's own beat, so a drifting track loops cleanly too.
    end = beats[d + 4 * bars] if d + 4 * bars < len(beats) else beats[d] + 4 * bars * P
    s1 = round(end * sr)
    L = s1 - s0
    out = np.concatenate([y[:s1]] + [y[s0:s1]] * repeats + [y[s1:]])
    xf = int(0.004 * sr)
    f = np.linspace(0, 1, xf)[:, None] if y.ndim > 1 else np.linspace(0, 1, xf)
    for k in range(repeats):
        p = s1 + k * L
        out[p:p + xf] = y[s1:s1 + xf] * (1 - f) + y[s0:s0 + xf] * f
    sf.write(dst, out, sr, subtype="PCM_16")
    return {"looped_from_s": float(beats[d]), "bars": bars, "repeats": repeats,
            "added_s": repeats * L / sr, "shift_cues_by_s": 0.0}
