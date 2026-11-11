/**
 * GridBin's Library Cleanup: which copy of a duplicate to keep, and how the
 * playlists of the copies that go are handed to it. Pure, so it is tested
 * on its own; the dialog only asks the backend and applies the answer.
 */
import type { DuplicateTrack } from "@/ipc/types";

/** Lossless files rank above lossy ones whatever their bitrate. */
const LOSSLESS = new Set([5, 11, 12]); // FLAC, WAV, AIFF

/** A copy with what the choice weighs: `cues` comes from the cue list. */
export interface Copy extends DuplicateTrack {
  cues: number;
}

/**
 * The copy to keep, best first by: file there, more cues, more playlists,
 * lossless, higher bitrate, analysed, added first. Each step only decides
 * when the ones above tie, so a copy with its file missing never wins over
 * one that plays.
 */
export function rankCopies(copies: readonly Copy[]): Copy[] {
  const key = (c: Copy): (number | string)[] => [
    c.present ? 0 : 1,
    -c.cues,
    -c.playlists,
    LOSSLESS.has(c.fileType) ? 0 : 1,
    -c.bitrate,
    c.analysed ? 0 : 1,
    c.dateAdded || "9999",
  ];
  return [...copies].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const x = ka[i] ?? 0;
      const y = kb[i] ?? 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}

/** Why `keep` was suggested over the others, in a few words. */
export function keepReason(keep: Copy, others: readonly Copy[]): string {
  if (others.some((o) => !o.present) && keep.present) return "the only one whose file is there";
  if (others.every((o) => o.cues < keep.cues)) return `most cues (${keep.cues})`;
  if (others.every((o) => o.playlists < keep.playlists)) return `in the most playlists (${keep.playlists})`;
  if (LOSSLESS.has(keep.fileType) && others.some((o) => !LOSSLESS.has(o.fileType))) return "lossless";
  if (others.every((o) => o.bitrate < keep.bitrate)) return "highest bitrate";
  if (keep.analysed && others.some((o) => !o.analysed)) return "already analysed";
  return "added first";
}

/**
 * A playlist's new order once `gone` leaves and `keep` takes its place: the
 * kept copy where the removed one was, never twice.
 */
export function handOver(tracks: readonly string[], gone: string, keep: string): string[] {
  const keepThere = tracks.includes(keep);
  const out: string[] = [];
  for (const t of tracks) {
    if (t === gone) {
      if (!keepThere && !out.includes(keep)) out.push(keep);
    } else if (t !== keep || !out.includes(keep)) {
      out.push(t);
    }
  }
  return out;
}

/** "AIFF 1411 kbps · 44.1 kHz" for a copy, from its FileType code. */
export function formatLabel(c: DuplicateTrack): string {
  const kind = ({ 1: "MP3", 4: "M4A", 5: "FLAC", 11: "WAV", 12: "AIFF" } as Record<number, string>)[c.fileType] ?? "";
  const parts = [kind, c.bitrate ? `${c.bitrate} kbps` : "", c.sampleRate ? `${(c.sampleRate / 1000).toFixed(1)} kHz` : ""];
  return parts.filter(Boolean).join(" · ");
}
