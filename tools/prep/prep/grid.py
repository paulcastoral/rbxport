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
