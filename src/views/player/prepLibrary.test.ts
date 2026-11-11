// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { Cue, ImportReport, PrepResult } from "@/ipc/types";
import { ANALYSE_EVENT, addToLibrary, mapTime, placeAfter } from "./prepLibrary";

describe("placeAfter", () => {
  it("puts the new version right after the original", () => {
    expect(placeAfter(["a", "orig", "b"], "orig", "new")).toEqual(["a", "orig", "new", "b"]);
  });
  it("moves a version the add appended to the end", () => {
    expect(placeAfter(["orig", "b", "new"], "orig", "new")).toEqual(["orig", "new", "b"]);
  });
  it("goes to the end when the original is not there", () => {
    expect(placeAfter(["a", "b"], "orig", "new")).toEqual(["a", "b", "new"]);
  });
});

describe("mapTime", () => {
  it("shifts cues after the inserted bars of an extension, not before", () => {
    const details = { inserted_at_s: 30, added_s: 31.7 };
    expect(mapTime("extend-intro", details, 10_000)).toBe(10_000);
    expect(mapTime("extend-intro", details, 95_800)).toBe(127_500);
  });
  it("follows the time map through a tighten", () => {
    const details = { timemap: [[1, 1], [2, 2.5], [3, 3]] };
    expect(mapTime("tighten", details, 1500)).toBe(1750);
    expect(mapTime("tighten", details, 500)).toBe(500);
    expect(mapTime("tighten", details, 4000)).toBe(4000);
  });
  it("keeps stems on the original timeline", () => {
    expect(mapTime("instrumental", {}, 12_345)).toBe(12_345);
  });
});

describe("addToLibrary", () => {
  const cue = (over: Partial<Cue>): Cue => ({ id: "c", positionMs: 0, outMs: 0, letter: "", memory: false, colour: null, ...over });

  function fakeBackend() {
    const edits = {
      setTrackField: vi.fn(() => Promise.resolve(({}))),
      setTrackRating: vi.fn(() => Promise.resolve(({}))),
      setTrackColor: vi.fn(() => Promise.resolve(({}))),
      setTrackComment: vi.fn(() => Promise.resolve(({}))),
      addTracksToPlaylist: vi.fn(() => Promise.resolve(({ generation: 1, added: 1 }))),
      reorderPlaylist: vi.fn(() => Promise.resolve(1)),
      addCue: vi.fn(() => Promise.resolve("cue-new")),
      addLoop: vi.fn(() => Promise.resolve("loop-new")),
      setCueColour: vi.fn(() => Promise.resolve(undefined)),
      setCueComment: vi.fn(() => Promise.resolve(undefined)),
    };
    const backend = {
      importPaths: vi.fn(() => Promise.resolve<ImportReport>({ imported: 1, skipped: [], tracks: [{ id: "new", title: "x" }], existing: [] })),
      trackDetails: vi.fn(() => Promise.resolve({
        title: "Jingo", artist: "Candido", album: "Thousand Finger Man", genre: "Disco", label: "Salsoul",
        remixer: "", composer: "", originalArtist: "", key: "Am", rating: 4, color: "2", comment: "",
      })),
      trackCues: vi.fn((id: string) => Promise.resolve(id === "orig"
        ? [cue({ letter: "A", positionMs: 95_800, colour: "#E02823", comment: "Vocal" }), cue({ memory: true, positionMs: 78_000, outMs: 94_000 })]
        : [])),
      prepPlacements: vi.fn(() => Promise.resolve([{ playlist: "pl1", tracks: ["a", "orig", "b"] }])),
      edits,
    };
    return { backend, edits };
  }

  it("imports, names, places, copies cues and queues analysis", async () => {
    const { backend, edits } = fakeBackend();
    const queued = vi.fn();
    window.addEventListener(ANALYSE_EVENT, queued);
    const result: PrepResult = {
      tool: "extend-intro", summary: "", files: ["/m/rbx-prep/Jingo (Extended Intro).wav"],
      details: { inserted_at_s: 30, added_s: 31.7 },
    };
    const out = await addToLibrary(backend as never, "orig", "extend-intro", result);
    window.removeEventListener(ANALYSE_EVENT, queued);

    expect(out.added).toEqual(["new"]);
    expect(edits.setTrackField).toHaveBeenCalledWith(["new"], "title", "Jingo (Extended Intro)");
    expect(edits.setTrackField).toHaveBeenCalledWith(["new"], "artist", "Candido");
    expect(edits.setTrackRating).toHaveBeenCalledWith(["new"], 4);
    expect(edits.reorderPlaylist).toHaveBeenCalledWith("pl1", ["a", "orig", "new", "b"]);
    // The hot cue moves by the added bars; the loop starts after them too.
    expect(edits.addCue).toHaveBeenCalledWith("new", { hot: "A" }, 127_500);
    expect(edits.setCueColour).toHaveBeenCalledWith("cue-new", 41);
    expect(edits.addLoop).toHaveBeenCalledWith("new", "memory", 109_700, 125_700);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(out.note).toContain("under the original in 1 playlist");
    expect(out.note).toContain("2 cues copied");
  });

  it("says why when the import takes nothing", async () => {
    const { backend } = fakeBackend();
    backend.importPaths.mockResolvedValueOnce({ imported: 0, skipped: ["x.wav: unreadable"], tracks: [], existing: [] });
    const out = await addToLibrary(backend as never, "orig", "instrumental", {
      tool: "instrumental", summary: "", files: ["/m/rbx-prep/x.wav"], details: {},
    });
    expect(out.trackIds).toEqual([]);
    expect(out.note).toContain("x.wav: unreadable");
  });
});
