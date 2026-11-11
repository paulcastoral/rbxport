"""Beat-grid helpers: kick envelope, drift smoothing, alignment scoring."""
from __future__ import annotations

import numpy as np
import scipy.signal as ss
import librosa
from pyrekordbox.anlz import AnlzFile


def load_anlz_grid(path: str) -> tuple[np.ndarray, np.ndarray]:
    """Beat times (s) and beat-in-bar numbers (1-4) from an ANLZ .DAT PQTZ tag."""
    g = AnlzFile.parse_file(path).get_tag("PQTZ")
    return np.asarray(g.times, float), np.asarray(g.beats, int)


def kick_env(y: np.ndarray, sr: int, hop: int = 64) -> tuple[np.ndarray, float]:
    """Low-band spectral flux; peaks sit on kicks. Returns (envelope, seconds per frame)."""
    b, a = ss.butter(4, 150 / (sr / 2))
    lo = ss.filtfilt(b, a, y)
    S = np.abs(librosa.stft(lo, n_fft=1024, hop_length=hop))
    flux = np.maximum(0, np.diff(np.log1p(100 * S), axis=1)).sum(0)
    flux = np.concatenate([[0], flux])
    return flux / (flux.max() + 1e-9), hop / sr


def local_fit(t: np.ndarray, half: int = 16) -> np.ndarray:
    """Tricube-weighted local linear fit of beat time vs beat index.

    Keeps slow drift (a live drummer), removes beat-to-beat jitter.
    """
    n = np.arange(len(t), dtype=float)
    out = np.empty_like(t)
    for i in range(len(t)):
        lo, hi = max(0, i - half), min(len(t), i + half + 1)
        w = (1 - (np.abs(n[lo:hi] - i) / (half + 1)) ** 3) ** 3
        A = np.vstack([n[lo:hi], np.ones(hi - lo)]).T * np.sqrt(w)[:, None]
        k, b = np.linalg.lstsq(A, t[lo:hi] * np.sqrt(w), rcond=None)[0]
        out[i] = k * i + b
    return out


def offsets(t: np.ndarray, env: np.ndarray, dt: float, win: float = 0.035) -> np.ndarray:
    """Signed distance (s) from each beat to the strongest nearby kick; NaN if none."""
    out = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        a, b = int((x - win) / dt), int((x + win) / dt)
        if a < 0 or b >= len(env):
            continue
        seg = env[a:b]
        j = seg.argmax()
        if seg[j] > 0.15:
            out[i] = (a + j) * dt - x
    return out


def score(t: np.ndarray, env: np.ndarray, dt: float) -> tuple[float, float]:
    """Median and 90th-percentile |kick offset| in ms."""
    o = offsets(t, env, dt, 0.04)
    o = np.abs(o[~np.isnan(o)]) * 1000
    return float(np.median(o)), float(np.percentile(o, 90))


def smooth_grid(t: np.ndarray, y: np.ndarray, sr: int) -> np.ndarray:
    """Smooth a jittery dynamic grid, then pull it onto the kicks and smooth again."""
    env, dt = kick_env(y, sr)
    s1 = local_fit(t)
    o = offsets(s1, env, dt)
    good = ~np.isnan(o)
    n = np.arange(len(t), dtype=float)
    corr = np.interp(n, n[good], ss.medfilt(o[good], 9)) if good.sum() > 9 else 0.0
    return local_fit(s1 + corr)


def drift_report(t: np.ndarray) -> dict:
    """Classify a grid: steady, drifting or jittery."""
    ibi = np.diff(t)
    sm = local_fit(t)
    tempo = 60 / np.diff(sm)
    jitter_ms = float(np.std(t - sm) * 1000)
    span = float(tempo.max() - tempo.min())
    kind = "steady" if span < 0.3 and jitter_ms < 2 else "drifting"
    return {
        "kind": kind,
        "median_bpm": round(float(60 / np.median(ibi)), 2),
        "tempo_span_bpm": round(span, 2),
        "jitter_ms": round(jitter_ms, 1),
    }


def kick_match(beats: np.ndarray, y: np.ndarray, sr: int) -> float:
    """Share of grid beats with a kick within 35 ms: how far a grid can be trusted."""
    env, dt = kick_env(y, sr)
    o = offsets(beats, env, dt)
    return float(np.mean(~np.isnan(o))) if len(o) else 0.0



def sub_attacks(y: np.ndarray, sr: int, sr_work: int = 11025) -> tuple[np.ndarray, float]:
    """Attack strength of the sub-bass (30-60 Hz), where mostly the kick lives."""
    if sr != sr_work:
        y = librosa.resample(y, orig_sr=sr, target_sr=sr_work)
    sos = ss.butter(4, [30 / (sr_work / 2), 60 / (sr_work / 2)], btype="band", output="sos")
    env = np.abs(ss.hilbert(ss.sosfiltfilt(sos, y)))
    env = ss.sosfiltfilt(ss.butter(2, 50 / (sr_work / 2), output="sos"), env)
    return np.maximum(np.diff(env, prepend=env[0]), 0), 1.0 / sr_work


def drift_curve(beats: np.ndarray, y: np.ndarray, sr: int, window: float = 20.0, hop: float = 5.0,
                min_coherence: float = 0.35) -> tuple[np.ndarray, np.ndarray] | None:
    """Where the kicks sit against a grid, window by window, in ms.

    Measured on the sub-bass, whose attack reads late by a fixed amount
    (about 80 ms), so only the *changes* along the track mean anything: flat
    on a grid that follows the music, a slope or a bend where it drifts.
    Checked flat (within about 15 ms) on a steady 135 BPM track. Returns
    (window centres in s, offsets in ms), or None with too few clear kicks.
    """
    d, dt = sub_attacks(y, sr)
    t = np.arange(len(d)) * dt
    period = float(np.median(np.diff(beats)))
    index = np.arange(len(beats), dtype=float)
    centres, phases = [], []
    for a in np.arange(0.0, t[-1] - window / 2, hop):
        sel = (t >= a) & (t < a + window)
        ref = np.interp(t[sel], beats, index, left=np.nan, right=np.nan)
        ok = ~np.isnan(ref)
        w = d[sel][ok]
        if ok.sum() < 10 or w.sum() <= 0:
            continue
        z = np.sum(w * np.exp(2j * np.pi * ref[ok])) / w.sum()
        if abs(z) >= min_coherence:
            centres.append(a + window / 2)
            phases.append(np.angle(z) / (2 * np.pi))
    if len(centres) < 6:
        return None
    off = np.unwrap(np.array(phases) * 2 * np.pi) / (2 * np.pi) * period * 1000
    return np.array(centres), off


def drift_span(curve: tuple[np.ndarray, np.ndarray] | None) -> float:
    """How far, in ms, the kicks wander against the grid over the track (smoothed)."""
    if curve is None:
        return 0.0
    off = curve[1]
    if len(off) >= 7:
        off = ss.savgol_filter(off, 7, 2)
    return float(off.max() - off.min())


def follow_kicks(beats: np.ndarray, y: np.ndarray, sr: int, anchor_s: float = 60.0) -> np.ndarray | None:
    """The grid bent to follow a track whose tempo wanders, keeping its start.

    The grid's own placement over the first `anchor_s` seconds is trusted
    (that is where a DJ lines up bar 1); every beat after moves by how much
    the kicks have wandered since. None when the kicks are too unclear.
    """
    curve = drift_curve(beats, y, sr)
    if curve is None:
        return None
    c, off = curve
    if len(off) >= 7:
        off = ss.savgol_filter(off, 7, 2)
    start = c <= max(anchor_s, c[0])
    rel = off - float(np.median(off[start]))
    return beats + np.interp(beats, c, rel) / 1000.0
