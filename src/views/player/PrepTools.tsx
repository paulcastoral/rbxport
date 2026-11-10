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
  { id: "cues", label: "AUTO CUES", hint: "Loop + red cue at the vocal", group: "CUES", slow: true },
  { id: "extend-intro", label: "EXT INTRO", hint: "Loop clean intro bars", group: "EDIT", slow: true },
  { id: "extend-outro", label: "EXT OUTRO", hint: "Loop clean outro bars", group: "EDIT", slow: true },
  { id: "instrumental", label: "INSTRUMENTAL", hint: "Vocals removed", group: "STEMS", slow: true },
  { id: "acapella", label: "ACAPELLA", hint: "Vocals only", group: "STEMS", slow: true },
];

const GROUPS = ["GRID", "CUES", "EDIT", "STEMS"] as const;

interface Run {
  tool: PrepTool;
  result?: PrepResult;
  error?: string;
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error).message);
  return "The tool failed.";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** One deck's prep state: what is running and what has run on its track. */
export function usePrep(trackId: string | null) {
  const [busy, setBusy] = useState<PrepTool | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  // A new track starts a new history.
  useEffect(() => { setRuns([]); setBusy(null); }, [trackId]);
  const run = useCallback(async (tool: PrepTool, options?: PrepOptions) => {
    if (!trackId || busy) return;
    setBusy(tool);
    try {
      const result = await (await getBackend()).prep(trackId, tool, options);
      setRuns((was) => [{ tool, result }, ...was]);
    } catch (error) {
      setRuns((was) => [{ tool, error: message(error) }, ...was]);
    } finally {
      setBusy(null);
    }
  }, [trackId, busy]);
  return { busy, runs, run };
}

export interface PrepToolsProps {
  trackId: string | null;
  title?: string | undefined;
  /** The EDIT tab's one-row form. */
  compact?: boolean;
}

export function PrepTools({ trackId, title, compact = false }: PrepToolsProps) {
  const { busy, runs, run } = usePrep(trackId);
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
      data-busy={busy === tool.id || undefined}
      disabled={disabled}
      title={tool.hint + (tool.slow ? " (splits stems first: can take a few minutes)" : "")}
      onClick={() => { void run(tool.id, options(tool.id)); }}
    >
      <span className={styles.toolLabel}>{busy === tool.id ? "WORKING…" : tool.label}</span>
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
        <div className={styles.compactStatus} aria-live="polite">
          {trackId === null ? "Load a track to prep it." :
            latest ? (latest.error ? <span className={styles.error}>{latest.error}</span> : latest.result?.summary) :
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
        ) : runs.map((entry, at) => (
          <li key={runs.length - at} className={styles.entry}>
            <span className={styles.entryTool}>{PREP_TOOLS.find((t) => t.id === entry.tool)?.label}</span>
            {entry.error ? <span className={styles.error}>{entry.error}</span> : (
              <span>
                {entry.result?.summary}
                {entry.result?.files.map((f) => <span key={f} className={styles.file}>{fileName(f)}</span>)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
