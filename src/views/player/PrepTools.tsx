/**
 * Set-prep tools (tools/prep): tighten a drifting grid, place vocal-aware
 * cues, extend an intro or outro, split stems.
 *
 * Not rekordbox's. Drawn two ways from the same state: `compact` is the EDIT
 * tab beside CUE/LOOP and GRID, one row of buttons with the last result
 * beside them; the full panel is the EDITOR layout's, with the options and a
 * list of everything run on the track this session.
 *
 * Every tool writes new files next to the track and leaves the track, its
 * grid and its cues alone, so nothing here asks for confirmation.
 */
import { useCallback, useEffect, useState } from "react";

import { getBackend } from "@/ipc/client";
import type { PrepOptions, PrepResult, PrepTool } from "@/ipc/types";
import styles from "./PrepTools.module.css";

interface ToolSpec {
  id: PrepTool;
  label: string;
  /** Under the label in the full panel. */
  hint: string;
  group: "GRID" | "CUES" | "EDIT" | "STEMS";
  slow?: boolean;
}

export const PREP_TOOLS: readonly ToolSpec[] = [
  { id: "drift", label: "CHECK DRIFT", hint: "Steady or drifting?", group: "GRID" },
  { id: "tighten", label: "TIGHTEN", hint: "Warp to a fixed BPM", group: "GRID" },
  { id: "cues", label: "AUTO CUES", hint: "Places loop + red cue", group: "CUES", slow: true },
  { id: "extend-intro", label: "EXT INTRO", hint: "Loop clean intro bars", group: "EDIT", slow: true },
  { id: "extend-outro", label: "EXT OUTRO", hint: "Loop clean outro bars", group: "EDIT", slow: true },
  { id: "instrumental", label: "INSTRUMENTAL", hint: "Vocals removed", group: "STEMS", slow: true },
  { id: "acapella", label: "ACAPELLA", hint: "Vocals only", group: "STEMS", slow: true },
];

const GROUPS = ["GRID", "CUES", "EDIT", "STEMS"] as const;

interface Run {
  id: string;
  tool: PrepTool;
  result?: PrepResult;
  error?: string;
  /** Stopped from the panel: not an error, nothing was kept. */
  stopped?: boolean;
  /** Its files went to the Trash, and its cues were deleted. */
  undone?: boolean;
  /** Cues AUTO CUES put on the track, which Undo deletes. */
  cueIds?: string[];
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "The tool failed.";
}

function isCancelled(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "kind" in error && error.kind === "cancelled");
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Whether a run left something Undo can take back. */
function canUndo(entry: Run | undefined): entry is Run {
  return Boolean(entry && !entry.undone && ((entry.result?.files.length ?? 0) > 0 || (entry.cueIds?.length ?? 0) > 0));
}

/** A finished run in one line. */
function describe(entry: Run): string {
  if (entry.stopped) return "Stopped. Nothing was kept from this run.";
  if (entry.undone) return entry.cueIds?.length ? "Undone: its cues were removed." : "Undone: its files are in the Trash.";
  return entry.result?.summary ?? "";
}

/** rekordbox's hot-cue red, as the CUE colour menu offers it (ColorTableIndex 41). */
const HOT_CUE_RED = 41;
/** A cue this close to one already on the track is taken to be the same cue. */
const SAME_CUE_MS = 60;

interface CuePlan {
  hot_cue?: { s: number };
  memory_loop?: { start_s: number; end_s: number; bars?: number };
}

/**
 * Puts AUTO CUES' answer on the track: a red hot cue named "Vocal" on the
 * first held vocal, in pad A or the first free pad, and a memory loop named
 * "Mix in" over the bars before it. A cue already there at the same spot is
 * left as it is, and no existing cue is moved or replaced. Resolves to the
 * ids it made and a line saying what it did.
 */
async function placeCues(trackId: string, details: Record<string, unknown>, loopBars: number): Promise<{ ids: string[]; note: string }> {
  const backend = await getBackend();
  const plan = details as CuePlan;
  const existing = await backend.trackCues(trackId);
  const ids: string[] = [];
  const notes: string[] = [];
  const near = (ms: number, memory: boolean) =>
    existing.some((c) => c.memory === memory && Math.abs(c.positionMs - ms) <= SAME_CUE_MS);

  if (plan.hot_cue) {
    const ms = Math.round(plan.hot_cue.s * 1000);
    const used = new Set(existing.filter((c) => c.letter).map((c) => c.letter));
    const letter = "ABCDEFGH".split("").find((l) => !used.has(l));
    if (near(ms, false)) notes.push("hot cue already there");
    else if (!letter) notes.push("no free pad for the hot cue (A–H are full)");
    else {
      const id = await backend.edits.addCue(trackId, { hot: letter }, ms);
      ids.push(id);
      await backend.edits.setCueColour(id, HOT_CUE_RED);
      await backend.edits.setCueComment(id, "Vocal");
      notes.push(`red hot cue on pad ${letter}`);
    }
  }
  if (plan.memory_loop) {
    const inMs = Math.round(plan.memory_loop.start_s * 1000);
    const outMs = Math.round(plan.memory_loop.end_s * 1000);
    if (near(inMs, true)) notes.push("loop already there");
    else {
      // The tool shortens the loop when the vocal comes in early.
      const bars = plan.memory_loop.bars ?? loopBars;
      const id = await backend.edits.addLoop(trackId, "memory", inMs, outMs, bars * 4);
      ids.push(id);
      await backend.edits.setCueComment(id, "Mix in");
      notes.push(`${bars}-bar memory loop`);
    }
  }
  return { ids, note: notes.length ? `Placed: ${notes.join(", ")}.` : "" };
}

/** One deck's prep state: what is running and what has run on its track. */
export function usePrep(trackId: string | null) {
  const [busy, setBusy] = useState<{ tool: PrepTool; id: string } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A new track starts a new history. A run still going keeps going; its
  // files stay, and Stop is still offered until it ends.
  useEffect(() => { setRuns([]); setError(null); }, [trackId]);

  const run = useCallback(async (tool: PrepTool, options?: PrepOptions) => {
    if (!trackId || busy) return;
    const id = crypto.randomUUID();
    setBusy({ tool, id });
    setError(null);
    try {
      const result = await (await getBackend()).prep(trackId, tool, options, id);
      if (tool === "cues") {
        // The tool only finds the spots; the cues themselves go on the
        // track here, through the same edits the CUE panel uses.
        try {
          const placed = await placeCues(trackId, result.details, options?.loopBars ?? 8);
          const summary = placed.note ? `${result.summary} ${placed.note}` : result.summary;
          setRuns((was) => [{ id, tool, result: { ...result, summary }, cueIds: placed.ids }, ...was]);
        } catch (failure) {
          setRuns((was) => [{ id, tool, error: `Found the cues but could not place them: ${message(failure)}` }, ...was]);
        }
        return;
      }
      setRuns((was) => [{ id, tool, result }, ...was]);
    } catch (failure) {
      setRuns((was) => [isCancelled(failure) ? { id, tool, stopped: true } : { id, tool, error: message(failure) }, ...was]);
    } finally {
      setBusy(null);
    }
  }, [trackId, busy]);

  const stop = useCallback(async () => {
    if (busy) await (await getBackend()).prepCancel(busy.id);
  }, [busy]);

  const undo = useCallback(async (id: string) => {
    const entry = runs.find((r) => r.id === id);
    const files = entry?.result?.files ?? [];
    const cueIds = entry?.cueIds ?? [];
    if (!entry || entry.undone || (files.length === 0 && cueIds.length === 0)) return;
    try {
      const backend = await getBackend();
      if (files.length) await backend.prepUndo(files);
      for (const cue of cueIds) await backend.edits.deleteCue(cue);
      setRuns((was) => was.map((r) => (r.id === id ? { ...r, undone: true } : r)));
    } catch (failure) {
      setError(message(failure));
    }
  }, [runs]);

  return { busy, runs, run, stop, undo, error };
}

export interface PrepToolsProps {
  trackId: string | null;
  title?: string | undefined;
  /** The EDIT tab's one-row form. */
  compact?: boolean;
}

export function PrepTools({ trackId, title, compact = false }: PrepToolsProps) {
  const { busy, runs, run, stop, undo, error } = usePrep(trackId);
  const [bars, setBars] = useState(8);
  const [repeats, setRepeats] = useState(2);
  const [loopBars, setLoopBars] = useState(8);
  const options = (tool: PrepTool): PrepOptions =>
    tool === "extend-intro" || tool === "extend-outro" ? { bars, repeats } : tool === "cues" ? { loopBars } : {};
  const disabled = trackId === null || busy !== null;
  const latest = runs[0];

  const button = (tool: ToolSpec) => (
    <button
      key={tool.id}
      type="button"
      className={styles.tool}
      data-busy={busy?.tool === tool.id || undefined}
      disabled={disabled}
      title={tool.hint + (tool.slow ? " (splits stems first: can take a few minutes)" : "")}
      onClick={() => { void run(tool.id, options(tool.id)); }}
    >
      <span className={styles.toolLabel}>{busy?.tool === tool.id ? "WORKING…" : tool.label}</span>
      {compact ? null : <span className={styles.toolHint}>{tool.hint}</span>}
    </button>
  );

  if (compact) {
    return (
      <div className={styles.compact} aria-label="Prep tools">
        <section className={styles.compactGroup}>
          <span className={styles.groupLabel}>PREP</span>
          <div className={styles.compactButtons}>{PREP_TOOLS.map(button)}</div>
        </section>
        <div className={styles.compactActions}>
          {busy ? (
            <button type="button" className={styles.stop} onClick={() => { void stop(); }}>STOP</button>
          ) : canUndo(latest) ? (
            <button type="button" className={styles.undo} title="Undo this run: its cues are removed and its files go to the Trash" onClick={() => { void undo(latest.id); }}>UNDO</button>
          ) : null}
        </div>
        <div className={styles.compactStatus} aria-live="polite">
          {trackId === null ? "Load a track to prep it." :
            error ? <span className={styles.error}>{error}</span> :
            busy ? `${PREP_TOOLS.find((t) => t.id === busy.tool)?.label ?? ""} running…` :
            latest ? describe(latest) :
            "Every tool writes a new file; the track stays as it is."}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} aria-label="Editor">
      <header className={styles.header}>
        <span className={styles.title}>EDITOR</span>
        <span className={styles.track}>{trackId === null ? "Load a track into the deck to prep it." : title}</span>
        {busy ? (
          <button type="button" className={styles.stop} onClick={() => { void stop(); }}>
            STOP {PREP_TOOLS.find((t) => t.id === busy.tool)?.label}
          </button>
        ) : null}
      </header>
      <div className={styles.groups}>
        {GROUPS.map((group) => (
          <section key={group} className={styles.group}>
            <span className={styles.groupLabel}>{group}</span>
            <div className={styles.buttons}>{PREP_TOOLS.filter((t) => t.group === group).map(button)}</div>
            {group === "CUES" ? (
              <label className={styles.option}>
                LOOP
                <select value={loopBars} onChange={(e) => setLoopBars(Number(e.target.value))}>
                  {[4, 8, 16].map((n) => <option key={n} value={n}>{n} bars</option>)}
                </select>
              </label>
            ) : null}
            {group === "EDIT" ? (
              <div className={styles.options}>
                <label className={styles.option}>
                  BARS
                  <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
                    {[4, 8, 16].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label className={styles.option}>
                  ×
                  <select value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <span className={styles.adds}>+{bars * repeats} bars</span>
              </div>
            ) : null}
          </section>
        ))}
      </div>
      <ol className={styles.log} aria-label="Results" aria-live="polite">
        {runs.length === 0 ? (
          <li className={styles.empty}>Results show here. Every tool writes a new file next to the track; the track itself is never changed.</li>
        ) : runs.map((entry) => (
          <li key={entry.id} className={styles.entry} data-undone={entry.undone || undefined}>
            <span className={styles.entryTool}>{PREP_TOOLS.find((t) => t.id === entry.tool)?.label}</span>
            <span className={styles.entryText}>
              {entry.error ? <span className={styles.error}>{entry.error}</span> : describe(entry)}
              {entry.undone ? null : entry.result?.files.map((f) => <span key={f} className={styles.file}>{fileName(f)}</span>)}
            </span>
            {canUndo(entry) ? (
              <button type="button" className={styles.undo} title="Undo this run: its cues are removed and its files go to the Trash" onClick={() => { void undo(entry.id); }}>UNDO</button>
            ) : null}
          </li>
        ))}
        {error ? <li className={styles.entry}><span className={styles.entryTool}>UNDO</span><span className={styles.error}>{error}</span></li> : null}
      </ol>
    </div>
  );
}
