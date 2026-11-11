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
import { loadCueOptions, saveCueOptions, LOOP_CHOICES, SNAP_CHOICES, type CueOptions } from "./cueOptions";
import { useCallback, useEffect, useState } from "react";

import { getBackend } from "@/ipc/client";
import type { PrepOptions, PrepResult, PrepTool } from "@/ipc/types";
import { addToLibrary } from "./prepLibrary";
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
  { id: "drift", label: "CHECK DRIFT", hint: "Steady or drifting", group: "GRID" },
  { id: "tighten", label: "WARP", hint: "Lock to a fixed BPM", group: "GRID" },
  { id: "cues", label: "AUTO CUES", hint: "Loop + red cue", group: "CUES", slow: true },
  { id: "extend-intro", label: "EXT INTRO", hint: "Loop intro bars", group: "EDIT", slow: true },
  { id: "extend-outro", label: "EXT OUTRO", hint: "Loop outro bars", group: "EDIT", slow: true },
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
  /** The new version's track in the library, for Show in Finder. */
  libraryIds?: string[];
  /** Tracks this run added to the collection, which Undo takes out again. */
  addedIds?: string[];
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
  if (entry.undone) return entry.cueIds?.length ? "Undone: its cues were removed." : entry.addedIds?.length ? "Undone: removed from the library, its files are in the Trash." : "Undone: its files are in the Trash.";
  return entry.result?.summary ?? "";
}

/** rekordbox's hot-cue red, as the CUE colour menu offers it (ColorTableIndex 41). */
const HOT_CUE_RED = 41;
/** A cue this close to one already on the track is taken to be the same cue. */
const SAME_CUE_MS = 60;

interface CuePlan {
  hot_cue?: { s: number };
  memory_loop?: { start_s: number; end_s: number; bars?: number };
  exit_loop?: { start_s: number; end_s: number; bars?: number };
}

/**
 * Puts AUTO CUES' answer on the track: a red hot cue named "Vocal" on the
 * first held vocal, in pad A or the first free pad, a memory loop named
 * "Mix in" over the bars before it, and one named "Mix out" after the last
 * vocal when asked for. A cue already there at the same spot is
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
  const loop = async (spot: { start_s: number; end_s: number; bars?: number }, fallback: number, name: string, what: string) => {
    const inMs = Math.round(spot.start_s * 1000);
    const outMs = Math.round(spot.end_s * 1000);
    if (near(inMs, true)) {
      notes.push(`${what} already there`);
      return;
    }
    // The tool shortens a loop that has no room for its full length.
    const bars = spot.bars ?? fallback;
    const id = await backend.edits.addLoop(trackId, "memory", inMs, outMs, bars * 4);
    ids.push(id);
    await backend.edits.setCueComment(id, name);
    notes.push(`${bars}-bar ${what}`);
  };
  if (plan.memory_loop) await loop(plan.memory_loop, loopBars, "Mix in", "mix-in loop");
  if (plan.exit_loop) await loop(plan.exit_loop, loopBars, "Mix out", "exit loop");
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
          const placed = await placeCues(trackId, result.details, options?.loopBars ?? 4);
          const summary = placed.note ? `${result.summary} ${placed.note}` : result.summary;
          setRuns((was) => [{ id, tool, result: { ...result, summary }, cueIds: placed.ids }, ...was]);
        } catch (failure) {
          setRuns((was) => [{ id, tool, error: `Found the cues but could not place them: ${message(failure)}` }, ...was]);
        }
        return;
      }
      if (result.files.length > 0) {
        // The new version goes in the library next to the original.
        try {
          const lib = await addToLibrary(await getBackend(), trackId, tool, result);
          const summary = lib.note ? `${result.summary} ${lib.note}` : result.summary;
          setRuns((was) => [{ id, tool, result: { ...result, summary }, libraryIds: lib.trackIds, addedIds: lib.added }, ...was]);
        } catch (failure) {
          const summary = `${result.summary} Not added to the library: ${message(failure)}`;
          setRuns((was) => [{ id, tool, result: { ...result, summary } }, ...was]);
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
      // Out of the library first, so no row points at a file in the Trash.
      if (entry.addedIds?.length) await backend.edits.removeFromCollection(entry.addedIds);
      if (files.length) await backend.prepUndo(files);
      for (const cue of cueIds) await backend.edits.deleteCue(cue);
      setRuns((was) => was.map((r) => (r.id === id ? { ...r, undone: true } : r)));
    } catch (failure) {
      setError(message(failure));
    }
  }, [runs]);

  const reveal = useCallback(async (trackIdToShow: string) => {
    try {
      await (await getBackend()).revealTrack(trackIdToShow);
    } catch (failure) {
      setError(message(failure));
    }
  }, []);

  return { busy, runs, run, stop, undo, reveal, error };
}

export interface PrepToolsProps {
  trackId: string | null;
  title?: string | undefined;
  /** The EDIT tab's one-row form. */
  compact?: boolean;
}

export function PrepTools({ trackId, title, compact = false }: PrepToolsProps) {
  const { busy, runs, run, stop, undo, reveal, error } = usePrep(trackId);
  const [bars, setBars] = useState(8);
  const [repeats, setRepeats] = useState(2);
  const [cueOptions, setCueOptions] = useState<CueOptions>(loadCueOptions);
  const setCue = (change: Partial<CueOptions>) => {
    setCueOptions((was) => {
      const next = { ...was, ...change };
      saveCueOptions(next);
      return next;
    });
  };
  // The EDIT tab has no room for these, so it uses what was last set here.
  const options = (tool: PrepTool): PrepOptions =>
    tool === "extend-intro" || tool === "extend-outro" ? { bars, repeats }
      : tool === "cues" ? (compact ? loadCueOptions() : cueOptions) : {};
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

  // A key's LED: blinking while its tool runs, lit once it has worked on
  // this track (and not been undone), dark otherwise.
  const done = new Set(runs.filter((r) => r.result && !r.undone).map((r) => r.tool));
  const key = (tool: ToolSpec) => {
    const running = busy?.tool === tool.id;
    return (
      <button
        key={tool.id}
        type="button"
        className={styles.key}
        aria-label={tool.label}
        disabled={disabled}
        title={tool.hint + (tool.slow ? " (splits stems first: can take a few minutes)" : "")}
        onClick={() => { void run(tool.id, options(tool.id)); }}
      >
        <span className={styles.caption}>{tool.label}</span>
        <span className={styles.face}>
          <span className={styles.led} data-state={running ? "busy" : done.has(tool.id) ? "on" : undefined} />
        </span>
        <span className={styles.hint}>{running ? "Working…" : tool.hint}</span>
      </button>
    );
  };

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
        <span className={styles.rule} aria-hidden />
        <span className={styles.title}>EDITOR</span>
        <span className={`${styles.rule} ${styles.ruleFill}`} aria-hidden />
        <span className={styles.track}>{trackId === null ? "Load a track into the deck to prep it." : title}</span>
        {busy ? (
          <button type="button" className={styles.stop} onClick={() => { void stop(); }}>
            STOP {PREP_TOOLS.find((t) => t.id === busy.tool)?.label}
          </button>
        ) : null}
      </header>
      <div className={styles.groups}>
        {GROUPS.map((group) => (
          <section key={group} className={styles.group} aria-label={group}>
            <span className={styles.groupTitle}>{group}</span>
            <div className={styles.keys}>{PREP_TOOLS.filter((t) => t.group === group).map(key)}</div>
            {group === "CUES" ? (
              <div className={styles.options}>
                <label className={styles.option} title="Memory loop over the bars before the vocal">
                  MIX IN
                  <select value={cueOptions.loopBars} onChange={(e) => setCue({ loopBars: Number(e.target.value) })}>
                    {LOOP_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? "OFF" : n}</option>)}
                  </select>
                </label>
                <label className={styles.option} title="Red cue on the beat nearest the vocal, on the exact spot it comes in, or on its bar">
                  VOCAL
                  <select value={cueOptions.cueSnap} onChange={(e) => setCue({ cueSnap: SNAP_CHOICES.find((c) => c === e.target.value) ?? "beat" })}>
                    {SNAP_CHOICES.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                  </select>
                </label>
                <label className={styles.option} title="Memory loop after the last vocal, to mix out on">
                  EXIT
                  <select value={cueOptions.exitBars} onChange={(e) => setCue({ exitBars: Number(e.target.value) })}>
                    {LOOP_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? "OFF" : n}</option>)}
                  </select>
                </label>
              </div>
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
                  REPEAT
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
            {entry.libraryIds?.[0] && !entry.undone ? (
              <button type="button" className={styles.undo} title="Show the new file in Finder" onClick={() => { const shown = entry.libraryIds?.[0]; if (shown) void reveal(shown); }}>SHOW</button>
            ) : null}
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
