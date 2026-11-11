/**
 * Puts a prep tool's new file into the library beside the track it came from:
 * imported, named after the original, its details copied, placed right
 * below the original in every ordinary playlist that holds it, its cues
 * copied to where they fall in the new audio, and queued for analysis.
 *
 * Every step goes through the same backend edits the rest of the app uses.
 * A step that fails is reported in the note and the rest still run: a track
 * in the library with no rating is better than no track.
 */
import type { Backend, Cue, PrepResult, PrepTool } from "@/ipc/types";
import { MEMORY_CUE_COLOURS } from "@/lib/memoryCueColours";
import { HOT, HOT_CSS } from "./CueColorMenu";

/** What each tool's version is called, after the original title. */
export const VERSION_NAME: Partial<Record<PrepTool, string>> = {
  // A warped version is marked short, the way DJs tag edits: "Jingo (w)".
  tighten: "w",
  "extend-intro": "Extended Intro",
  "extend-outro": "Extended Outro",
  instrumental: "Instrumental",
  acapella: "Acapella",
};

/** Asks the app to analyse new tracks with the user's analysis settings. */
export const ANALYSE_EVENT = "gridbin:analyse";

export interface LibraryAdd {
  /** The tracks added (or found already there), for Undo. */
  trackIds: string[];
  /** Tracks this run added itself, which Undo removes from the collection. */
  added: string[];
  /** One line on what happened, for the result. */
  note: string;
}

type Prep = Pick<Backend, "importPaths" | "trackDetails" | "trackCues" | "prepPlacements" | "edits">;

/** A cue's time in the new file, or null when it falls outside it. */
export function mapTime(tool: PrepTool, details: Record<string, unknown>, ms: number): number {
  if (tool === "extend-intro" || tool === "extend-outro") {
    const at = Number(details.inserted_at_s ?? Infinity) * 1000;
    const added = Number(details.added_s ?? 0) * 1000;
    return ms >= at ? ms + added : ms;
  }
  if (tool === "tighten" && Array.isArray(details.timemap)) {
    const map = details.timemap as [number, number][];
    const first = map[0];
    const last = map[map.length - 1];
    if (!first || !last) return ms;
    const s = ms / 1000;
    // Before the first beat or after the last: keep the nearest beat's offset.
    if (s <= first[0]) return Math.round((s + first[1] - first[0]) * 1000);
    if (s >= last[0]) return Math.round((s + last[1] - last[0]) * 1000);
    let lo = 0;
    let hi = map.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((map[mid]?.[0] ?? Infinity) <= s) lo = mid; else hi = mid;
    }
    const [a0, b0] = map[lo] ?? first;
    const [a1, b1] = map[hi] ?? last;
    return Math.round((b0 + ((s - a0) / (a1 - a0)) * (b1 - b0)) * 1000);
  }
  return ms; // instrumental, acapella: the same timeline
}

/** The colour index `setCueColour` takes for a cue's drawn colour, or null. */
function colourIndex(cue: Cue): number | null {
  const hex = cue.colour?.toUpperCase();
  if (!hex) return null;
  if (cue.memory) {
    const at = MEMORY_CUE_COLOURS.findIndex(([, c]) => c === hex);
    return at < 0 ? null : at;
  }
  const at = HOT_CSS.findIndex((c) => c === hex);
  return at < 0 ? null : HOT[at] ?? null;
}

async function copyCues(backend: Prep, from: string, to: string, tool: PrepTool, details: Record<string, unknown>): Promise<number> {
  const cues = await backend.trackCues(from);
  const there = await backend.trackCues(to);
  let copied = 0;
  for (const cue of cues) {
    const at = mapTime(tool, details, cue.positionMs);
    if (at < 0) continue;
    if (there.some((c) => c.memory === cue.memory && c.letter === cue.letter && Math.abs(c.positionMs - at) <= 60)) continue;
    const kind = cue.letter ? { hot: cue.letter } : "memory" as const;
    const id = cue.outMs > 0
      ? await backend.edits.addLoop(to, kind, at, mapTime(tool, details, cue.outMs))
      : await backend.edits.addCue(to, kind, at);
    const colour = colourIndex(cue);
    if (colour !== null) await backend.edits.setCueColour(id, colour);
    if (cue.comment) await backend.edits.setCueComment(id, cue.comment);
    copied++;
  }
  return copied;
}

/**
 * A playlist's order with `added` moved to right after the last `original`,
 * or to the end when the original is not in it. Not a view's list: the order
 * `reorderPlaylist` writes back.
 */
export function placeAfter(tracks: readonly string[], original: string, added: string): string[] {
  const order: string[] = [];
  for (const t of tracks) if (t !== added) order.push(t);
  const after = order.lastIndexOf(original);
  order.splice(after < 0 ? order.length : after + 1, 0, added);
  return order;
}

/** Puts `result`'s files in the library beside `original`. */
export async function addToLibrary(backend: Prep, original: string, tool: PrepTool, result: PrepResult): Promise<LibraryAdd> {
  const name = VERSION_NAME[tool];
  if (!name || result.files.length === 0) return { trackIds: [], added: [], note: "" };
  const report = await backend.importPaths(result.files);
  const added = report.tracks.map((t) => t.id);
  const trackIds = [...added, ...report.existing.map((t) => t.id)];
  if (trackIds.length === 0) {
    return { trackIds, added, note: `Not added to the library: ${report.skipped.join("; ") || "the import took nothing"}.` };
  }
  const problems: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try { await step(); } catch { problems.push(what); }
  };

  const info = await backend.trackDetails(original);
  let placed = 0;
  let cues = 0;
  for (const id of added) {
    await attempt("title", () => backend.edits.setTrackField([id], "title", `${info.title} (${name})`));
    for (const field of ["artist", "album", "genre", "label", "remixer", "composer", "originalArtist"] as const) {
      if (info[field]) await attempt(field, () => backend.edits.setTrackField([id], field, info[field]));
    }
    // Same key for every tool: tighten stretches time, not pitch.
    if (info.key) await attempt("key", () => backend.edits.setTrackField([id], "key", info.key));
    if (info.rating > 0) await attempt("rating", () => backend.edits.setTrackRating([id], info.rating));
    if (info.color && info.color !== "0") await attempt("colour", () => backend.edits.setTrackColor([id], info.color));
    if (info.comment) await attempt("comment", () => backend.edits.setTrackComment([id], info.comment));

    await attempt("playlists", async () => {
      for (const { playlist, tracks } of await backend.prepPlacements(original)) {
        await backend.edits.addTracksToPlaylist(playlist, [id]);
        const order = placeAfter(tracks, original, id);
        await backend.edits.reorderPlaylist(playlist, order);
        placed++;
      }
    });
    await attempt("cues", async () => { cues += await copyCues(backend, original, id, tool, result.details); });
  }

  if (added.length) {
    window.dispatchEvent(new CustomEvent(ANALYSE_EVENT, {
      detail: added.map((id) => ({ id, title: `${info.title} (${name})` })),
    }));
  }

  const parts = [added.length ? "Added to the library" : "Already in the library"];
  if (placed) parts.push(`under the original in ${placed} playlist${placed === 1 ? "" : "s"}`);
  if (cues) parts.push(`${cues} cue${cues === 1 ? "" : "s"} copied`);
  const note = `${parts.join(", ")}.${problems.length ? ` Couldn't copy: ${problems.join(", ")}.` : ""}`;
  return { trackIds, added, note };
}
