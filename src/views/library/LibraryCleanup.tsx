/**
 * GridBin's Library Cleanup (File › Library Cleanup…): missing files and
 * duplicates in one window.
 *
 * Missing files: how many tracks point at a file that isn't there, with
 * Relocate (rekordbox's Missing File Manager, for files that only moved)
 * and Remove all. Duplicates: tracks sharing a title and artist, each group
 * with a suggested copy to keep (see `lib/cleanup.ts`) that the user can
 * change; Remove extras hands every playlist of a removed copy to the kept
 * one, then takes the extras out of the collection. Files on disk are never
 * deleted: both actions only change the library, and both ask first.
 */
import { useCallback, useEffect, useState } from "react";

import { getBackend } from "@/ipc/client";
import type { DuplicateGroup } from "@/ipc/types";
import { formatLabel, handOver, keepReason, rankCopies, type Copy } from "@/lib/cleanup";
import styles from "./LibraryCleanup.module.css";

/** Groups listed at once; the rest show up after a cleanup. */
const GROUPS = 128;

interface Group {
  title: string;
  artist: string;
  copies: Copy[];
  keep: string;
  reason: string;
}

export interface LibraryCleanupProps {
  readOnly: boolean;
  /** Opens rekordbox's Missing File Manager, to relocate rather than remove. */
  onRelocate: () => void;
  onWrote: (said: string) => void;
  onFailed: (message: string) => void;
  onClose: () => void;
}

function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : path;
}

async function withCues(group: DuplicateGroup): Promise<Group> {
  const backend = await getBackend();
  const copies: Copy[] = [];
  for (const t of group.tracks) {
    let cues = 0;
    try { cues = (await backend.trackCues(t.id)).length; } catch { /* counted as none */ }
    copies.push({ ...t, cues });
  }
  const ranked = rankCopies(copies);
  const best = ranked[0];
  return {
    title: group.title,
    artist: group.artist,
    copies,
    keep: best?.id ?? "",
    reason: best ? keepReason(best, ranked.slice(1)) : "",
  };
}

export function LibraryCleanup({ readOnly, onRelocate, onWrote, onFailed, onClose }: LibraryCleanupProps) {
  const [missing, setMissing] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [totals, setTotals] = useState({ groups: 0, extra: 0 });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const backend = await getBackend();
    setMissing(null);
    setGroups(null);
    const lost = await backend.missingTracks(0, 1, true);
    setMissing(lost.total);
    const found = await backend.findDuplicates(GROUPS);
    setTotals({ groups: found.groups, extra: found.extra });
    const out: Group[] = [];
    for (const g of found.shown) out.push(await withCues(g));
    setGroups(out);
  }, []);

  useEffect(() => {
    load().catch((e: unknown) => onFailed(String((e as { message?: string }).message ?? e)));
  }, [load, onFailed]);

  const removeMissing = async () => {
    if (!missing) return;
    const backend = await getBackend();
    const sure = await backend.confirm(
      `Remove ${missing} missing track${missing === 1 ? "" : "s"} from the library? They leave every playlist. Nothing on disk is deleted.`,
      { yes: "Remove", no: "Cancel", title: "Remove missing files" },
    );
    if (!sure) return;
    setBusy(true);
    try {
      const n = await backend.removeMissingTracks(null);
      onWrote(`Removed ${n} missing track${n === 1 ? "" : "s"} from the library.`);
      await load();
    } catch (e) {
      onFailed(String((e as { message?: string }).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const removeExtras = async () => {
    if (!groups?.length) return;
    const extras = groups.reduce((n, g) => n + g.copies.length - 1, 0);
    const backend = await getBackend();
    const sure = await backend.confirm(
      `Remove ${extras} duplicate cop${extras === 1 ? "y" : "ies"} from the library, keeping the one marked in each group? `
        + "Each removed copy's playlists get the kept copy in its place. Nothing on disk is deleted.",
      { yes: "Remove extras", no: "Cancel", title: "Remove duplicates" },
    );
    if (!sure) return;
    setBusy(true);
    let removed = 0;
    try {
      for (const g of groups) {
        const gone = g.copies.filter((c) => c.id !== g.keep).map((c) => c.id);
        for (const id of gone) {
          for (const { playlist, tracks } of await backend.prepPlacements(id)) {
            // The kept copy joins the playlist, then takes the removed copy's
            // place in it; the order is worked out from the list before the add.
            if (!tracks.includes(g.keep)) await backend.edits.addTracksToPlaylist(playlist, [g.keep]);
            await backend.edits.reorderPlaylist(playlist, handOver(tracks, id, g.keep));
          }
        }
        if (gone.length) removed += await backend.edits.removeFromCollection(gone);
      }
      onWrote(`Removed ${removed} duplicate cop${removed === 1 ? "y" : "ies"}; their playlists now hold the copy kept.`);
      await load();
    } catch (e) {
      onFailed(String((e as { message?: string }).message ?? e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const shownExtra = groups?.reduce((n, g) => n + g.copies.length - 1, 0) ?? 0;

  return (
    <div className={styles.scrim} role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={styles.dialog} role="dialog" aria-label="Library Cleanup">
        <header className={styles.header}>
          <span className={styles.title}>LIBRARY CLEANUP</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>MISSING FILES</span>
          <div className={styles.row}>
            <span className={styles.summary}>
              {missing === null ? "Checking…" : missing === 0 ? "Every track's file is where the library says." :
                `${missing} track${missing === 1 ? " points" : "s point"} at a file that isn't there.`}
            </span>
            <button type="button" className={styles.button} disabled={!missing || busy} onClick={onRelocate}
              title="Find files that moved: rekordbox's Missing File Manager">RELOCATE…</button>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={!missing || busy || readOnly}
              onClick={() => { void removeMissing(); }}>REMOVE ALL</button>
          </div>
        </div>

        <div className={`${styles.section} ${styles.grow}`}>
          <span className={styles.sectionTitle}>DUPLICATES</span>
          <div className={styles.row}>
            <span className={styles.summary}>
              {groups === null ? "Looking for tracks that share a title and artist…" : totals.groups === 0 ? "No duplicates." :
                `${totals.groups} group${totals.groups === 1 ? "" : "s"}, ${totals.extra} extra cop${totals.extra === 1 ? "y" : "ies"}`
                + (totals.groups > (groups.length) ? ` (first ${groups.length} shown)` : "")
                + ". The copy to keep is marked; click another to keep it instead."}
            </span>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={!shownExtra || busy || readOnly}
              onClick={() => { void removeExtras(); }}>REMOVE {shownExtra || ""} EXTRAS</button>
          </div>
          <ol className={styles.groups}>
            {groups?.map((g, gi) => (
              <li key={`${g.title}-${g.artist}-${gi}`} className={styles.group}>
                <div className={styles.groupName}>{g.artist ? `${g.artist} – ` : ""}{g.title}</div>
                {g.copies.map((c) => {
                  const keep = c.id === g.keep;
                  return (
                    <label key={c.id} className={styles.copy} data-keep={keep || undefined} data-missing={!c.present || undefined}>
                      <input type="radio" name={`keep-${gi}`} checked={keep} disabled={busy}
                        onChange={() => setGroups((was) => was?.map((x, xi) => (xi === gi ? { ...x, keep: c.id, reason: "your choice" } : x)) ?? was)} />
                      <span className={styles.badge}>{keep ? "KEEP" : "REMOVE"}</span>
                      <span className={styles.path} title={c.path}>{folderOf(c.path)}</span>
                      <span className={styles.meta}>
                        {c.present ? formatLabel(c) : "file missing"} · {c.cues} cue{c.cues === 1 ? "" : "s"} · {c.playlists} playlist{c.playlists === 1 ? "" : "s"}
                        {c.analysed ? "" : " · not analysed"}
                      </span>
                      {keep ? <span className={styles.reason}>{g.reason}</span> : null}
                    </label>
                  );
                })}
              </li>
            ))}
          </ol>
        </div>
        <footer className={styles.footer}>Nothing on disk is deleted: removing only takes tracks out of the library.</footer>
      </section>
    </div>
  );
}
