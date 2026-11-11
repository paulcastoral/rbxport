"""Audio edits: auto-warp, stems, vocal-aware cues, extended intros."""
from __future__ import annotations

import shutil
import subprocess
import sys
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
        part = Path(tmp, "warped.wav")
        subprocess.run(["rubberband", "-3", "--timemap", str(tmap), "--duration", f"{end_tgt:.4f}",
                        str(wav), str(part)], check=True, capture_output=True)
        shutil.move(str(part), dst)
    stretch = float(np.abs(np.diff(beats) / P - 1).max() * 100)
    # Where each beat moved to: a cue anywhere in the track maps through it.
    timemap = [[round(float(a), 4), round(float(b), 4)] for a, b in zip(beats, target)]
    return {"bpm": bpm, "first_beat_s": float(beats[0]), "max_stretch_pct": round(stretch, 2),
            "beats": target.tolist(), "timemap": timemap}


def stems(src: str, out_dir: str, model: str = "htdemucs") -> dict:
    """Vocal / instrumental split with Demucs. Returns the two stem paths.

    Demucs writes into a scratch folder that is moved into place only once
    both stems exist, so a stopped run never leaves half a cache behind.
    """
    final = Path(out_dir, model, Path(src).stem)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out_dir, prefix=".stems-") as tmp:
        subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", model, "-o", tmp, src],
                       check=True)
        made = Path(tmp, model, Path(src).stem)
        final.parent.mkdir(parents=True, exist_ok=True)
        if final.exists():
            shutil.rmtree(final)
        made.rename(final)
    return {"vocals": str(final / "vocals.wav"), "instrumental": str(final / "no_vocals.wav")}


def write_atomic(dst: str, data: np.ndarray, sr: int) -> None:
    """Write next to `dst` and rename over it, so a stopped run leaves no partial file."""
    part = Path(dst).with_name(f".{Path(dst).name}.part")
    sf.write(str(part), data, sr, subtype="PCM_16", format="WAV")
    part.replace(dst)


def _beat_rms(path: str, edges: np.ndarray) -> np.ndarray:
    x, sr = sf.read(path)
    x = x.mean(1) if x.ndim > 1 else x
    return np.array([np.sqrt(np.mean(x[int(edges[i] * sr):int(edges[i + 1] * sr)] ** 2) + 1e-12)
                     for i in range(len(edges) - 1)])


def vocal_map(vocals: str, instrumental: str, beats: np.ndarray, margin_db: float = 12,
              floor_db: float = 15) -> np.ndarray:
    """True for each beat where the vocal stem is really singing.

    Two tests: the vocal is near its own loudest relative to the band, and it
    is loud in its own right (within `floor_db` of the track's typical sung
    level). The second keeps a quiet intro, where a little synth bleeds into
    the vocal stem, from passing just because the band is quiet too.
    """
    edges = np.append(beats, beats[-1] + np.median(np.diff(beats)))
    vr = _beat_rms(vocals, edges)
    ratio = 20 * np.log10(vr / _beat_rms(instrumental, edges))
    loud = 20 * np.log10(vr / np.percentile(vr, 95)) > -floor_db
    return (ratio > np.percentile(ratio, 95) - margin_db) & loud

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
    """Red hot cue on the first held vocal; a memory loop over the bars before it.

    A vocal counts once it holds for 6 of 8 beats, so a stray syllable or a
    sample in the intro doesn't. When there is no room for `loop_bars` before
    the vocal, the loop shrinks to 4 bars, and is left out with less than that.
    """
    first = first_sustained(voc, need=6, span=8)
    if first >= len(beats):
        raise ValueError("No held vocal found, so there is nothing to cue on.")
    down = np.where(beat_num == 1)[0]
    vbar = down[down <= first].max() if (down <= first).any() else down[0]
    cue = first if first - vbar > 1 else vbar  # a pickup vocal gets cued on its own beat
    out = {"hot_cue": {"slot": "A", "color": "red", "s": float(beats[cue])}, "first_vocal_beat": int(first)}
    room = int((vbar - down[0]) // 4) if len(down) else 0
    bars = loop_bars if room >= loop_bars else 4 if room >= 4 else 0
    if bars:
        start = int(down[down <= vbar - 4 * bars].max())
        end = beats[start + 4 * bars] if start + 4 * bars < len(beats) else beats[vbar]
        out["memory_loop"] = {"start_s": float(beats[start]), "end_s": float(end), "bars": bars}
    return out

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
    write_atomic(dst, out, sr)
    return {"looped_from_s": float(beats[d]), "inserted_at_s": s1 / sr, "bars": bars, "repeats": repeats,
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
    write_atomic(dst, out, sr)
    return {"looped_from_s": float(beats[d]), "inserted_at_s": s1 / sr, "bars": bars, "repeats": repeats,
            "added_s": repeats * L / sr, "shift_cues_by_s": 0.0}
