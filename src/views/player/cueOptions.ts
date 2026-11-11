import type { PrepOptions } from "@/ipc/types";

/** AUTO CUES' settings, shared by the EDITOR panel and the EDIT tab. */
export interface CueOptions {
  /** Mix-in memory loop before the vocal, in bars; 0 for none. */
  loopBars: number;
  /** Where the red cue goes: the beat nearest the vocal, its exact start, or its bar. */
  cueSnap: NonNullable<PrepOptions["cueSnap"]>;
  /** Exit memory loop after the last vocal, in bars; 0 for none. */
  exitBars: number;
}

export const LOOP_CHOICES = [0, 1, 2, 4, 8, 16] as const;
export const SNAP_CHOICES = ["beat", "exact", "bar"] as const;
export const DEFAULT_CUE_OPTIONS: CueOptions = { loopBars: 4, cueSnap: "beat", exitBars: 4 };

const KEY = "gridbin.cueOptions";

function bars(value: unknown, fallback: number): number {
  return typeof value === "number" && (LOOP_CHOICES as readonly number[]).includes(value) ? value : fallback;
}

export function loadCueOptions(): CueOptions {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return DEFAULT_CUE_OPTIONS;
    const saved = raw as Record<string, unknown>;
    const snap = SNAP_CHOICES.find((choice) => choice === saved.cueSnap);
    return {
      loopBars: bars(saved.loopBars, DEFAULT_CUE_OPTIONS.loopBars),
      cueSnap: snap ?? DEFAULT_CUE_OPTIONS.cueSnap,
      exitBars: bars(saved.exitBars, DEFAULT_CUE_OPTIONS.exitBars),
    };
  } catch {
    return DEFAULT_CUE_OPTIONS;
  }
}

export function saveCueOptions(options: CueOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {
    // Only the convenience of remembering is lost.
  }
}
